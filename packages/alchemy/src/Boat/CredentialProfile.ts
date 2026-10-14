import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { reveal, type SecretInput } from "./secret.ts";

/** A credential a profile can hold as an API key. */
export type CredentialKeyId =
  | "anthropic-api-key"
  | "openai-api-key"
  | "openrouter-api-key"
  | "llmgateway-api-key"
  | "deepseek-api-key"
  | "moonshot-api-key"
  | "mistral-api-key"
  | (string & {});

export interface CustomApi {
  /** The secret. Sandboxes get it as the variable named by the map key. */
  value: SecretInput;
  /** Base URL, given to sandboxes as `<NAME>_BASE_URL`. */
  baseUrl: string;
}

export interface CredentialProfileProps {
  /**
   * Profile name. If omitted, a unique name is generated from the stack,
   * stage, and logical ID. Changing it renames the profile.
   */
  name?: string;
  /**
   * Organization that owns the profile, by id or name. Only its owners can
   * create it. Changing it replaces the profile.
   */
  org?: string;
  /**
   * Make this its owner's default profile, the one sandboxes get when their
   * environment names none. `false` leaves the default where it is.
   */
  isDefault?: boolean;
  /**
   * AI provider API keys, by credential id. Values are secrets: pass them as
   * `Redacted`. Boat never returns them, so a key is sent when it is missing
   * from the profile or its value changed since the last deploy. Keys this
   * resource set before and that are no longer listed are removed; sign-ins
   * connected on the dashboard are left alone.
   */
  keys?: Partial<Record<CredentialKeyId, SecretInput>>;
  /**
   * Custom APIs, keyed by the variable name sandboxes get (e.g.
   * `STRIPE_KEY`). Managed like `keys`.
   */
  customApis?: Record<string, CustomApi>;
}

export interface CredentialProfileAttributes {
  /** Profile id. */
  profileId: string;
  /** Profile name. */
  name: string;
  /** Whether this is its owner's default profile. */
  isDefault: boolean;
  /** The account or organization that owns the profile. */
  ownerId: string;
  /** The credentials the profile holds (ids only, never values). */
  connected: string[];
  /** Names of the profile's custom APIs (never values). */
  customApis: string[];
}

export type CredentialProfile = Resource<
  "Boat.CredentialProfile",
  CredentialProfileProps,
  CredentialProfileAttributes,
  never,
  Providers
>;

/**
 * A Boat credential profile: a named set of AI provider credentials and
 * custom APIs that sandboxes get through their {@link Environment}.
 *
 * Boat never returns secret values, so Alchemy only keeps credential ids
 * and custom API names in the resource's attributes. Managing profiles
 * needs an API key with `account.admin`.
 * @see https://docs.boat.dev/api/v1
 *
 * ### Creating a Profile
 * **Example:** Profile with AI provider keys
 * ```typescript
 * const profile = yield* Boat.CredentialProfile("Agents", {
 *   keys: {
 *     "anthropic-api-key": yield* Config.Redacted("ANTHROPIC_API_KEY"),
 *     "openai-api-key": yield* Config.Redacted("OPENAI_API_KEY"),
 *   },
 * });
 * ```
 *
 * **Example:** Profile with a custom API
 * ```typescript
 * const profile = yield* Boat.CredentialProfile("Billing", {
 *   customApis: {
 *     STRIPE_KEY: {
 *       value: yield* Config.Redacted("STRIPE_KEY"),
 *       baseUrl: "https://api.stripe.com",
 *     },
 *   },
 * });
 * ```
 *
 * ### Using a Profile
 * **Example:** Give an environment's sandboxes the profile
 * ```typescript
 * yield* Boat.Environment("Agents", { credentialProfileId: profile.profileId });
 * ```
 *
 * @resource
 * @product Credential Profile
 */
export const CredentialProfile = Resource<CredentialProfile>("Boat.CredentialProfile");

const profileName = (id: string, name: string | undefined) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, lowercase: true, maxLength: 64 });

const listProfiles = boat.listCredentialProfiles({}).pipe(Effect.map((res) => res.profiles));

const findProfile = (match: { id?: string; name: string }) =>
  listProfiles.pipe(
    Effect.map(
      (profiles) =>
        (match.id === undefined ? undefined : profiles.find((p) => p.id === match.id)) ??
        profiles.find((p) => p.name === match.name && p.canManage),
    ),
  );

const holds = (profile: boat.CredentialProfile, credential: string) =>
  (profile.connected as readonly string[]).includes(credential);

const toAttrs = (profile: boat.CredentialProfile): CredentialProfileAttributes => ({
  profileId: profile.id,
  name: profile.name,
  isDefault: profile.isDefault,
  ownerId: profile.owner.id,
  connected: [...profile.connected].sort(),
  customApis: [...profile.customApis].sort(),
});

/** Desired secrets as plain strings, keyed the way the profile reports them. */
const keyValues = (keys: CredentialProfileProps["keys"]) =>
  Object.fromEntries(
    Object.entries(keys ?? {}).flatMap(([id, value]) =>
      value === undefined ? [] : [[id, reveal(value)]],
    ),
  );

