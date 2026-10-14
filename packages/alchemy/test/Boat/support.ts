import * as Effect from "effect/Effect";
import { Stage } from "@/Stage";

/** A deterministic, user-chosen name unique to the test stage. */
export const pinned = (suffix: string) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    return `alchemy-${stage}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  });
