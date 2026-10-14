import * as boat from "@distilled.cloud/boat-dev/boat";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { adopt } from "@/AdoptPolicy";
import * as Boat from "@/Boat";
import * as Test from "@/Test/Alchemy";
import { pinned } from "./support.ts";

const { test } = Test.make({ providers: Boat.providers() });

const tags = ["provider:boat", "provider:boat:webhook", "live"];

const getWebhook = (webhookId: string) =>
  boat.getWebhook({ webhookId }).pipe(
    Effect.map((res) => res.webhook),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

test.provider(
  "create, update and delete a webhook",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const hook = yield* stack.deploy(
        Boat.Webhook("Hook", {
          url: "https://example.com/alchemy/boat-webhook",
          events: ["sandbox.ready"],
        }),
      );
      expect(hook.webhookId).toMatch(/^wh_/);
      expect(Redacted.value(hook.signingSecret).length).toBeGreaterThan(0);
      expect((yield* getWebhook(hook.webhookId))?.events).toEqual(["sandbox.ready"]);

      const updated = yield* stack.deploy(
        Boat.Webhook("Hook", {
          url: "https://example.com/alchemy/boat-webhook-v2",
          events: ["sandbox.ready", "sandbox.error"],
        }),
      );
      expect(updated.webhookId).toBe(hook.webhookId);
      // Updates keep the signing secret.
      expect(Redacted.value(updated.signingSecret)).toBe(Redacted.value(hook.signingSecret));
      const observed = yield* getWebhook(hook.webhookId);
      expect(observed?.url).toBe("https://example.com/alchemy/boat-webhook-v2");
      expect([...(observed?.events ?? [])].sort()).toEqual(["sandbox.error", "sandbox.ready"]);

      yield* stack.destroy();
      expect(yield* getWebhook(hook.webhookId)).toBeUndefined();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an adopted webhook gets a fresh signing secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* pinned("webhook-foreign");
      const url = "https://example.com/alchemy/boat-webhook-foreign";
      for (const webhook of (yield* boat.listWebhooks({})).webhooks) {
        if (webhook.name === name) yield* boat.deleteWebhook({ webhookId: webhook.id });
      }
      const foreign = yield* boat.createWebhook({ name, url, events: ["sandbox.archived"] });

      const adopted = yield* stack.deploy(
        Boat.Webhook("Foreign", { name, url, events: ["sandbox.archived"] }).pipe(adopt(true)),
      );
      expect(adopted.webhookId).toBe(foreign.webhook.id);
      expect(Redacted.value(adopted.signingSecret).length).toBeGreaterThan(0);

      yield* stack.destroy();
      expect(yield* getWebhook(adopted.webhookId)).toBeUndefined();
    }),
  { tags, timeout: 120_000 },
);
