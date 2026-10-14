import * as boat from "@distilled.cloud/boat-dev/boat";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Boat from "@/Boat";
import * as Test from "@/Test/Alchemy";
import { pinned } from "./support.ts";

const { test } = Test.make({ providers: Boat.providers() });

const tags = ["provider:boat", "provider:boat:environment", "live"];

const findEnvironment = (environmentId: string) =>
  boat
    .listEnvironments({})
    .pipe(Effect.map((res) => res.environments.find((env) => env.id === environmentId)));

const envContentsOf = (env: boat.SandboxEnvironment | undefined) =>
  env === undefined
    ? undefined
    : Redacted.isRedacted(env.envContents)
      ? Redacted.value(env.envContents)
      : env.envContents;

test.provider(
  "create, update and delete an environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const env = yield* stack.deploy(
        Boat.Environment("Env", {
          passGithub: false,
          vars: { GREETING: "hello", TOKEN: Redacted.make("s3cr3t value") },
          secretFiles: { ".config/alchemy/key.json": Redacted.make('{"k":1}') },
        }),
      );
      expect(env.passGithub).toBe(false);
      expect(env.varNames).toEqual(["GREETING", "TOKEN"]);
      expect(env.secretFilePaths).toEqual([".config/alchemy/key.json"]);

      const observed = yield* findEnvironment(env.environmentId);
      expect(observed?.passGithub).toBe(false);
      expect(envContentsOf(observed)).toContain("GREETING=hello");
      expect(observed?.secretFiles.map((file) => file.path)).toEqual([".config/alchemy/key.json"]);

      // Change one variable: the flag and the secret file stay as they are.
      const updated = yield* stack.deploy(
        Boat.Environment("Env", {
          passGithub: false,
          vars: { GREETING: "hi", TOKEN: Redacted.make("s3cr3t value") },
          secretFiles: { ".config/alchemy/key.json": Redacted.make('{"k":1}') },
        }),
      );
      expect(updated.environmentId).toBe(env.environmentId);
      expect(updated.latestVersionNumber).toBeGreaterThan(env.latestVersionNumber);
      const afterUpdate = yield* findEnvironment(env.environmentId);
      expect(afterUpdate?.passGithub).toBe(false);
      expect(envContentsOf(afterUpdate)).toContain("GREETING=hi");
      expect(afterUpdate?.secretFiles).toHaveLength(1);

      // Redeploying the same props mints no new version.
      const unchanged = yield* stack.deploy(
        Boat.Environment("Env", {
          passGithub: false,
          vars: { GREETING: "hi", TOKEN: Redacted.make("s3cr3t value") },
          secretFiles: { ".config/alchemy/key.json": Redacted.make('{"k":1}') },
        }),
      );
      expect(unchanged.latestVersionNumber).toBe(updated.latestVersionNumber);

      // Dropping a variable and the secret file removes them.
      const trimmed = yield* stack.deploy(
        Boat.Environment("Env", { passGithub: false, vars: { GREETING: "hi" }, secretFiles: {} }),
      );
      expect(trimmed.varNames).toEqual(["GREETING"]);
      expect(trimmed.secretFilePaths).toEqual([]);

      yield* stack.destroy();
      expect(yield* findEnvironment(env.environmentId)).toBeUndefined();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an environment keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = yield* pinned("env-before");
      const second = yield* pinned("env-after");

      const before = yield* stack.deploy(Boat.Environment("Renamed", { name: first }));
      const after = yield* stack.deploy(Boat.Environment("Renamed", { name: second }));
      expect(after.environmentId).toBe(before.environmentId);
      expect(after.name).toBe(second);
      expect((yield* findEnvironment(before.environmentId))?.name).toBe(second);

      yield* stack.destroy();
      expect(yield* findEnvironment(before.environmentId)).toBeUndefined();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an environment with a pinned name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* pinned("env-foreign");
      const existing = (yield* boat.listEnvironments({})).environments.find(
        (env) => env.name === name,
      );
      if (existing) yield* boat.deleteEnvironment({ environmentId: existing.id });
      const foreign = (yield* boat.createEnvironment({ name })).environments.find(
        (env) => env.name === name,
      );

      const app = (allow: boolean) =>
        Boat.Environment("Foreign", { name, vars: { ADOPTED: "1" } }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.environmentId).toBe(foreign?.id);
      expect(adopted.varNames).toEqual(["ADOPTED"]);

      yield* stack.destroy();
      expect(yield* findEnvironment(adopted.environmentId)).toBeUndefined();
    }),
  { tags, timeout: 120_000 },
);
