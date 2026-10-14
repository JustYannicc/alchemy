import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { redact } from "./secret.ts";

/** A preset bundle of API key actions. */
export type ApiKeyPreset = "read-only" | "full-sandbox" | "ci" | "admin" | (string & {});

export interface ApiKeyProps {
  /**
   * Key name. If omitted, a unique name is generated from the stack, stage,
   * and logical ID. Changing it creates a new key.
   */
  name?: string;
  /**
   * Lifetime of the key, e.g. `"90d"`. Boat applies its default (90 days)
   * when omitted and caps it at its maximum (365 days). An expired key is
   * replaced on the next deploy. Changing it creates a new key.
   */
  ttl?: string;
  /** Preset bundle of actions. Changing it creates a new key. */
  preset?: ApiKeyPreset;
  /**
   * Individual actions the key may perform, e.g. `"sandbox.read"`. Changing
   * them creates a new key.
   */
  actions?: string[];
  /** Restrict the key to these sandboxes. Changing them creates a new key. */
  sandboxIds?: string[];
  /**
   * Restrict the key to these environments, by id (e.g. an
   * {@link Environment}'s `environmentId`). Changing them creates a new key.
   */
  environmentIds?: string[];
}

export interface ApiKeyAttributes {
  /** API key id, e.g. `sak_123`. */
  apiKeyId: string;
  /** Key name. */
  name: string;
  /** Visible prefix of the key, e.g. `boat_live`. */
  keyPrefix: string;
  /** Last four characters of the key. */
  keyLastFour: string;
  /** When the key expires (ISO 8601), if it does. */
  expiresAt: string | undefined;
  /** The actions the key may perform. */
  actions: string[];
  /** The raw key, sent as `Authorization: Bearer <secret>`. */
  secret: Redacted.Redacted<string>;
}

export type ApiKey = Resource<"Boat.ApiKey", ApiKeyProps, ApiKeyAttributes, never, Providers>;

/**
 * A scoped, expiring Boat API key. Hand one to a worker or CI job so it can
 * only do what it needs.
 *
 * Boat shows the key only once, so Alchemy keeps it in state as a
 * `Redacted` value. A key adopted without its secret, or whose secret was
 * lost, is rotated (same scope and expiry, new secret). Changing any prop
 * creates a new key, and destroying it revokes the key. Creating scoped keys
 * needs an unrestricted account key or one with the `admin` preset.
 * @see https://docs.boat.dev/api/v1
 *
 * ### Creating a Key
 * **Example:** Key for a CI job
 * ```typescript
 * const key = yield* Boat.ApiKey("Ci", { preset: "ci", ttl: "30d" });
 * ```
 *
 * **Example:** Key limited to one environment
 * ```typescript
 * const key = yield* Boat.ApiKey("Runner", {
 *   preset: "full-sandbox",
 *   environmentIds: [env.environmentId],
 * });
 * ```
 *
 * @resource
 * @product API Key
 */
export const ApiKey = Resource<ApiKey>("Boat.ApiKey");

const keyName = (id: string, name: string | undefined) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 64 });

const listKeys = boat.listApiKeys({}).pipe(Effect.map((res) => res.apiKeys));

const toAttrs = (key: boat.ApiKey, secret: Redacted.Redacted<string>): ApiKeyAttributes => ({
  apiKeyId: key.id,
  name: key.name,
  keyPrefix: key.keyPrefix,
  keyLastFour: key.keyLastFour,
  expiresAt: key.expiresAt ?? key.scope?.expiresAt ?? undefined,
  actions: [...(key.scope?.actions ?? [])],
  secret,
});

const revoke = (apiKeyId: string) =>
  boat.revokeApiKey({ apiKeyId }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );

export const ApiKeyProvider = () =>
  Provider.effect(
    ApiKey,
    Effect.gen(function* () {
      return {
        stables: ["apiKeyId", "name", "keyPrefix"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = output?.name ?? (yield* keyName(id, olds?.name));
          // Boat keys are immutable: any change mints a new one.
          if (
            (news.name !== undefined && news.name !== name) ||
            news.ttl !== olds?.ttl ||
            news.preset !== olds?.preset ||
            !deepEqual(news.actions, olds?.actions) ||
            !deepEqual(news.sandboxIds, olds?.sandboxIds) ||
            !deepEqual(news.environmentIds, olds?.environmentIds)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* keyName(id, olds?.name));
          const keys = yield* listKeys;
          // Boat lists keys only to unrestricted callers; a restricted
          // deploy key sees none and has to trust state.
          if (keys.length === 0) return output;
          const key =
            (output && keys.find((k) => k.id === output.apiKeyId)) ??
            keys.find((k) => k.name === name && k.sandboxId === null);
          if (!key) return undefined;
          if (output !== undefined && output.apiKeyId === key.id) {
            return toAttrs(key, output.secret);
          }
          const attrs = toAttrs(key, Redacted.make(""));
          return olds?.name !== undefined ? Unowned(attrs) : attrs;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* keyName(id, news.name ?? output?.name);

          // Observe
          const keys = yield* listKeys;
          if (keys.length === 0 && output && Redacted.value(output.secret) !== "") {
            // A restricted deploy key sees no inventory; keep the key we hold.
            return output;
          }
          let key =
            (output && keys.find((k) => k.id === output.apiKeyId)) ??
            keys.find((k) => k.name === name && k.sandboxId === null);
          let secret = output?.secret ?? Redacted.make("");

          // An expired key can't be rotated; revoke it and mint a new one.
          if (key?.expired) {
            yield* session.note(`API key ${name} expired, minting a new one...`);
            yield* revoke(key.id);
            key = undefined;
          }

          // Ensure
          if (!key) {
            yield* session.note(`Creating API key ${name}...`);
            const created = yield* boat.createScopedApiKey({
              name,
              ttl: news.ttl,
              preset: news.preset,
              actions: news.actions,
              sandboxIds: news.sandboxIds,
              environmentIds: news.environmentIds,
            });
            return toAttrs(created.apiKey, redact(created.secret));
          }

          // A key we hold no secret for (adopted, or a lost create) is
          // rotated: same scope and expiry, new secret.
          if (key.id !== output?.apiKeyId || Redacted.value(secret) === "") {
            yield* session.note(`Rotating API key ${name}...`);
            const rotated = yield* boat.rotateApiKey({ apiKeyId: key.id });
            key = rotated.apiKey;
            secret = redact(rotated.secret);
          }

          return toAttrs(key, secret);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* revoke(output.apiKeyId);
        }),
        // No `list`: account-wide teardown would revoke the key it runs with.
        nuke: { skip: true },
      };
    }),
  );
