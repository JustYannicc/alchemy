import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../AdoptPolicy.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { redact } from "./secret.ts";

/** A sandbox lifecycle event a webhook can subscribe to. */
export type WebhookEvent =
  | "sandbox.ready"
  | "sandbox.error"
  | "sandbox.archived"
  | "sandbox.hydrated"
  | "sandbox.degraded"
  | "sandbox.recovered"
  | (string & {});

export interface WebhookProps {
  /**
   * Webhook name. If omitted, a unique name is generated from the stack,
   * stage, and logical ID. Updated in place.
   */
  name?: string;
  /**
   * Public HTTPS endpoint on port 443 that receives the events. Redirects
   * are not followed. Updated in place.
   */
  url: string;
  /** Events delivered to the endpoint. Updated in place. */
  events: WebhookEvent[];
}

export interface WebhookAttributes {
  /** Webhook id, e.g. `wh_0123456789abcdef01234567`. */
  webhookId: string;
  /** Webhook name. */
  name: string;
  /** Endpoint URL. */
  url: string;
  /** Subscribed events. */
  events: string[];
  /**
   * Secret Boat signs every delivery with (`X-Ascii-Signature`, an
   * HMAC-SHA256 over `delivery_id.timestamp.raw_body`). Boat only reveals
   * it at creation or rotation.
   */
  signingSecret: Redacted.Redacted<string>;
}

export type Webhook = Resource<"Boat.Webhook", WebhookProps, WebhookAttributes, never, Providers>;

/**
 * An account-wide Boat webhook that receives sandbox lifecycle events.
 *
 * Boat shows the signing secret only once, so Alchemy keeps it in state as
 * a `Redacted` value. A webhook adopted without its secret has the secret
 * rotated so the stack can hand it to the receiver.
 * @see https://docs.boat.dev/api/v1
 *
 * ### Creating a Webhook
 * **Example:** Notify a Worker when sandboxes become ready or fail
 * ```typescript
 * const hook = yield* Boat.Webhook("Lifecycle", {
 *   url: "https://hooks.example.com/boat",
 *   events: ["sandbox.ready", "sandbox.error"],
 * });
 * ```
 *
 * ### Verifying deliveries
 * **Example:** Pass the signing secret to the receiver
 * ```typescript
 * const hook = yield* Boat.Webhook("Lifecycle", {
 *   url: worker.url.pipe(Output.map((url) => `${url}/boat`)),
 *   events: ["sandbox.archived"],
 * });
 * // hook.signingSecret is Redacted<string>
 * ```
 *
 * @resource
 * @product Webhook
 */
export const Webhook = Resource<Webhook>("Boat.Webhook");

const webhookName = (id: string, name: string | undefined) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 100 });

const observeById = (webhookId: string) =>
  boat.getWebhook({ webhookId }).pipe(
    Effect.map((res) => res.webhook),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const observeByName = (name: string) =>
  boat
    .listWebhooks({})
    .pipe(Effect.map((res) => res.webhooks.find((webhook) => webhook.name === name)));

const toAttrs = (
  webhook: boat.Webhook,
  signingSecret: Redacted.Redacted<string>,
): WebhookAttributes => ({
  webhookId: webhook.id,
  name: webhook.name ?? "",
  url: webhook.url,
  events: [...webhook.events],
  signingSecret,
});

const sameEvents = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((event) => b.includes(event));

export const WebhookProvider = () =>
  Provider.effect(
    Webhook,
    Effect.gen(function* () {
      return {
        stables: ["webhookId"],
        read: Effect.fn(function* ({ id, olds, output }) {
          const webhook = output
            ? yield* observeById(output.webhookId)
            : yield* observeByName(yield* webhookName(id, olds?.name));
          if (!webhook) return undefined;
          if (output !== undefined) return toAttrs(webhook, output.signingSecret);
          // The secret is only revealed at creation; reconcile rotates it.
          const attrs = toAttrs(webhook, Redacted.make(""));
          return olds?.name !== undefined ? Unowned(attrs) : attrs;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* webhookName(id, news.name ?? output?.name);

          // Observe
          let webhook = output ? yield* observeById(output.webhookId) : yield* observeByName(name);
          let signingSecret = output?.signingSecret ?? Redacted.make("");

          // Ensure
          if (!webhook) {
            yield* session.note(`Creating webhook ${name}...`);
            const created = yield* boat.createWebhook({ name, url: news.url, events: news.events });
            webhook = created.webhook;
            signingSecret = redact(created.secret);
          }

          // Sync name, URL and events against the observed webhook.
          if (
            webhook.name !== name ||
            webhook.url !== news.url ||
            !sameEvents(webhook.events, news.events)
          ) {
            yield* session.note(`Updating webhook ${name}...`);
            webhook = (yield* boat.updateWebhook({
              webhookId: webhook.id,
              name,
              url: news.url,
              events: news.events,
            })).webhook;
          }

          // A webhook we hold no secret for (adopted, or a lost create)
          // gets a fresh one.
          if (Redacted.value(signingSecret) === "") {
            yield* session.note(`Rotating the signing secret of webhook ${name}...`);
            const rotated = yield* boat.rotateWebhookSigningSecret({ webhookId: webhook.id });
            webhook = rotated.webhook;
            signingSecret = redact(rotated.secret);
          }

          return toAttrs(webhook, signingSecret);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* boat
            .deleteWebhook({ webhookId: output.webhookId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const { webhooks } = yield* boat.listWebhooks({});
          return webhooks.map((webhook) => toAttrs(webhook, Redacted.make("")));
        }),
      };
    }),
  );
