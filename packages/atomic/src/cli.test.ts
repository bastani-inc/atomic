/**
 * Integration tests for the custom-workflow bootstrap wiring in main().
 *
 * Strategy:
 *   - Items 1–4 (registry/brokenIndex/summary): direct imports of
 *     `mergeIntoRegistry` and `createBuiltinRegistry` with synthetic
 *     `LoadCustomWorkflowsResult` fixtures — fast, no subprocess needed.
 *   - Items 5–6 (failure isolation, info-command skip): subprocess spawns
 *     of `bun packages/atomic/src/cli.ts` with a controlled ATOMIC_SETTINGS_HOME
 *     pointing at a temp settings.json.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mergeIntoRegistry } from "./commands/custom-workflows.ts";
import type { LoadCustomWorkflowsResult } from "./commands/custom-workflows.ts";
import { createBuiltinRegistry } from "./commands/builtin-registry.ts";
import type { ExternalWorkflow } from "@bastani/atomic-sdk";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CLI_PATH = join(import.meta.dir, "cli.ts");

interface Captured {
  stderr: string;
  restore: () => void;
}

function captureStderr(): Captured {
  const c: Captured = { stderr: "", restore: () => {} };
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    c.stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  c.restore = () => { process.stderr.write = orig; };
  return c;
}

function makeExternalWorkflow(name: string, agent: "claude" | "opencode" | "copilot" = "claude"): ExternalWorkflow {
  return {
    kind: "external",
    name,
    agent,
    description: "Test workflow",
    inputs: [],
    source: { command: "bun", args: ["test-script.ts"] },
  };
}

// ─── Temp dir for subprocess tests ────────────────────────────────────────────

let tmpHome: string;
let tmpCwd: string;

beforeAll(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "atomic-cli-test-home-"));
  tmpCwd = await mkdtemp(join(tmpdir(), "atomic-cli-test-cwd-"));
  // Create .atomic dirs so readAtomicConfigSplit doesn't error
  await mkdir(join(tmpHome, ".atomic"), { recursive: true });
  await mkdir(join(tmpCwd, ".atomic"), { recursive: true });
});

afterAll(async () => {
  await rm(tmpHome, { recursive: true, force: true });
  await rm(tmpCwd, { recursive: true, force: true });
});

async function spawnCli(
  args: string[],
  opts: { settingsHome?: string; cwd?: string; env?: Record<string, string> } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.cwd ?? tmpCwd,
    env: {
      ...process.env,
      ATOMIC_SETTINGS_HOME: opts.settingsHome ?? tmpHome,
      // Suppress autosync and other heavy bootstrap
      ATOMIC_SKIP_AUTOSYNC: "1",
      ...(opts.env ?? {}),
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  await proc.exited;
  return { exitCode: proc.exitCode, stdout, stderr };
}

// ─── Unit: mergeIntoRegistry ──────────────────────────────────────────────────

describe("mergeIntoRegistry — bootstrap wiring", () => {
  test("bootstrap completes without throwing", () => {
    const empty: LoadCustomWorkflowsResult = { loaded: [], broken: [] };
    expect(() => mergeIntoRegistry(createBuiltinRegistry(), empty, empty)).not.toThrow();
  });

  test("summary is null when no custom workflows present", () => {
    const empty: LoadCustomWorkflowsResult = { loaded: [], broken: [] };
    const { summary } = mergeIntoRegistry(createBuiltinRegistry(), empty, empty);
    expect(summary).toBeNull();
  });

  test("summary emitted when healthy entries present", () => {
    const cap = captureStderr();
    try {
      const wf = makeExternalWorkflow("my-wf");
      const globalRes: LoadCustomWorkflowsResult = {
        loaded: [{ alias: "my-wf", origin: "global", workflow: wf }],
        broken: [],
      };
      const localRes: LoadCustomWorkflowsResult = { loaded: [], broken: [] };
      const { summary } = mergeIntoRegistry(createBuiltinRegistry(), globalRes, localRes);
      expect(summary).not.toBeNull();
      expect(summary).toContain("loaded 1 custom workflow");
    } finally {
      cap.restore();
    }
  });

  test("registry contains the healthy workflow", () => {
    const wf = makeExternalWorkflow("healthy-wf", "claude");
    const globalRes: LoadCustomWorkflowsResult = {
      loaded: [{ alias: "healthy-wf", origin: "global", workflow: wf }],
      broken: [],
    };
    const localRes: LoadCustomWorkflowsResult = { loaded: [], broken: [] };
    const { registry } = mergeIntoRegistry(createBuiltinRegistry(), globalRes, localRes);
    const resolved = registry.resolve("healthy-wf", "claude");
    expect(resolved).not.toBeNull();
    expect(resolved?.name).toBe("healthy-wf");
  });

  test("brokenIndex contains the broken entry", () => {
    const globalRes: LoadCustomWorkflowsResult = {
      loaded: [],
      broken: [
        {
          alias: "bad-wf",
          origin: "global",
          agents: ["claude"],
          reason: "command not found",
          source: "/fake/settings.json",
          fix: "install the command",
        },
      ],
    };
    const localRes: LoadCustomWorkflowsResult = { loaded: [], broken: [] };
    const { brokenIndex } = mergeIntoRegistry(createBuiltinRegistry(), globalRes, localRes);
    expect(brokenIndex.has("claude/bad-wf")).toBe(true);
    expect(brokenIndex.get("claude/bad-wf")?.reason).toBe("command not found");
  });

  test("summary counts both loaded and broken", () => {
    const wf = makeExternalWorkflow("ok-wf");
    const globalRes: LoadCustomWorkflowsResult = {
      loaded: [{ alias: "ok-wf", origin: "global", workflow: wf }],
      broken: [
        {
          alias: "broken-wf",
          origin: "global",
          agents: ["claude"],
          reason: "timed out",
          source: "/settings.json",
          fix: "check command",
        },
      ],
    };
    const localRes: LoadCustomWorkflowsResult = { loaded: [], broken: [] };
    const { summary } = mergeIntoRegistry(createBuiltinRegistry(), globalRes, localRes);
    expect(summary).toContain("loaded 1");
    expect(summary).toContain("1 skipped");
  });

  test("local overrides global with same name+agent", () => {
    const globalWf = makeExternalWorkflow("shared-wf", "claude");
    const localWf: ExternalWorkflow = {
      ...makeExternalWorkflow("shared-wf", "claude"),
      description: "Local override",
    };
    const cap = captureStderr();
    try {
      const globalRes: LoadCustomWorkflowsResult = {
        loaded: [{ alias: "shared-wf", origin: "global", workflow: globalWf }],
        broken: [],
      };
      const localRes: LoadCustomWorkflowsResult = {
        loaded: [{ alias: "shared-wf", origin: "local", workflow: localWf }],
        broken: [],
      };
      const { registry } = mergeIntoRegistry(createBuiltinRegistry(), globalRes, localRes);
      const resolved = registry.resolve("shared-wf", "claude");
      expect((resolved as ExternalWorkflow)?.description).toBe("Local override");
    } finally {
      cap.restore();
    }
  });
});

// ─── Subprocess: info-command path skips workflow load ─────────────────────────

describe("subprocess: info-command path", () => {
  test("--version skips workflow bootstrap (fast exit, no [atomic/workflows] on stderr)", async () => {
    // Write a settings.json with a workflow pointing to a nonexistent command.
    // If the bootstrap runs, it would log a failure. Passing --version should
    // skip the bootstrap entirely.
    const settingsHome = await mkdtemp(join(tmpdir(), "atomic-ver-test-"));
    try {
      await mkdir(join(settingsHome, ".atomic"), { recursive: true });
      await writeFile(
        join(settingsHome, ".atomic", "settings.json"),
        JSON.stringify({
          workflows: {
            "nonexistent-cmd": {
              command: "__atomic_test_nonexistent_cmd__",
              agents: ["claude"],
            },
          },
        }),
      );
      const { exitCode, stderr } = await spawnCli(["--version"], {
        settingsHome,
      });
      // --version exits 0
      expect(exitCode).toBe(0);
      // No workflow diagnostics emitted (bootstrap skipped)
      expect(stderr).not.toContain("[atomic/workflows]");
    } finally {
      await rm(settingsHome, { recursive: true, force: true });
    }
  }, 15000);

  test("-v skips workflow bootstrap", async () => {
    const settingsHome = await mkdtemp(join(tmpdir(), "atomic-v-test-"));
    try {
      await mkdir(join(settingsHome, ".atomic"), { recursive: true });
      await writeFile(
        join(settingsHome, ".atomic", "settings.json"),
        JSON.stringify({
          workflows: {
            "nonexistent-cmd": {
              command: "__atomic_test_nonexistent_cmd__",
              agents: ["claude"],
            },
          },
        }),
      );
      const { exitCode, stderr } = await spawnCli(["-v"], {
        settingsHome,
      });
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("[atomic/workflows]");
    } finally {
      await rm(settingsHome, { recursive: true, force: true });
    }
  }, 15000);
});

// ─── Subprocess: bootstrap failure isolation ──────────────────────────────────

describe("subprocess: workflow bootstrap failure isolation", () => {
  test("broken workflow entry (nonexistent command) does not abort CLI — workflow list exits 0", async () => {
    const settingsHome = await mkdtemp(join(tmpdir(), "atomic-broken-test-"));
    try {
      await mkdir(join(settingsHome, ".atomic"), { recursive: true });
      await writeFile(
        join(settingsHome, ".atomic", "settings.json"),
        JSON.stringify({
          workflows: {
            "broken-entry": {
              command: "__atomic_test_nonexistent_999__",
              agents: ["claude"],
            },
          },
        }),
      );
      const { exitCode, stderr } = await spawnCli(["--no-banner", "workflow", "list"], {
        settingsHome,
      });
      // CLI must not crash — exit 0
      expect(exitCode).toBe(0);
      // The per-entry failure is logged to stderr
      expect(stderr).toContain("broken-entry");
    } finally {
      await rm(settingsHome, { recursive: true, force: true });
    }
  }, 30000);

  test("settings.json with no workflows key — bootstrap runs without error", async () => {
    const settingsHome = await mkdtemp(join(tmpdir(), "atomic-noworkflows-test-"));
    try {
      await mkdir(join(settingsHome, ".atomic"), { recursive: true });
      await writeFile(
        join(settingsHome, ".atomic", "settings.json"),
        JSON.stringify({ "$schema": "https://example.com/schema.json" }),
      );
      const { exitCode, stderr } = await spawnCli(["--no-banner", "workflow", "list"], {
        settingsHome,
      });
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("[atomic/workflows] failed to merge");
    } finally {
      await rm(settingsHome, { recursive: true, force: true });
    }
  }, 30000);
});
