import * as boat from "@distilled.cloud/boat-dev/boat";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Boat from "@/Boat";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: Boat.providers() });

const tags = ["provider:boat", "provider:boat:api-key", "live"];

const findKey = (apiKeyId: string) =>
  boat.listApiKeys({}).pipe(Effect.map((res) => res.apiKeys.find((key) => key.id === apiKeyId)));

/** Whether Boat accepts `secret` as a bearer key. */
const authenticates = (secret: Redacted.Redacted<string>) =>
  boat.listEnvironments({}).pipe(
    Effect.provide(Boat.fromApiKey({ apiKey: secret })),
    Effect.map(() => true),
    Effect.catchTag("Unauthorized", () => Effect.succeed(false)),
  );

test.provider(
  "create, replace and revoke a scoped API key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const key = yield* stack.deploy(Boat.ApiKey("Key", { preset: "read-only", ttl: "1d" }));
      expect(key.apiKeyId.length).toBeGreaterThan(0);
      expect(Redacted.value(key.secret)).toContain(key.keyLastFour);
      expect((yield* findKey(key.apiKeyId))?.name).toBe(key.name);
      expect(yield* authenticates(key.secret)).toBe(true);

      // Redeploying the same props keeps the key and its secret.
      const same = yield* stack.deploy(Boat.ApiKey("Key", { preset: "read-only", ttl: "1d" }));
      expect(same.apiKeyId).toBe(key.apiKeyId);
      expect(Redacted.value(same.secret)).toBe(Redacted.value(key.secret));

      // Keys are immutable: a new preset mints a new key and revokes the old.
      const replaced = yield* stack.deploy(
        Boat.ApiKey("Key", { preset: "full-sandbox", ttl: "1d" }),
      );
      expect(replaced.apiKeyId).not.toBe(key.apiKeyId);
      expect(yield* authenticates(replaced.secret)).toBe(true);
      expect(yield* authenticates(key.secret)).toBe(false);

      yield* stack.destroy();
      expect(yield* authenticates(replaced.secret)).toBe(false);
    }),
  { tags, timeout: 120_000 },
);
