import * as boat from "@distilled.cloud/boat-dev/boat";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Boat from "@/Boat";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: Boat.providers() });

const tags = ["provider:boat", "provider:boat:credential-profile", "live"];

const findProfile = (profileId: string) =>
  boat
    .listCredentialProfiles({})
    .pipe(Effect.map((res) => res.profiles.find((profile) => profile.id === profileId)));

test.provider(
  "create, update and delete a credential profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const profile = yield* stack.deploy(
        Boat.CredentialProfile("Profile", {
          keys: { "openai-api-key": Redacted.make("sk-alchemy-test-0001") },
          customApis: {
            ALCHEMY_TEST_KEY: {
              value: Redacted.make("custom-0001"),
              baseUrl: "https://example.com/api",
            },
          },
        }),
      );
      expect(profile.connected).toEqual(["openai-api-key"]);
      expect(profile.customApis).toEqual(["ALCHEMY_TEST_KEY"]);
      const observed = yield* findProfile(profile.profileId);
      expect(observed?.connected).toEqual(["openai-api-key"]);

      // Swap the key for another credential and drop the custom API.
      const updated = yield* stack.deploy(
        Boat.CredentialProfile("Profile", {
          keys: { "anthropic-api-key": Redacted.make("sk-ant-alchemy-test-0001") },
        }),
      );
      expect(updated.profileId).toBe(profile.profileId);
      expect(updated.connected).toEqual(["anthropic-api-key"]);
      expect(updated.customApis).toEqual([]);

      yield* stack.destroy();
      expect(yield* findProfile(profile.profileId)).toBeUndefined();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an environment uses a credential profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { profile, env } = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* Boat.CredentialProfile("Shared", {
            keys: { "openai-api-key": Redacted.make("sk-alchemy-test-0002") },
          });
          const env = yield* Boat.Environment("UsesProfile", {
            credentialProfileId: profile.profileId,
          });
          return { profile, env };
        }),
      );
      expect(env.credentialProfileId).toBe(profile.profileId);

      // Destroy deletes the environment before the profile it names.
      yield* stack.destroy();
      expect(yield* findProfile(profile.profileId)).toBeUndefined();
    }),
  { tags, timeout: 120_000 },
);