const customApiValues = (apis: CredentialProfileProps["customApis"]) =>
  Object.fromEntries(
    Object.entries(apis ?? {}).map(([name, api]) => [
      name,
      { value: reveal(api.value), baseUrl: api.baseUrl },
    ]),
  );

export const CredentialProfileProvider = () =>
  Provider.effect(
    CredentialProfile,
    Effect.gen(function* () {
      return {
        stables: ["profileId", "ownerId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.org !== olds?.org) return { action: "replace" } as const;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* profileName(id, olds?.name));
          const profile = yield* findProfile({ id: output?.profileId, name });
          if (!profile) return undefined;
          const attrs = toAttrs(profile);
          return output === undefined && olds?.name !== undefined ? Unowned(attrs) : attrs;
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const name = yield* profileName(id, news.name ?? output?.name);

          // Observe
          const observed = yield* findProfile({ id: output?.profileId, name });

          // Ensure
          let profile: boat.CredentialProfile;
          if (observed) {
            profile = observed;
          } else {
            yield* session.note(`Creating credential profile ${name}...`);
            profile = yield* boat.createCredentialProfile({ name, org: news.org }).pipe(
              Effect.map((res) => res.profile),
              Effect.catchTag("Conflict", () =>
                findProfile({ name }).pipe(
                  Effect.flatMap((found) =>
                    found
                      ? Effect.succeed(found)
                      : Effect.fail(new Error(`Boat credential profile ${name} already exists`)),
                  ),
                ),
              ),
            );
          }
          const profileId = profile.id;

          // Sync name and default flag.
          if (profile.name !== name || (news.isDefault === true && !profile.isDefault)) {
            yield* session.note(`Updating credential profile ${name}...`);
            profile = (yield* boat.updateCredentialProfile({
              profile: profileId,
              name: profile.name !== name ? name : undefined,
              isDefault: news.isDefault === true && !profile.isDefault ? true : undefined,
            })).profile;
          }

          // Sync keys. Values can't be observed, so a key is (re)sent when the
          // profile lacks it, when its value changed since the last deploy,
          // or when there is no last deploy to compare with (adoption).
          const desiredKeys = keyValues(news.keys);
          const oldKeys = olds ? keyValues(olds.keys) : undefined;
          for (const [credential, value] of Object.entries(desiredKeys)) {
            if (holds(profile, credential) && oldKeys?.[credential] === value) {
              continue;
            }
            yield* session.note(`Setting ${credential} on credential profile ${name}...`);
            profile = (yield* boat.setCredentialProfileKey({
              profile: profileId,
              credential,
              value,
            })).profile;
          }
          for (const credential of Object.keys(oldKeys ?? {})) {
            if (credential in desiredKeys || !holds(profile, credential)) continue;
            yield* session.note(`Removing ${credential} from credential profile ${name}...`);
            const current: boat.CredentialProfile = profile;
            profile = (yield* boat
              .deleteCredentialProfileKey({ profile: profileId, credential })
              .pipe(Effect.catchTag("NotFound", () => Effect.succeed({ profile: current }))))
              .profile;
          }

          // Sync custom APIs the same way.
          const desiredApis = customApiValues(news.customApis);
          const oldApis = olds ? customApiValues(olds.customApis) : undefined;
          for (const [apiName, api] of Object.entries(desiredApis)) {
            const old = oldApis?.[apiName];
            if (
              profile.customApis.includes(apiName) &&
              old?.value === api.value &&
              old.baseUrl === api.baseUrl
            ) {
              continue;
            }
            yield* session.note(`Setting custom API ${apiName} on credential profile ${name}...`);
            profile = (yield* boat.setCredentialProfileCustomApi({
              profile: profileId,
              name: apiName,
              value: api.value,
              baseUrl: api.baseUrl,
            })).profile;
          }
          for (const apiName of Object.keys(oldApis ?? {})) {
            if (apiName in desiredApis || !profile.customApis.includes(apiName)) continue;
            yield* session.note(
              `Removing custom API ${apiName} from credential profile ${name}...`,
            );
            const current: boat.CredentialProfile = profile;
            profile = (yield* boat
              .deleteCredentialProfileCustomApi({ profile: profileId, name: apiName })
              .pipe(Effect.catchTag("NotFound", () => Effect.succeed({ profile: current }))))
              .profile;
          }

          return toAttrs(profile);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* boat.deleteCredentialProfile({ profile: output.profileId }).pipe(
            Effect.asVoid,
            Effect.catchTag("NotFound", () => Effect.void),
            // An environment that named the profile may still be releasing it.
            Effect.retry({
              while: (e) => e._tag === "Conflict",
              schedule: Schedule.exponential("500 millis"),
              times: 6,
            }),
          );
        }),
        list: Effect.fn(function* () {
          return (yield* listProfiles)
            .filter((profile) => profile.canManage && !profile.isDefault)
            .map(toAttrs);
        }),
      };
    }),
  );
