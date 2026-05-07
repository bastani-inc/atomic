import { test, expect, describe, beforeEach, spyOn } from "bun:test";
import { pickWorkflows, readAtomicConfigSplit } from "./atomic-config.ts";
import { SETTINGS_SCHEMA_URL } from "./settings-schema.ts";

// Helper to capture stderr writes during a call.
function captureStderr(fn: () => unknown): { result: unknown; lines: string[] } {
  const lines: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  });
  const result = fn();
  spy.mockRestore();
  return { result, lines };
}

describe("pickWorkflows", () => {
  // ── Valid inputs ────────────────────────────────────────────────────────────

  test("returns undefined for null", () => {
    expect(pickWorkflows(null)).toBeUndefined();
  });

  test("returns undefined for non-object", () => {
    expect(pickWorkflows("string")).toBeUndefined();
    expect(pickWorkflows(42)).toBeUndefined();
    expect(pickWorkflows([])).toBeUndefined();
  });

  test("returns undefined for empty object", () => {
    expect(pickWorkflows({})).toBeUndefined();
  });

  test("accepts a minimal valid entry", () => {
    const result = pickWorkflows({
      "my-workflow": { command: "bunx", agents: ["claude"] },
    });
    expect(result).toEqual({
      "my-workflow": { command: "bunx", agents: ["claude"] },
    });
  });

  test("accepts all three known agents", () => {
    const result = pickWorkflows({
      "all-agents": { command: "node", agents: ["claude", "opencode", "copilot"] },
    });
    expect(result?.["all-agents"]?.agents).toEqual(["claude", "opencode", "copilot"]);
  });

  test("accepts entry with valid args array", () => {
    const result = pickWorkflows({
      "with-args": { command: "bunx", args: ["@me/pkg", "--flag"], agents: ["copilot"] },
    });
    expect(result?.["with-args"]?.args).toEqual(["@me/pkg", "--flag"]);
  });

  test("does not include args key when args is absent", () => {
    const result = pickWorkflows({
      "no-args": { command: "bunx", agents: ["claude"] },
    });
    expect(Object.prototype.hasOwnProperty.call(result?.["no-args"], "args")).toBe(false);
  });

  test("accepts multiple valid entries", () => {
    const result = pickWorkflows({
      alpha: { command: "bunx", agents: ["claude"] },
      beta: { command: "node", args: ["/path/to/bin.mjs"], agents: ["opencode"] },
    });
    expect(result).not.toBeUndefined();
    expect(Object.keys(result!)).toHaveLength(2);
  });

  test("keeps valid entries when some are invalid", () => {
    const { result } = captureStderr(() =>
      pickWorkflows({
        good: { command: "bunx", agents: ["claude"] },
        bad: { command: "", agents: ["claude"] },
      }),
    );
    expect(result).toEqual({ good: { command: "bunx", agents: ["claude"] } });
  });

  // ── Missing / empty command ─────────────────────────────────────────────────

  test("skips entry with missing command", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({ "no-cmd": { agents: ["claude"] } }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[atomic/workflows] "no-cmd": missing required "command"; see ${SETTINGS_SCHEMA_URL}`);
  });

  test("skips entry with empty command string", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({ "empty-cmd": { command: "", agents: ["claude"] } }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[atomic/workflows] "empty-cmd": missing required "command"`);
  });

  test("skips entry with whitespace-only command", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({ "ws-cmd": { command: "   ", agents: ["claude"] } }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[atomic/workflows] "ws-cmd": missing required "command"`);
  });

  test("skips entry when value is not an object", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({ "non-obj": "not an object" }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[atomic/workflows] "non-obj": missing required "command"`);
  });

  // ── agents validation ───────────────────────────────────────────────────────

  test("skips entry with missing agents", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({ "no-agents": { command: "bunx" } }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      `[atomic/workflows] "no-agents": "agents" must be a non-empty subset of [claude, opencode, copilot]\n`,
    );
  });

  test("skips entry with empty agents array", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({ "empty-agents": { command: "bunx", agents: [] } }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"agents" must be a non-empty subset of [claude, opencode, copilot]`);
  });

  test("skips entry with unknown agent value", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({ "bad-agent": { command: "bunx", agents: ["gpt4"] } }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"agents" must be a non-empty subset of [claude, opencode, copilot]`);
  });

  test("skips entry when agents contains mix of known and unknown", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({ "mixed-agents": { command: "bunx", agents: ["claude", "unknown"] } }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"agents" must be a non-empty subset of [claude, opencode, copilot]`);
  });

  test("skips entry when agents is not an array", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({ "str-agents": { command: "bunx", agents: "claude" } }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"agents" must be a non-empty subset of [claude, opencode, copilot]`);
  });

  // ── args validation ─────────────────────────────────────────────────────────

  test("skips entry when args is not an array", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({ "bad-args": { command: "bunx", args: "not-array", agents: ["claude"] } }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"args" must be array of strings (got string)`);
    expect(lines[0]).toContain(`"bad-args"`);
  });

  test("skips entry when args contains non-string elements", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({ "nonstr-args": { command: "bunx", args: [1, 2], agents: ["claude"] } }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"args" must be array of strings (got array of non-strings)`);
  });

  test("accepts empty args array", () => {
    const result = pickWorkflows({
      "empty-args": { command: "bunx", args: [], agents: ["claude"] },
    });
    expect(result?.["empty-args"]?.args).toEqual([]);
  });

  // ── Unknown properties ──────────────────────────────────────────────────────

  test("skips entry with unknown property", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({
        "unknown-prop": { command: "bunx", agents: ["claude"], extra: "oops" },
      }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      `[atomic/workflows] "unknown-prop": unknown property "extra" — see ${SETTINGS_SCHEMA_URL}\n`,
    );
  });

  test("emits one line per entry for multiple separate errors", () => {
    const { result, lines } = captureStderr(() =>
      pickWorkflows({
        bad1: { command: "", agents: ["claude"] },
        bad2: { command: "bunx", agents: [] },
      }),
    );
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(2);
  });
});

