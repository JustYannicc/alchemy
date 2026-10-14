import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { sha256Object } from "../Util/sha256.ts";
import type { Providers } from "./Providers.ts";

/** Machine size of the sandbox a snapshot is built on. */
export type SandboxType = "small" | "default" | "large" | "xlarge" | (string & {});

export interface NamedSnapshotProps {
  /**
   * Snapshot name, unique within your account: lowercase letters, digits
   * and dashes, at most 63 characters. Sandboxes deploy from it with
   * `from: <name>`. If omitted, a unique name is generated from the stack,
   * stage, and logical ID. Changing it replaces the snapshot.
   */
  name?: string;
  /**
   * Save the snapshot from this existing sandbox. Changing it re-saves the
   * snapshot under the same name.
   */
  sandboxId?: string;
  /**
   * Build the snapshot: Alchemy creates a sandbox with no account secrets,
   * runs this script on it as the sandbox user, saves the snapshot once the
   * script succeeds, and deletes the sandbox. Changing it rebuilds the
   * snapshot under the same name. Ignored when `sandboxId` is set.
   */
  setupScript?: string;
  /**
   * Machine size of the build sandbox; sandboxes deployed from the snapshot
   * default to it. Changing it rebuilds the snapshot.
   * @default "default"
   */
  type?: SandboxType;
  /**
   * Start the build sandbox from another named snapshot (or a `bsh_…` share
   * code) instead of a fresh machine, so `setupScript` layers on top of it.
   * Changing it rebuilds the snapshot.
   */
  from?: string;
}

export interface NamedSnapshotAttributes {
  /** Snapshot name. */
  name: string;
  /** Id of the frozen artifact behind the name. */
  snapshotId: string | undefined;
  /** Sandbox type the snapshot was saved from. */
  type: string | undefined;
  /** Restored content size, in bytes. */
  sizeBytes: number | undefined;
  /** The sandbox the snapshot was saved from. */
  sourceSandboxId: string;
  /** Hash of the props the snapshot was built from; a change triggers a rebuild. */
  sourceHash: string;
}

export type NamedSnapshot = Resource<
  "Boat.NamedSnapshot",
  NamedSnapshotProps,
  NamedSnapshotAttributes,
  never,
  Providers
>;

/**
 * A Boat named snapshot: a frozen sandbox disk that new sandboxes start
 * from (`from: <name>` when creating a sandbox). Use one as the base image
 * of your runners.
 *
 * Re-saving a name replaces its artifact, so changing the build inputs
 * updates the snapshot in place. Sandboxes already deployed from it keep
 * their copy. Everything on the disk ships with the snapshot, which is why
 * the build sandbox gets none of the account's secrets.
 * @see https://docs.boat.dev/api/v1
 *
 * ### Building a base image
 * **Example:** Runner image with tools preinstalled
 * ```typescript
 * const image = yield* Boat.NamedSnapshot("Runner", {
 *   setupScript: [
 *     "set -euo pipefail",
 *     "curl -fsSL https://bun.sh/install | bash",
 *     "npm install -g pnpm",
 *   ].join("\n"),
 * });
 * // create sandboxes with { from: image.name }
 * ```
 *
 * **Example:** Layer on top of another snapshot
 * ```typescript
 * const tools = yield* Boat.NamedSnapshot("Tools", { setupScript: "..." });
 * const app = yield* Boat.NamedSnapshot("App", {
 *   from: tools.name,
 *   setupScript: "git clone https://github.com/acme/app && cd app && pnpm install",
 * });
 * ```
 *
 * ### Saving an existing sandbox
 * **Example:** Freeze a sandbox you prepared by hand
 * ```typescript
 * const snapshot = yield* Boat.NamedSnapshot("Golden", { sandboxId: "bx_23456789" });
 * ```
 *
 * @resource
 * @product Named Snapshot
 */
export const NamedSnapshot = Resource<NamedSnapshot>("Boat.NamedSnapshot");

/** The snapshot or its build sandbox ended in a failed state. */
export class NamedSnapshotBuildFailed extends Data.TaggedError("NamedSnapshotBuildFailed")<{
  message: string;
}> {}

const snapshotName = (id: string, name: string | undefined) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, lowercase: true, maxLength: 63 });

