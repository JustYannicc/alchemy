import * as boat from "@distilled.cloud/boat-dev/boat";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Boat from "@/Boat";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: Boat.providers() });

const tags = ["provider:boat", "provider:boat:named-snapshot", "live"];

const getSnapshot = (name: string) =>
  boat.getNamedSnapshot({ name }).pipe(
    Effect.map((res) => res.snapshot),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

// Builds a sandbox, runs a setup script and saves it twice: minutes of
// machine time.
test.provider.skipIf(!!process.env.FAST)(
  "build, rebuild and delete a named snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const image = yield* stack.deploy(
        Boat.NamedSnapshot("Image", {
          type: "small",
          setupScript: "echo v1 > ~/alchemy-image-version",
        }),
      );
      const observed = yield* getSnapshot(image.name);
      expect(observed?.status).toBe("ready");
      expect(observed?.snapshotId).toBe(image.snapshotId);

      // Same props: nothing is rebuilt.
      const same = yield* stack.deploy(
        Boat.NamedSnapshot("Image", {
          type: "small",
          setupScript: "echo v1 > ~/alchemy-image-version",
        }),
      );
      expect(same.snapshotId).toBe(image.snapshotId);

      // A new script rebuilds the snapshot under the same name.
      const rebuilt = yield* stack.deploy(
        Boat.NamedSnapshot("Image", {
          type: "small",
          setupScript: "echo v2 > ~/alchemy-image-version",
        }),
      );
      expect(rebuilt.name).toBe(image.name);
      expect(rebuilt.snapshotId).not.toBe(image.snapshotId);

      // The build sandboxes are gone.
      for (const sandboxId of [image.sourceSandboxId, rebuilt.sourceSandboxId]) {
        const sandbox = yield* boat.getSandbox({ sandboxId }).pipe(
          Effect.map((res) => res.sandbox),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
        expect(sandbox === undefined || sandbox.state === "cancelled").toBe(true);
      }

      yield* stack.destroy();
      expect(yield* getSnapshot(image.name)).toBeUndefined();
    }),
  { tags, timeout: 900_000 },
);

test.provider(
  "a named snapshot without a source fails",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const failure = yield* stack.deploy(Boat.NamedSnapshot("Empty", {})).pipe(Effect.flip);
      expect(String(failure)).toContain("needs a sandboxId, a setupScript or a from snapshot");
      yield* stack.destroy();
    }),
  { tags, timeout: 60_000 },
);
