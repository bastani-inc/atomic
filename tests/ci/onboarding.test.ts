/**
 * Onboarding-on-compiled-binary integration test — cross-platform.
 *
 * Guards against two classes of regression:
 *
 *   1. Provider-config initialisation in a fresh project. Every agent's
 *      declared `onboarding_files` (see `AGENT_CONFIG`) must materialise
 *      on disk after `atomic chat -a <agent> --preflight-only`. The
 *      original mcp-setup bug was a silent omission in this list —
 *      copilot shipped with `onboarding_files: []` so `.mcp.json` never
 *      landed at the project root.
 *
 *   2. Embedded-asset resolver drift across the per-platform package
 *      split (linux-x64, darwin-arm64, …). The compiled binary's tar
 *      bundles must extract through the same code path on every OS;
 *      a regression that points the resolver at a non-existent path
 *      would no-op `applyManagedOnboardingFiles` and leave a fresh
 *      project without any provider config.
 *
 * Runs only when:
 *   - RUN_CI_E2E=1 is set (slow build; never bloats the fast suite)
 *
 * The build is host-target only — each CI runner builds for its own
 * platform and exercises the binary it produced. That gives us real
 * Linux × macOS × Windows coverage without cross-compile flakiness.
 *
 * Invocation: `atomic chat -a <agent> --preflight-only` runs the
 * preflight steps (global config sync + project onboarding) then exits
 * 0. The `--preflight-only` flag intentionally skips the agent-binary
 * existence check and the auth probe so this works on a runner where
 * none of claude/copilot/opencode is installed.
 */

import { test, expect, afterAll, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureBinary, getBinaryPath } from "./_helpers/binary.ts";

// ─── Skip guard ──────────────────────────────────────────────────────────────

const isE2EEnabled = process.env.RUN_CI_E2E === "1";

// ─── Sandbox ─────────────────────────────────────────────────────────────────

interface Sandbox {
  /** Temporary project root — project-scoped onboarding files land here. */
  projectRoot: string;
  /** HOME / ATOMIC_SETTINGS_HOME override — global onboarding files land here. */
  settingsHome: string;
}

const sandboxes: Sandbox[] = [];

afterAll(async () => {
  await Promise.all(
    sandboxes.map(async (s) => {
      await rm(s.projectRoot, { recursive: true, force: true });
      await rm(s.settingsHome, { recursive: true, force: true });
    }),
  );
  sandboxes.length = 0;
});

async function createSandbox(label: string): Promise<Sandbox> {
  const projectRoot = await mkdtemp(join(tmpdir(), `atomic-onboarding-${label}-proj-`));
  const settingsHome = await mkdtemp(join(tmpdir(), `atomic-onboarding-${label}-home-`));
  const sandbox = { projectRoot, settingsHome };
  sandboxes.push(sandbox);
  return sandbox;
}

interface PreflightResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the compiled binary in preflight mode against the given agent.
 *
 * Env isolation:
 *   - `HOME` / `USERPROFILE` → consumed by `homedir()`, used by
 *     `applyManagedOnboardingFiles`'s `~/...` destination resolver.
 *   - `ATOMIC_SETTINGS_HOME` → consumed by `getSettingsHome`, used by
 *     `installGlobalAgents`, skills sync, the auto-sync marker.
 *   - `XDG_CACHE_HOME` (Linux) / `LOCALAPPDATA` (Windows) → consumed by
 *     `cacheRoot()` in `embedded-assets.ts` to locate the bundle
 *     extraction cache. Forcing them inside the sandbox prevents a
 *     stale extraction from a previous version-matched run masking
 *     a regression in the bundle contents.
 *
 * Setting all of them keeps every read AND write inside the sandbox so
 * the test never pollutes the developer's real home and never picks up
 * a cached bundle extracted by a prior test run.
 */