// ── mergeConfigs.workflows ────────────────────────────────────────────────────
// Test mergeConfigs behaviour by going through the public readAtomicConfig API
// using environment overrides for the settings paths, since mergeConfigs itself
// is not exported. We test pickWorkflows + mergeConfigs together via the
// exported readAtomicConfig-like behaviour by importing a helper that exercises
// the same merge logic.
//
// Instead, we test mergeConfigs indirectly by directly importing and calling
// pickWorkflows and verifying the outcome of merging two pickWorkflows results.

import { readAtomicConfig } from "./atomic-config.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

describe("mergeConfigs workflows via readAtomicConfig", () => {
  let tmpDir: string;
  let globalDir: string;
  let localDir: string;

  beforeEach(() => {
    tmpDir = Bun.env.TMPDIR ?? tmpdir();
    const unique = Math.random().toString(36).slice(2);
    globalDir = join(tmpDir, `atomic-test-global-${unique}`);
    localDir = join(tmpDir, `atomic-test-local-${unique}`);
    mkdirSync(join(globalDir, ".atomic"), { recursive: true });
    mkdirSync(join(localDir, ".atomic"), { recursive: true });
  });

  function writeSettings(dir: string, content: object) {
    writeFileSync(join(dir, ".atomic", "settings.json"), JSON.stringify(content), "utf-8");
  }

  async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
    const original = process.env.ATOMIC_SETTINGS_HOME;
    process.env.ATOMIC_SETTINGS_HOME = home;
    try {
      return await fn();
    } finally {
      if (original === undefined) delete process.env.ATOMIC_SETTINGS_HOME;
      else process.env.ATOMIC_SETTINGS_HOME = original;
    }
  }

  test("local-only workflows appear in merged config", async () => {
    writeSettings(localDir, {
      workflows: { "my-wf": { command: "bunx", agents: ["claude"] } },
    });
    const config = await withHome(globalDir, () => readAtomicConfig(localDir));
    expect(config?.workflows?.["my-wf"]).toEqual({ command: "bunx", agents: ["claude"] });
  });

  test("global-only workflows appear when no local settings", async () => {
    writeSettings(globalDir, {
      workflows: { "global-wf": { command: "node", agents: ["opencode"] } },
    });
    const config = await withHome(globalDir, () => readAtomicConfig(localDir));
    expect(config?.workflows?.["global-wf"]).toEqual({ command: "node", agents: ["opencode"] });
  });

  test("local workflow overrides same-key global workflow", async () => {
    writeSettings(globalDir, {
      workflows: { "shared": { command: "global-cmd", agents: ["claude"] } },
    });
    writeSettings(localDir, {
      workflows: { "shared": { command: "local-cmd", agents: ["claude", "copilot"] } },
    });
    const config = await withHome(globalDir, () => readAtomicConfig(localDir));
    expect(config?.workflows?.["shared"]?.command).toBe("local-cmd");
    expect(config?.workflows?.["shared"]?.agents).toEqual(["claude", "copilot"]);
  });

  test("non-overlapping keys from local and global are unioned", async () => {
    writeSettings(globalDir, {
      workflows: { "global-wf": { command: "g-cmd", agents: ["claude"] } },
    });
    writeSettings(localDir, {
      workflows: { "local-wf": { command: "l-cmd", agents: ["copilot"] } },
    });
    const config = await withHome(globalDir, () => readAtomicConfig(localDir));
    expect(config?.workflows?.["global-wf"]).toBeDefined();
    expect(config?.workflows?.["local-wf"]).toBeDefined();
    expect(Object.keys(config?.workflows ?? {})).toHaveLength(2);
  });

  test("returns undefined workflows when neither side has any", async () => {
    writeSettings(localDir, { version: 1 });
    writeSettings(globalDir, { version: 1 });
    const config = await withHome(globalDir, () => readAtomicConfig(localDir));
    expect(config?.workflows).toBeUndefined();
  });

  test("local key without matching global key survives alongside global key", async () => {
    writeSettings(globalDir, {
      workflows: { a: { command: "ga", agents: ["claude"] } },
    });
    writeSettings(localDir, {
      workflows: { b: { command: "lb", agents: ["opencode"] } },
    });
    const config = await withHome(globalDir, () => readAtomicConfig(localDir));
    expect(Object.keys(config?.workflows ?? {}).sort()).toEqual(["a", "b"]);
  });
});