const observe = (name: string) =>
  boat.getNamedSnapshot({ name }).pipe(
    Effect.map((res) => res.snapshot),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const toAttrs = (snapshot: boat.NamedSnapshot, sourceHash: string): NamedSnapshotAttributes => ({
  name: snapshot.name,
  snapshotId: snapshot.snapshotId,
  type: snapshot.type,
  sizeBytes: snapshot.sizeBytes,
  sourceSandboxId: snapshot.sourceSandboxId,
  sourceHash,
});

const sourceHashOf = (props: NamedSnapshotProps) =>
  sha256Object({
    sandboxId: props.sandboxId,
    ...(props.sandboxId === undefined
      ? { setupScript: props.setupScript, type: props.type, from: props.from }
      : {}),
  });

// Builds and saves can take minutes; poll every 5 seconds for up to 30.
const pollSchedule = Schedule.spaced("5 seconds");
const POLL_TIMES = 360;

const BUILDER_UP = new Set(["ready", "idle", "running"]);
const BUILDER_TERMINAL = new Set(["error", "cancelled", "archived"]);

/** Wait until the build sandbox is up and its setup script has finished. */
const awaitBuilder = (sandboxId: string) =>
  boat.getSandbox({ sandboxId }).pipe(
    Effect.map((res) => res.sandbox),
    Effect.repeat({
      schedule: pollSchedule,
      times: POLL_TIMES,
      until: (sandbox) =>
        BUILDER_TERMINAL.has(sandbox.state) ||
        sandbox.setupStatus === "failed" ||
        (BUILDER_UP.has(sandbox.state) &&
          (sandbox.setupStatus == null || sandbox.setupStatus === "done")),
    }),
    Effect.flatMap((sandbox) =>
      BUILDER_UP.has(sandbox.state) && sandbox.setupStatus !== "failed"
        ? Effect.void
        : Effect.fail(
            new NamedSnapshotBuildFailed({
              message: `Build sandbox ${sandboxId} ended ${sandbox.setupStatus === "failed" ? "with a failed setup script" : `in state ${sandbox.state}`}: ${sandbox.setupError ?? sandbox.error ?? "no detail"}`,
            }),
          ),
    ),
  );

/**
 * Wait until a save settles at `ready` or `failed`. While a name is being
 * re-saved Boat may keep serving the previous artifact, so a save only
 * counts once it comes from `sandboxId` and differs from `previous`.
 */
const awaitSaved = (name: string, saving?: { sandboxId: string; previous?: string }) =>
  observe(name).pipe(
    Effect.repeat({
      schedule: pollSchedule,
      times: POLL_TIMES,
      until: (snapshot) =>
        snapshot !== undefined &&
        snapshot.status !== "saving" &&
        (saving === undefined ||
          snapshot.status === "failed" ||
          (snapshot.sourceSandboxId === saving.sandboxId &&
            (saving.previous === undefined || snapshot.snapshotId !== saving.previous))),
    }),
    Effect.flatMap((snapshot) =>
      snapshot?.status === "ready"
        ? Effect.succeed(snapshot)
        : Effect.fail(
            new NamedSnapshotBuildFailed({
              message: `Named snapshot ${name} failed to save: ${snapshot?.error ?? "no detail"}`,
            }),
          ),
    ),
  );

const deleteSandbox = (sandboxId: string) =>
  boat.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );

export const NamedSnapshotProvider = () =>
  Provider.effect(
    NamedSnapshot,
    Effect.gen(function* () {
      return {
        stables: ["name"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = output?.name ?? (yield* snapshotName(id, olds?.name));
          if (news.name !== undefined && news.name !== name) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* snapshotName(id, olds?.name));
          const snapshot = yield* observe(name);
          if (!snapshot) return undefined;
          // Without state there is no record of what the snapshot was built
          // from; an empty hash makes reconcile rebuild it.
          const attrs = toAttrs(snapshot, output?.sourceHash ?? "");
          return output === undefined && olds?.name !== undefined ? Unowned(attrs) : attrs;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* snapshotName(id, news.name ?? output?.name);
          const sourceHash = yield* sourceHashOf(news);
          if (
            news.sandboxId === undefined &&
            news.setupScript === undefined &&
            news.from === undefined
          ) {
            return yield* new NamedSnapshotBuildFailed({
              message: `Named snapshot ${name} needs a sandboxId, a setupScript or a from snapshot.`,
            });
          }

          // Observe; let an in-flight save settle first.
          let snapshot = yield* observe(name);
          if (snapshot?.status === "saving") {
            yield* session.note(`Waiting for named snapshot ${name} to finish saving...`);
            snapshot = yield* awaitSaved(name).pipe(Effect.orElseSucceed(() => undefined));
          }
          if (snapshot?.status === "ready" && output?.sourceHash === sourceHash) {
            return toAttrs(snapshot, sourceHash);
          }

          // Ensure: save from the given sandbox, or build one and save it.
          const previous = snapshot?.snapshotId;
          const save = (sandboxId: string) =>
            Effect.gen(function* () {
              yield* session.note(`Saving named snapshot ${name} from ${sandboxId}...`);
              yield* boat.saveNamedSnapshot({ sandboxId, name });
              return yield* awaitSaved(name, { sandboxId, previous });
            });
          const saved =
            news.sandboxId !== undefined
              ? yield* save(news.sandboxId)
              : yield* Effect.acquireUseRelease(
                  Effect.gen(function* () {
                    yield* session.note(`Creating build sandbox for named snapshot ${name}...`);
                    const created = yield* boat.createSandbox({
                      type: news.type,
                      from: news.from,
                      setupScript: news.setupScript,
                      noEnv: true,
                      // Auto-stops a build sandbox a crashed deploy leaves behind.
                      ttlSeconds: 7200,
                    });
                    return created.sandbox.id;
                  }),
                  (sandboxId) =>
                    Effect.gen(function* () {
                      yield* session.note(`Running the setup script on ${sandboxId}...`);
                      yield* awaitBuilder(sandboxId);
                      return yield* save(sandboxId);
                    }),
                  (sandboxId) => deleteSandbox(sandboxId).pipe(Effect.ignore),
                );

          return toAttrs(saved, sourceHash);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* boat.deleteNamedSnapshot({ name: output.name }).pipe(
            Effect.asVoid,
            Effect.catchTag("NotFound", () => Effect.void),
            // A save still in flight holds the name.
            Effect.retry({
              while: (e) => e._tag === "Conflict",
              schedule: Schedule.spaced("5 seconds"),
              times: 12,
            }),
          );
        }),
        list: Effect.fn(function* () {
          const { snapshots } = yield* boat.listNamedSnapshots({});
          return snapshots.map((snapshot) => toAttrs(snapshot, ""));
        }),
      };
    }),
  );
