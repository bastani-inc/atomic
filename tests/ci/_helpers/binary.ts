/**
 * Shared helpers for CI integration tests that exercise the compiled
 * `atomic` binary. Centralised so multiple test files can re-use one
 * build artifact instead of rebuilding per-suite (Windows in particular
 * holds the .exe open after spawn, so a second build attempt while a
 * previous test holds it racing-EACCESes).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TARGETS, hostTarget } from "../../../packages/atomic/script/targets.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Resolve the host-platform compiled binary path. Mirrors `build.ts` —
 * `dist/<target>/bin/atomic[.exe]` with the same target keys exposed
 * by `targets.ts` so a target rename in one place propagates here.
 */
export function getBinaryPath(): string {
  const target = hostTarget();
  const meta = TARGETS.find((t) => t.name === target);
  if (!meta) {
    throw new Error(`Unknown host target "${target}". Update TARGETS.`);
  }
  return join(REPO_ROOT, "packages", "atomic", "dist", target, "bin", `atomic${meta.ext ?? ""}`);
}

let binaryReady = false;

/**
 * Build the host-platform binary if it doesn't already exist. Memoised
 * so multiple tests sharing the same process pay the cost once.
 *
 * Build target is implicit (build.ts defaults to host) so this works on
 * every CI runner without per-platform branching.
 */
export function ensureBinary(): void {
  if (binaryReady) return;

  const binaryPath = getBinaryPath();
  if (existsSync(binaryPath)) {
    binaryReady = true;
    return;
  }

  const buildScript = join(REPO_ROOT, "packages", "atomic", "script", "build.ts");
  const result = spawnSync("bun", [buildScript], {
    stdio: "inherit",
    cwd: REPO_ROOT,
    timeout: 600_000,
  });

  if (result.status !== 0) {
    throw new Error(`build.ts exited with status ${result.status ?? "null"}`);
  }
  binaryReady = true;
}
