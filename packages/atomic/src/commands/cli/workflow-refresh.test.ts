/**
 * Unit tests for `atomic workflow refresh`.
 *
 * The command is a thin renderer over `bootstrapCustomWorkflows()`.  These
 * tests inject a fake bootstrap result so we don't spawn real subprocesses,
 * and assert:
 *   - format auto-detection (ATOMIC_AGENT → json, otherwise → text)
 *   - explicit `--format` overrides
 *   - exit-code rules (loaded vs broken vs all-broken vs bootstrap-throws)
 *   - JSON payload shape (the LM-facing contract)
 *   - text output line shape (each diagnostic field on its own `key · value` line)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  workflowRefreshCommand,
  defaultDeps as refreshDefaultDeps,
  type WorkflowRefreshDeps,
  type RefreshJsonPayload,
} from "./workflow-refresh.ts";
import type { BootstrapResult, LoadedWorkflow } from "../custom-workflows.ts";
import type { AgentType, BrokenWorkflow, ExternalWorkflow } from "@bastani/atomic-sdk";
import { createBuiltinRegistry } from "../builtin-registry.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function loaded(
  alias: string,
  origin: "local" | "global",
  agent: AgentType,
  name = alias,
): LoadedWorkflow {
  const wf: ExternalWorkflow = {
    kind: "external",
    name,
    agent,
    description: `desc for ${name}`,
    inputs: [
      { name: "target", type: "text", required: true, description: "the target" },
    ],
    source: { command: "bunx", args: [`./.atomic/workflows/${alias}/index.ts`] },
  };
  return { alias, origin, workflow: wf };
}

function broken(
  alias: string,
  origin: "local" | "global",
  agents: AgentType[],
  source: string,
): BrokenWorkflow {
  return {
    alias,
    origin,
    agents,
    reason: `"${alias}": metadata emission timed out`,
    fix: `add 'await hostLocalWorkflows([wf])' after .compile() in ${alias}`,
    source,
  };
}

function fakeBootstrapResult(opts: {
  loaded?: LoadedWorkflow[];
  broken?: BrokenWorkflow[];
  globalPath?: string;
  localPath?: string;
}): BootstrapResult {
  const brokenList = opts.broken ?? [];
  const brokenIndex = new Map<string, BrokenWorkflow>();
  for (const b of brokenList) {
    for (const a of b.agents) brokenIndex.set(`${a}/${b.alias}`, b);
  }
  return {
    registry: createBuiltinRegistry(),
    brokenList,
    brokenIndex,
    summary: null,
    loaded: opts.loaded ?? [],
    paths: {
      global: opts.globalPath ?? "/home/u/.atomic/settings.json",
      local: opts.localPath ?? "/work/proj/.atomic/settings.json",
    },
  };
}

// ─── Output capture ──────────────────────────────────────────────────────────

interface Captured {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureOutput(): Captured {
  const c: Captured = { stdout: "", stderr: "", restore: () => {} };
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    c.stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    c.stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  c.restore = () => {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  };
  return c;
}

// ─── Color disable so text-mode assertions stay simple ───────────────────────

let originalNoColor: string | undefined;
beforeAll(() => {
  originalNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
});
afterAll(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
});

// ─── Dep factory ─────────────────────────────────────────────────────────────

function makeDeps(
  result: BootstrapResult | (() => Promise<BootstrapResult>),
  envOverrides: Record<string, string> = {},
): WorkflowRefreshDeps {
  const bootstrapFn = typeof result === "function"
    ? result
    : () => Promise.resolve(result);
  return {
    bootstrap: bootstrapFn,
    rebuild: () => {},
    cwd: () => "/work/proj",
    env: (name) => envOverrides[name],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

let captured: Captured;
beforeEach(() => { captured = captureOutput(); });
afterEach(() => { captured.restore(); });

describe("workflowRefreshCommand — JSON payload", () => {
  test("loaded entries shape: alias, origin, name, agent, inputs, command, settingsKey, settingsPath", async () => {
    const result = fakeBootstrapResult({
      loaded: [loaded("pr-review", "local", "claude")],
    });
    const exitCode = await workflowRefreshCommand({ format: "json" }, makeDeps(result));
    expect(exitCode).toBe(0);

    const payload: RefreshJsonPayload = JSON.parse(captured.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.counts).toEqual({ loaded: 1, broken: 0 });
    expect(payload.loaded).toHaveLength(1);

    const entry = payload.loaded[0]!;
    expect(entry.alias).toBe("pr-review");
    expect(entry.origin).toBe("local");
    expect(entry.name).toBe("pr-review");
    expect(entry.agent).toBe("claude");
    expect(entry.command).toBe("bunx");
    expect(entry.args).toEqual(["./.atomic/workflows/pr-review/index.ts"]);
    expect(entry.settingsKey).toBe("workflows.pr-review");
    expect(entry.settingsPath).toBe("/work/proj/.atomic/settings.json");
    expect(entry.inputs).toHaveLength(1);
  });

  test("broken entry includes reason / fix / settingsKey / settingsPath / agents", async () => {
    const b = broken("stale-flow", "local", ["claude"], "/work/proj/.atomic/settings.json");
    const result = fakeBootstrapResult({ broken: [b] });
    await workflowRefreshCommand({ format: "json" }, makeDeps(result));

    const payload: RefreshJsonPayload = JSON.parse(captured.stdout);
    expect(payload.broken).toHaveLength(1);
    const entry = payload.broken[0]!;
    expect(entry.alias).toBe("stale-flow");
    expect(entry.origin).toBe("local");
    expect(entry.agents).toEqual(["claude"]);
    expect(entry.reason).toBe(b.reason);
    expect(entry.fix).toBe(b.fix);
    expect(entry.settingsKey).toBe("workflows.stale-flow");
    expect(entry.settingsPath).toBe("/work/proj/.atomic/settings.json");
  });

  test("loaded settingsPath uses global path for global-origin entries", async () => {
    const result = fakeBootstrapResult({
      loaded: [loaded("g-flow", "global", "copilot")],
      globalPath: "/home/u/.atomic/settings.json",
    });
    await workflowRefreshCommand({ format: "json" }, makeDeps(result));
    const payload: RefreshJsonPayload = JSON.parse(captured.stdout);
    expect(payload.loaded[0]!.settingsPath).toBe("/home/u/.atomic/settings.json");
  });
});

describe("workflowRefreshCommand — exit codes", () => {
  test("ok=true and exit 0 when only loaded entries", async () => {
    const result = fakeBootstrapResult({
      loaded: [loaded("a", "local", "claude")],
    });
    const exitCode = await workflowRefreshCommand({ format: "json" }, makeDeps(result));
    expect(exitCode).toBe(0);
    const payload: RefreshJsonPayload = JSON.parse(captured.stdout);
    expect(payload.ok).toBe(true);
  });

  test("ok=true and exit 0 when partial: some loaded + some broken", async () => {
    const result = fakeBootstrapResult({
      loaded: [loaded("a", "local", "claude")],
      broken: [broken("b", "local", ["claude"], "/x")],
    });
    const exitCode = await workflowRefreshCommand({ format: "json" }, makeDeps(result));
    // Partial success — model can still act on `a`; `b` is surfaced as a warning.
    expect(exitCode).toBe(0);
    const payload: RefreshJsonPayload = JSON.parse(captured.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.counts).toEqual({ loaded: 1, broken: 1 });
  });

  test("ok=false and exit 1 when ALL broken", async () => {
    const result = fakeBootstrapResult({
      broken: [broken("b", "local", ["claude"], "/x")],
    });
    const exitCode = await workflowRefreshCommand({ format: "json" }, makeDeps(result));
    expect(exitCode).toBe(1);
    const payload: RefreshJsonPayload = JSON.parse(captured.stdout);
    expect(payload.ok).toBe(false);
  });

  test("ok=true and exit 0 when settings.json has no workflows (empty result)", async () => {
    const result = fakeBootstrapResult({});
    const exitCode = await workflowRefreshCommand({ format: "json" }, makeDeps(result));
    expect(exitCode).toBe(0);
    const payload: RefreshJsonPayload = JSON.parse(captured.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.counts).toEqual({ loaded: 0, broken: 0 });
  });

  test("exit 1 and JSON error envelope when bootstrap throws", async () => {
    const deps = makeDeps(() => Promise.reject(new Error("settings.json is malformed")));
    const exitCode = await workflowRefreshCommand({ format: "json" }, deps);
    expect(exitCode).toBe(1);
    const payload = JSON.parse(captured.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("settings.json is malformed");
  });

  test("exit 1 and stderr message when bootstrap throws (text format)", async () => {
    const deps = makeDeps(() => Promise.reject(new Error("settings.json is malformed")));
    const exitCode = await workflowRefreshCommand({ format: "text" }, deps);
    expect(exitCode).toBe(1);
    expect(captured.stderr).toContain("failed to read settings");
    expect(captured.stderr).toContain("settings.json is malformed");
    // stdout should be untouched in text-error mode (errors go to stderr).
    expect(captured.stdout).toBe("");
  });

  test("non-Error thrown values are coerced to strings", async () => {
    // eslint-disable-next-line prefer-promise-reject-errors
    const deps = makeDeps(() => Promise.reject("string-only failure"));
    const exitCode = await workflowRefreshCommand({ format: "json" }, deps);
    expect(exitCode).toBe(1);
    const payload = JSON.parse(captured.stdout);
    expect(payload.error).toContain("string-only failure");
  });
});

describe("workflowRefreshCommand — format resolution", () => {
  test("ATOMIC_AGENT in env auto-defaults to json (no explicit --format)", async () => {
    const result = fakeBootstrapResult({
      loaded: [loaded("a", "local", "claude")],
    });
    const deps = makeDeps(result, { ATOMIC_AGENT: "claude" });
    await workflowRefreshCommand({}, deps);
    // JSON output is parseable; text output has a "Reloaded" header line.
    expect(() => JSON.parse(captured.stdout)).not.toThrow();
  });

  test("no ATOMIC_AGENT defaults to text", async () => {
    const result = fakeBootstrapResult({
      loaded: [loaded("a", "local", "claude")],
    });
    await workflowRefreshCommand({}, makeDeps(result));
    expect(captured.stdout).toContain("Reloaded 1 workflow(s)");
    expect(() => JSON.parse(captured.stdout)).toThrow();
  });

  test("explicit --format=text wins over ATOMIC_AGENT", async () => {
    const result = fakeBootstrapResult({
      loaded: [loaded("a", "local", "claude")],
    });
    const deps = makeDeps(result, { ATOMIC_AGENT: "claude" });
    await workflowRefreshCommand({ format: "text" }, deps);
    expect(captured.stdout).toContain("Reloaded 1 workflow(s)");
  });

  test("explicit --format=json wins when no ATOMIC_AGENT set", async () => {
    const result = fakeBootstrapResult({
      loaded: [loaded("a", "local", "claude")],
    });
    await workflowRefreshCommand({ format: "json" }, makeDeps(result));
    expect(() => JSON.parse(captured.stdout)).not.toThrow();
  });
});

describe("workflowRefreshCommand — text output (LM-scrapeable lines)", () => {
  test("each broken-entry diagnostic sits on its own `key · value` line", async () => {
    const b = broken("stale-flow", "local", ["claude"], "/work/proj/.atomic/settings.json");
    const result = fakeBootstrapResult({ broken: [b] });
    await workflowRefreshCommand({ format: "text" }, makeDeps(result));

    // Each field is on its own line so an LM screen-scraping the output can
    // match `^    reason · ` etc. without prose parsing.
    expect(captured.stdout).toMatch(/reason\s+·\s+"stale-flow": metadata emission timed out/);
    expect(captured.stdout).toMatch(/fix\s+·\s+add 'await hostLocalWorkflows/);
    expect(captured.stdout).toMatch(/settings\s+·\s+\/work\/proj\/.atomic\/settings.json \(workflows\.stale-flow\)/);
  });

  test("loaded-entry detail includes alias, name, agent, command, settings line", async () => {
    const result = fakeBootstrapResult({
      loaded: [loaded("pr-review", "local", "claude")],
    });
    await workflowRefreshCommand({ format: "text" }, makeDeps(result));
    expect(captured.stdout).toContain("pr-review");
    expect(captured.stdout).toMatch(/name\s+·\s+pr-review/);
    expect(captured.stdout).toMatch(/agent\s+·\s+claude/);
    expect(captured.stdout).toMatch(/command\s+·\s+bunx \.\/\.atomic\/workflows\/pr-review\/index\.ts/);
    expect(captured.stdout).toMatch(/settings\s+·\s+\/work\/proj\/.atomic\/settings.json \(workflows\.pr-review\)/);
  });

  test("empty state names both candidate settings paths", async () => {
    const result = fakeBootstrapResult({});
    await workflowRefreshCommand({ format: "text" }, makeDeps(result));
    expect(captured.stdout).toContain("/work/proj/.atomic/settings.json");
    expect(captured.stdout).toContain("/home/u/.atomic/settings.json");
  });
});

describe("defaultDeps", () => {
  test("cwd() returns process.cwd()", () => {
    expect(refreshDefaultDeps.cwd()).toBe(process.cwd());
  });

  test("env(name) reads from process.env", () => {
    const original = process.env.ATOMIC_REFRESH_DEPS_TEST;
    process.env.ATOMIC_REFRESH_DEPS_TEST = "ok";
    try {
      expect(refreshDefaultDeps.env("ATOMIC_REFRESH_DEPS_TEST")).toBe("ok");
    } finally {
      if (original === undefined) delete process.env.ATOMIC_REFRESH_DEPS_TEST;
      else process.env.ATOMIC_REFRESH_DEPS_TEST = original;
    }
  });
});

describe("workflowRefreshCommand — registry hot-swap", () => {
  test("calls deps.rebuild with the merged registry + brokenIndex + brokenList", async () => {
    const calls: Parameters<WorkflowRefreshDeps["rebuild"]>[] = [];
    const rebuild: WorkflowRefreshDeps["rebuild"] = (registry, brokenIndex, brokenList) => {
      calls.push([registry, brokenIndex, brokenList]);
    };
    const b = broken("b", "local", ["claude"], "/x");
    const result = fakeBootstrapResult({
      loaded: [loaded("a", "local", "claude")],
      broken: [b],
    });
    const deps: WorkflowRefreshDeps = {
      bootstrap: () => Promise.resolve(result),
      rebuild,
      cwd: () => "/work/proj",
      env: () => undefined,
    };
    await workflowRefreshCommand({ format: "json" }, deps);

    expect(calls).toHaveLength(1);
    const args = calls[0]!;
    expect(args[0]).toBe(result.registry);
    expect(args[1]).toBe(result.brokenIndex);
    expect(args[2]).toBe(result.brokenList);
  });
});