function runPreflight(agent: string, sandbox: Sandbox): PreflightResult {
  const result = spawnSync(
    getBinaryPath(),
    ["chat", "-a", agent, "--preflight-only"],
    {
      cwd: sandbox.projectRoot,
      env: {
        ...process.env,
        ATOMIC_SETTINGS_HOME: sandbox.settingsHome,
        HOME: sandbox.settingsHome,
        USERPROFILE: sandbox.settingsHome,
        XDG_CACHE_HOME: join(sandbox.settingsHome, ".cache"),
        LOCALAPPDATA: join(sandbox.settingsHome, "AppData", "Local"),
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    },
  );
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

/**
 * Resolve a destination string from `AGENT_CONFIG` against the sandbox.
 * Mirrors `resolveDestination` in `packages/atomic/src/commands/cli/init/onboarding.ts`,
 * but redirects `~/` at the sandboxed settings home instead of the real
 * homedir so we can assert paths without polluting `~`.
 */
function resolveSandboxPath(destination: string, sandbox: Sandbox): string {
  if (destination === "~" || destination.startsWith("~/")) {
    return join(sandbox.settingsHome, destination.slice(1));
  }
  return join(sandbox.projectRoot, destination);
}

// ─── Per-agent expected outputs ──────────────────────────────────────────────
//
// The contract is duplicated here intentionally — the test asserts against
// hand-written invariants, NOT against AGENT_CONFIG. If a future change
// silently empties an agent's `onboarding_files`, the test should fail.
// Importing AGENT_CONFIG would mask exactly that regression.

interface ExpectedFile {
  /** Path string in the same shape as `AgentConfig.onboarding_files[].destination`. */
  destination: string;
  /**
   * Optional shape check: assert the produced JSON has this top-level key.
   * Use for keys that prove the file is the canonical template (e.g.
   * `mcpServers` in `.mcp.json`) rather than an empty stub.
   */
  hasTopLevelKey?: string;
}

const EXPECTED: Record<string, readonly ExpectedFile[]> = {
  claude: [
    { destination: ".mcp.json", hasTopLevelKey: "mcpServers" },
    { destination: ".claude/settings.json" },
    { destination: "~/.claude/settings.json" },
  ],
  copilot: [
    // Regression guard for the mcp-setup bug: copilot must produce
    // `.mcp.json` at the project root. Keep `hasTopLevelKey` so a
    // future "fix" that writes an empty `{}` stub still fails.
    { destination: ".mcp.json", hasTopLevelKey: "mcpServers" },
  ],
  opencode: [{ destination: ".opencode/opencode.json" }],
} as const;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!isE2EEnabled)("onboarding preflight (compiled binary)", () => {
  for (const [agent, expectedFiles] of Object.entries(EXPECTED)) {
    test(
      `${agent}: preflight materialises every declared onboarding file`,
      async () => {
        ensureBinary();
        const sandbox = await createSandbox(agent);

        const result = runPreflight(agent, sandbox);
        expect(
          result.exitCode,
          `binary exited ${result.exitCode}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        ).toBe(0);

        for (const file of expectedFiles) {
          const path = resolveSandboxPath(file.destination, sandbox);
          expect(
            existsSync(path),
            `Expected ${agent} onboarding file at ${path} (declared as ${file.destination})`,
          ).toBe(true);

          if (file.hasTopLevelKey) {
            const parsed = (await Bun.file(path).json()) as Record<string, unknown>;
            expect(
              parsed[file.hasTopLevelKey],
              `${path} must contain top-level "${file.hasTopLevelKey}" — missing means the bundle template wasn't materialised`,
            ).toBeDefined();
          }
        }
      },
    );
  }
});

// Marker test so a CI runner with the gate off still produces a green
// "tests ran" signal in this file (avoids zero-test ambiguity in
// dashboards).
test.skipIf(isE2EEnabled)(
  "onboarding preflight [skip when RUN_CI_E2E unset]",
  () => {
    expect(true).toBe(true);
  },
);