// ── readAtomicConfigSplit ─────────────────────────────────────────────────────

describe("readAtomicConfigSplit", () => {
  let tmpBase: string;
  let globalDir: string;
  let localDir: string;

  beforeEach(() => {
    const unique = Math.random().toString(36).slice(2);
    tmpBase = join(tmpdir(), `atomic-split-${unique}`);
    globalDir = join(tmpBase, "global");
    localDir = join(tmpBase, "local");
    mkdirSync(join(globalDir, ".atomic"), { recursive: true });
    mkdirSync(join(localDir, ".atomic"), { recursive: true });
  });

  function writeSettings(dir: string, content: object) {
    writeFileSync(join(dir, ".atomic", "settings.json"), JSON.stringify(content), "utf-8");
  }

  async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
    const original = process.env.ATOMIC_SETTINGS_HOME;
    process.env.ATOMIC_SETTINGS_HOME = home;
    try {
      return await fn();
    } finally {
      if (original === undefined) delete process.env.ATOMIC_SETTINGS_HOME;
      else process.env.ATOMIC_SETTINGS_HOME = original;
    }
  }

  test("returns { global: null, local: null } when neither file exists", async () => {
    const nonexistentLocal = join(tmpBase, "nonexistent-local");
    const result = await withHome(join(tmpBase, "nonexistent-global"), () =>
      readAtomicConfigSplit(nonexistentLocal),
    );
    expect(result).toEqual({ global: null, local: null });
  });

  test("returns parsed configs when both exist", async () => {
    writeSettings(globalDir, { scm: "github" });
    writeSettings(localDir, { scm: "azure-devops" });
    const result = await withHome(globalDir, () => readAtomicConfigSplit(localDir));
    expect(result.global?.scm).toBe("github");
    expect(result.local?.scm).toBe("azure-devops");
  });

  test("returns { global: <parsed>, local: null } when local missing", async () => {
    writeSettings(globalDir, { scm: "sapling" });
    const nonexistentLocal = join(tmpBase, "no-local");
    const result = await withHome(globalDir, () =>
      readAtomicConfigSplit(nonexistentLocal),
    );
    expect(result.global?.scm).toBe("sapling");
    expect(result.local).toBeNull();
  });

  test("does NOT merge — local override does not affect global field", async () => {
    writeSettings(globalDir, { scm: "github" });
    writeSettings(localDir, { scm: "azure-devops" });
    const result = await withHome(globalDir, () => readAtomicConfigSplit(localDir));
    // Both sides are independent — no merge semantics.
    expect(result.global?.scm).toBe("github");
    expect(result.local?.scm).toBe("azure-devops");
  });
});

// ── pickWorkflows de-duplication ──────────────────────────────────────────────

describe("pickWorkflows — agents de-duplication", () => {
  function captureStderrSync(fn: () => unknown): { result: unknown; lines: string[] } {
    const lines: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    });
    const result = fn();
    spy.mockRestore();
    return { result, lines };
  }

  test("de-dupes [claude, claude] → [claude] and emits diagnostic", () => {
    const { result, lines } = captureStderrSync(() =>
      pickWorkflows({ "wf": { command: "bunx", agents: ["claude", "claude"] } }),
    );
    expect((result as Record<string, { agents: string[] }>)?.["wf"]?.agents).toEqual(["claude"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("duplicates");
    expect(lines[0]).toContain("claude");
  });

  test("preserves order on de-dupe: [claude, copilot, claude] → [claude, copilot]", () => {
    const { result } = captureStderrSync(() =>
      pickWorkflows({
        "wf": { command: "bunx", agents: ["claude", "copilot", "claude"] },
      }),
    );
    expect((result as Record<string, { agents: string[] }>)?.["wf"]?.agents).toEqual([
      "claude",
      "copilot",
    ]);
  });

  test("emits no diagnostic when no duplicates", () => {
    const { lines } = captureStderrSync(() =>
      pickWorkflows({ "wf": { command: "bunx", agents: ["claude", "copilot"] } }),
    );
    expect(lines).toHaveLength(0);
  });

  test("diagnostic message contains de-duplicated list", () => {
    const { lines } = captureStderrSync(() =>
      pickWorkflows({
        "my-wf": { command: "bunx", agents: ["claude", "opencode", "claude"] },
      }),
    );
    expect(lines[0]).toContain(`"agents" contains duplicates; de-duplicating to [claude, opencode]`);
  });

  test("args preserved after de-dupe", () => {
    const { result } = captureStderrSync(() =>
      pickWorkflows({
        "wf": { command: "bunx", args: ["--flag"], agents: ["claude", "claude"] },
      }),
    );
    const entry = (result as Record<string, { agents: string[]; args?: string[] }>)?.["wf"];
    expect(entry?.agents).toEqual(["claude"]);
    expect(entry?.args).toEqual(["--flag"]);
  });
});
