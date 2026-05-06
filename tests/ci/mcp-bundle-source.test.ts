/**
 * Drift guard: the bundled-template `.claude/.mcp.json` must match the
 * project-root `.mcp.json`.
 *
 * Why this matters
 * ────────────────
 *   - `.mcp.json` at the repo root is what Atomic's own dogfood agents
 *     (Claude Code, Copilot CLI) read when they run *inside this repo*.
 *   - `.claude/.mcp.json` is what gets bundled into `.claude.tar` and
 *     shipped to fresh user projects via `applyManagedOnboardingFiles`
 *     (sourced as `kind: "claude", source: ".mcp.json"` in
 *     `definitions.ts` for both claude and copilot).
 *
 * If those two drift, fresh user projects get a stale or wrong `.mcp.json`
 * even though every dev locally sees Atomic working fine. The bug
 * surfaces only on a `git clone` + `atomic chat -a copilot`.
 *
 * Failure mode caught by this test:
 *   - The original mcp-setup hotfix added copilot to the onboarding
 *     manifest but never created `.claude/.mcp.json` — `pathExists` on
 *     the bundle-source returned false, `applyManagedOnboardingFiles`
 *     silently skipped the copy, and `.mcp.json` was missing from
 *     every fresh project on every platform. A cheap byte-equality
 *     check at PR time would have caught it before the E2E matrix.
 *
 * Cheap to run, runs in the standard PR suite (no `RUN_CI_E2E` gate).
 */

import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ROOT_MCP = join(REPO_ROOT, ".mcp.json");
const BUNDLE_MCP = join(REPO_ROOT, ".claude", ".mcp.json");

test("`.claude/.mcp.json` exists — the bundled template that ships in `.claude.tar`", () => {
  expect(
    existsSync(BUNDLE_MCP),
    `Missing ${BUNDLE_MCP}. Without this file the build's tar bundle has no .mcp.json source, ` +
      `and applyManagedOnboardingFiles will silently skip the copy for both claude and copilot.`,
  ).toBe(true);
});

test("`.mcp.json` (repo root) and `.claude/.mcp.json` (bundle source) parse to the same JSON", async () => {
  expect(existsSync(ROOT_MCP), `Missing ${ROOT_MCP}`).toBe(true);
  expect(existsSync(BUNDLE_MCP), `Missing ${BUNDLE_MCP}`).toBe(true);

  const [rootJson, bundleJson] = await Promise.all([
    Bun.file(ROOT_MCP).json(),
    Bun.file(BUNDLE_MCP).json(),
  ]);

  // Compare parsed JSON rather than raw bytes so trailing newline /
  // whitespace differences don't trigger a false drift. The contract
  // is "same logical config", not "same file contents".
  expect(
    bundleJson,
    `Bundle template ${BUNDLE_MCP} has drifted from project-root ${ROOT_MCP}. ` +
      `Re-sync them — fresh user projects will receive whatever's in the bundle copy.`,
  ).toEqual(rootJson);
});
