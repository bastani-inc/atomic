/**
 * Unit tests for loadCustomWorkflows().
 *
 * Strategy: real Bun.spawn against shell-script and bun-script fixtures
 * created in a temp directory. Each fixture models a specific failure
 * or success mode from spec §5.8.
 *
 * Captured stderr is checked for the exact §5.8 diagnostic strings.
 * BrokenWorkflow entries are checked for correct shape / reason field.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadCustomWorkflows, mergeIntoRegistry } from "./custom-workflows.ts";
import type { LoadCustomWorkflowsResult, BrokenWorkflow } from "./custom-workflows.ts";
import { createBuiltinRegistry } from "./builtin-registry.ts";
import type { ExternalWorkflow } from "@bastani/atomic-sdk";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Fixture directory ────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "atomic-cwf-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const SETTINGS_PATH = "/fake/settings.json";

/**
 * Write a shell script to tmpDir, make it executable, and return its path.
 */
async function mkScript(name: string, body: string): Promise<string> {
  const p = join(tmpDir, name);
  await writeFile(p, `#!/usr/bin/env sh\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

/**
 * Write a bun script to tmpDir and return a `bun <path>` invocation pair.
 */
async function mkBunScript(name: string, body: string): Promise<{ command: string; args: string[] }> {
  const p = join(tmpDir, name);
  await writeFile(p, body);
  return { command: "bun", args: [p] };
}

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("loadCustomWorkflows — happy path", () => {
  test("well-formed entry returns loaded with correct ExternalWorkflow shape", async () => {
    const meta = JSON.stringify([
      {
        name: "my-wf",
        description: "Does stuff",
        agent: "claude",
        inputs: [{ name: "prompt", type: "string" }],
        source: "/some/file.ts",
        minSDKVersion: null,
      },
    ]);

    const { command, args } = await mkBunScript("happy.ts", `
const token = process.env.ATOMIC_DISPATCH_TOKEN;
const argv = process.argv;
if (argv.includes("_emit-workflow-meta") && process.env.ATOMIC_HOST === "1" && token) {
  process.stdout.write("ATOMIC_WORKFLOW_META: ${meta.replace(/"/g, '\\"')}\\n");
  process.exit(0);
}
process.exit(1);
`);

    const cap = captureStderr();
    let result: LoadCustomWorkflowsResult;
    try {
      result = await loadCustomWorkflows(
        { "my-alias": { command, args, agents: ["claude"] } },
        "local",
        SETTINGS_PATH,
      );
    } finally {
      cap.restore();
    }

    expect(result.loaded).toHaveLength(1);
    expect(result.broken).toHaveLength(0);

    const lw = result.loaded[0]!;
    expect(lw.alias).toBe("my-alias");
    expect(lw.origin).toBe("local");
    expect(lw.workflow.kind).toBe("external");
    expect(lw.workflow.name).toBe("my-wf");
    expect(lw.workflow.agent).toBe("claude");
    expect(lw.workflow.description).toBe("Does stuff");
    expect(lw.workflow.inputs).toEqual([{ name: "prompt", type: "string" }]);
    expect(lw.workflow.source).toEqual({ command, args });
    expect(cap.stderr).toBe("");
  });
});

// ─── Failure modes ────────────────────────────────────────────────────────────

describe("loadCustomWorkflows — command not found", () => {
  test("emits §5.8 not-found message and records BrokenWorkflow", async () => {
    const cap = captureStderr();
    let result: LoadCustomWorkflowsResult;
    try {
      result = await loadCustomWorkflows(
        { "missing-cmd": { command: "__atomic_no_such_binary_xyz__", agents: ["claude"] } },
        "global",
        SETTINGS_PATH,
      );
    } finally {
      cap.restore();
    }

    expect(result.loaded).toHaveLength(0);
    expect(result.broken).toHaveLength(1);
    expect(cap.stderr).toContain(
      `"missing-cmd": command "__atomic_no_such_binary_xyz__" not found on PATH; install it or use an absolute path`,
    );
    const bw = result.broken[0]!;
    expect(bw.alias).toBe("missing-cmd");
    expect(bw.origin).toBe("global");
    expect(bw.agents).toEqual(["claude"]);
    expect(bw.source).toBe(SETTINGS_PATH);
    expect(bw.reason).toContain("not found on PATH");
  });
});

describe("loadCustomWorkflows — non-zero exit", () => {
  test("emits §5.8 exit-code message and records BrokenWorkflow", async () => {
    const scriptPath = await mkScript("exit1.sh", `
echo "some error" >&2
exit 42
`);

    const cap = captureStderr();
    let result: LoadCustomWorkflowsResult;
    try {
      result = await loadCustomWorkflows(
        { "exit-fail": { command: scriptPath, agents: ["claude"] } },
        "local",
        SETTINGS_PATH,
      );
    } finally {
      cap.restore();
    }

    expect(result.loaded).toHaveLength(0);
    expect(result.broken).toHaveLength(1);
    expect(cap.stderr).toContain(`"exit-fail"`);
    expect(cap.stderr).toContain("exited 42");
    expect(cap.stderr).toContain("some error");
    const bw = result.broken[0]!;
    expect(bw.reason).toContain("exited 42");
  });
});

describe("loadCustomWorkflows — missing ATOMIC_WORKFLOW_META line", () => {
  test("emits §5.8 missing-meta message and records BrokenWorkflow", async () => {
    const scriptPath = await mkScript("no-meta.sh", `
echo "hello world"
exit 0
`);

    const cap = captureStderr();
    let result: LoadCustomWorkflowsResult;
    try {
      result = await loadCustomWorkflows(
        { "no-meta": { command: scriptPath, agents: ["claude"] } },
        "local",
        SETTINGS_PATH,
      );
    } finally {
      cap.restore();
    }

    expect(result.loaded).toHaveLength(0);
    expect(result.broken).toHaveLength(1);
    expect(cap.stderr).toContain("expected ATOMIC_WORKFLOW_META line");
    expect(cap.stderr).toContain("hostLocalWorkflows");
    expect(cap.stderr).toContain("await hostLocalWorkflows([wf])");
    expect(result.broken[0]!.reason).toContain("expected ATOMIC_WORKFLOW_META line");
    expect(result.broken[0]!.reason).toContain("await hostLocalWorkflows([wf])");
    expect(result.broken[0]!.fix).toContain("await hostLocalWorkflows([wf])");
  });
});

describe("loadCustomWorkflows — malformed JSON", () => {
  test("emits parse-error with offending substring and records BrokenWorkflow", async () => {
    const scriptPath = await mkScript("bad-json.sh", `
printf 'ATOMIC_WORKFLOW_META: {bad json here}\\n'
exit 0
`);

    const cap = captureStderr();
    let result: LoadCustomWorkflowsResult;
    try {
      result = await loadCustomWorkflows(
        { "bad-json": { command: scriptPath, agents: ["claude"] } },
        "local",
        SETTINGS_PATH,
      );
    } finally {
      cap.restore();
    }

    expect(result.loaded).toHaveLength(0);
    expect(result.broken).toHaveLength(1);
    expect(cap.stderr).toContain('"bad-json"');
    expect(cap.stderr).toContain("failed to parse ATOMIC_WORKFLOW_META JSON");
    expect(cap.stderr).toContain("{bad json here}");
    expect(result.broken[0]!.reason).toContain("failed to parse");
  });
});

describe("loadCustomWorkflows — timeout", () => {
  test("kills child, emits timeout message, records BrokenWorkflow", async () => {
    // Use a bun script that busy-loops so the process is the direct child
    // (no fork/exec child that outlives the parent and keeps the pipe open).
    const { command, args } = await mkBunScript("sleeper.ts", `
// Never exits — simulates a CLI that hangs instead of emitting metadata.
await new Promise(() => {});
`);

    const origTimeout = process.env.ATOMIC_WORKFLOWS_META_TIMEOUT_MS;
    process.env.ATOMIC_WORKFLOWS_META_TIMEOUT_MS = "300";

    const cap = captureStderr();
    let result: LoadCustomWorkflowsResult;
    try {
      result = await loadCustomWorkflows(
        { "slow-cmd": { command, args, agents: ["claude"] } },
        "local",
        SETTINGS_PATH,
      );
    } finally {
      cap.restore();
      if (origTimeout === undefined) delete process.env.ATOMIC_WORKFLOWS_META_TIMEOUT_MS;
      else process.env.ATOMIC_WORKFLOWS_META_TIMEOUT_MS = origTimeout;
    }

    expect(result.loaded).toHaveLength(0);
    expect(result.broken).toHaveLength(1);
    expect(cap.stderr).toContain("metadata emission timed out after 300ms");
    expect(cap.stderr).toContain("hostLocalWorkflows");
    expect(result.broken[0]!.reason).toContain("timed out after 300ms");
    expect(result.broken[0]!.reason).toContain("hostLocalWorkflows");
    expect(result.broken[0]!.fix).toContain("await hostLocalWorkflows([wf])");
  }, 15000);
});

describe("loadCustomWorkflows — declared agent missing in meta", () => {
  test("skips only missing agent, registers present agent, records one BrokenWorkflow", async () => {
    const meta = JSON.stringify([
      {
        name: "my-wf",
        description: "Claude only",
        agent: "claude",
        inputs: [],
        source: "/file.ts",
        minSDKVersion: null,
      },
    ]);

    const { command, args } = await mkBunScript("partial-agents.ts", `
const token = process.env.ATOMIC_DISPATCH_TOKEN;
if (process.argv.includes("_emit-workflow-meta") && process.env.ATOMIC_HOST === "1" && token) {
  process.stdout.write('ATOMIC_WORKFLOW_META: ${meta.replace(/'/g, "\\'")}\\n');
  process.exit(0);
}
process.exit(1);
`);

    const cap = captureStderr();
    let result: LoadCustomWorkflowsResult;
    try {
      result = await loadCustomWorkflows(
        { "partial": { command, args, agents: ["claude", "opencode"] } },
        "local",
        SETTINGS_PATH,
      );
    } finally {
      cap.restore();
    }

    // claude should be loaded, opencode should be broken
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]!.workflow.agent).toBe("claude");

    expect(result.broken).toHaveLength(1);
    expect(result.broken[0]!.agents).toEqual(["opencode"]);
    expect(cap.stderr).toContain(
      `"partial/opencode": command did not register a workflow for agent "opencode"`,
    );
  });
});

describe("loadCustomWorkflows — undefined workflows", () => {
  test("returns empty result without spawning anything", async () => {
    const result = await loadCustomWorkflows(undefined, "local", SETTINGS_PATH);
    expect(result.loaded).toHaveLength(0);
    expect(result.broken).toHaveLength(0);
  });
});

describe("loadCustomWorkflows — Promise.all parallelism", () => {
  test("loads multiple entries concurrently", async () => {
    const makeMeta = (agent: string, name: string) =>
      JSON.stringify([{ name, description: "", agent, inputs: [], source: "/f.ts", minSDKVersion: null }]);

    const { command: cmd1, args: args1 } = await mkBunScript("parallel1.ts", `
if (process.argv.includes("_emit-workflow-meta") && process.env.ATOMIC_HOST === "1") {
  process.stdout.write('ATOMIC_WORKFLOW_META: ${makeMeta("claude", "wf-a").replace(/'/g, "\\'")}\\n');
  process.exit(0);
}
process.exit(1);
`);

    const { command: cmd2, args: args2 } = await mkBunScript("parallel2.ts", `
if (process.argv.includes("_emit-workflow-meta") && process.env.ATOMIC_HOST === "1") {
  process.stdout.write('ATOMIC_WORKFLOW_META: ${makeMeta("opencode", "wf-b").replace(/'/g, "\\'")}\\n');
  process.exit(0);
}
process.exit(1);
`);

    const cap = captureStderr();
    let result: LoadCustomWorkflowsResult;
    try {
      result = await loadCustomWorkflows(
        {
          "alias-a": { command: cmd1, args: args1, agents: ["claude"] },
          "alias-b": { command: cmd2, args: args2, agents: ["opencode"] },
        },
        "local",
        SETTINGS_PATH,
      );
    } finally {
      cap.restore();
    }

    expect(result.loaded).toHaveLength(2);
    expect(result.broken).toHaveLength(0);
    const names = result.loaded.map((l) => l.workflow.name).sort();
    expect(names).toEqual(["wf-a", "wf-b"]);
  });
});

// ─── Array.isArray guard ──────────────────────────────────────────────────────

describe("loadCustomWorkflows — non-array ATOMIC_WORKFLOW_META payload", () => {
  test("object payload → BrokenWorkflow with 'must be a JSON array (got object)'", async () => {
    const scriptPath = await mkScript("object-meta.sh", `
printf 'ATOMIC_WORKFLOW_META: {"name":"foo"}\\n'
exit 0
`);

    const cap = captureStderr();
    let result: LoadCustomWorkflowsResult;
    try {
      result = await loadCustomWorkflows(
        { "obj-alias": { command: scriptPath, agents: ["claude"] } },
        "local",
        SETTINGS_PATH,
      );
    } finally {
      cap.restore();
    }

    expect(result.loaded).toHaveLength(0);
    expect(result.broken).toHaveLength(1);
    expect(cap.stderr).toContain("must be a JSON array (got object)");
    expect(result.broken[0]!.reason).toContain("must be a JSON array (got object)");
  });

  test("null payload → BrokenWorkflow with 'must be a JSON array (got null)'", async () => {
    const scriptPath = await mkScript("null-meta.sh", `
printf 'ATOMIC_WORKFLOW_META: null\\n'
exit 0
`);

    const cap = captureStderr();
    let result: LoadCustomWorkflowsResult;
    try {
      result = await loadCustomWorkflows(
        { "null-alias": { command: scriptPath, agents: ["claude"] } },
        "local",
        SETTINGS_PATH,
      );
    } finally {
      cap.restore();
    }

    expect(result.loaded).toHaveLength(0);
    expect(result.broken).toHaveLength(1);
    expect(cap.stderr).toContain("must be a JSON array (got null)");
    expect(result.broken[0]!.reason).toContain("must be a JSON array (got null)");
  });
});

// ─── mergeIntoRegistry ────────────────────────────────────────────────────────

function makeExternalWorkflow(name: string, agent: "claude" | "opencode" | "copilot" = "claude"): ExternalWorkflow {
  return {
    kind: "external",
    name,
    agent,
    description: `desc-${name}`,
    inputs: [],
    source: { command: "fake-cmd", args: [] },
  };
}

function emptyResult(): LoadCustomWorkflowsResult {
  return { loaded: [], broken: [] };
}

function loadedResult(wf: ExternalWorkflow, alias = wf.name): LoadCustomWorkflowsResult {
  return { loaded: [{ alias, origin: "global", workflow: wf }], broken: [] };
}

function brokenResult(b: BrokenWorkflow): LoadCustomWorkflowsResult {
  return { loaded: [], broken: [b] };
}

describe("mergeIntoRegistry — no custom workflows", () => {
  test("builtin only → no overrides, no broken, null summary", () => {
    const builtin = createBuiltinRegistry();
    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, emptyResult(), emptyResult());
    } finally {
      cap.restore();
    }
    expect(cap.stderr).toBe("");
    expect(result.brokenList).toHaveLength(0);
    expect(result.brokenIndex.size).toBe(0);
    expect(result.summary).toBeNull();
  });
});

describe("mergeIntoRegistry — global entry, no prior key", () => {
  test("upserts without firing onOverride", () => {
    const builtin = createBuiltinRegistry();
    const wf = makeExternalWorkflow("totally-unique-global-wf", "claude");
    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, loadedResult(wf), emptyResult());
    } finally {
      cap.restore();
    }
    expect(cap.stderr).toBe("");
    expect(result.brokenList).toHaveLength(0);
    expect(result.registry.has("claude/totally-unique-global-wf")).toBe(true);
    expect(result.summary).toBe("[atomic/workflows] loaded 1 custom workflow(s)");
  });

  test("global broken entry → brokenList has entry, brokenIndex keys declared agents", () => {
    const builtin = createBuiltinRegistry();
    const broken: BrokenWorkflow = {
      alias: "global-bad-wf",
      origin: "global",
      agents: ["claude", "opencode"],
      reason: "test reason",
      source: SETTINGS_PATH,
      fix: "test fix",
    };
    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, brokenResult(broken), emptyResult());
    } finally {
      cap.restore();
    }
    expect(result.brokenList).toHaveLength(1);
    expect(result.brokenList[0]).toEqual(broken);
    expect(result.brokenIndex.has("claude/global-bad-wf")).toBe(true);
    expect(result.brokenIndex.has("opencode/global-bad-wf")).toBe(true);
  });
});

describe("mergeIntoRegistry — local shadows global same key", () => {
  test("override callback fires with (local) label", () => {
    const builtin = createBuiltinRegistry();
    const globalWf = makeExternalWorkflow("shadow-wf", "claude");
    const localWf = makeExternalWorkflow("shadow-wf", "claude");
    const globalRes: LoadCustomWorkflowsResult = {
      loaded: [{ alias: "shadow-wf", origin: "global", workflow: globalWf }],
      broken: [],
    };
    const localRes: LoadCustomWorkflowsResult = {
      loaded: [{ alias: "shadow-wf", origin: "local", workflow: localWf }],
      broken: [],
    };

    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, globalRes, localRes);
    } finally {
      cap.restore();
    }

    expect(cap.stderr).toContain("[atomic/workflows] override: shadow-wf/claude (local) > external");
    expect(result.brokenList).toHaveLength(0);
    expect(result.summary).toBe("[atomic/workflows] loaded 2 custom workflow(s)");
  });

  test("brokenList composition reflects merged global+local broken sources", () => {
    const builtin = createBuiltinRegistry();
    const globalBroken: BrokenWorkflow = {
      alias: "global-broken",
      origin: "global",
      agents: ["claude"],
      reason: "global reason",
      source: SETTINGS_PATH,
      fix: "global fix",
    };
    const localBroken: BrokenWorkflow = {
      alias: "local-broken",
      origin: "local",
      agents: ["opencode"],
      reason: "local reason",
      source: SETTINGS_PATH,
      fix: "local fix",
    };
    const globalRes: LoadCustomWorkflowsResult = { loaded: [], broken: [globalBroken] };
    const localRes: LoadCustomWorkflowsResult = { loaded: [], broken: [localBroken] };

    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, globalRes, localRes);
    } finally {
      cap.restore();
    }

    expect(result.brokenList).toHaveLength(2);
    // brokenList entries are new objects (map+filter produces copies), so use toEqual.
    expect(result.brokenList[0]).toEqual(globalBroken);
    expect(result.brokenList[1]).toEqual(localBroken);
  });
});

describe("mergeIntoRegistry — brokenIndex keyed correctly", () => {
  test("multiple agents → separate keys per agent", () => {
    const builtin = createBuiltinRegistry();
    const broken: BrokenWorkflow = {
      alias: "bad-wf",
      origin: "global",
      agents: ["claude", "opencode"],
      reason: "test failure",
      source: SETTINGS_PATH,
      fix: "fix it",
    };
    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, brokenResult(broken), emptyResult());
    } finally {
      cap.restore();
    }

    expect(result.brokenIndex.has("claude/bad-wf")).toBe(true);
    expect(result.brokenIndex.has("opencode/bad-wf")).toBe(true);
    expect(result.brokenIndex.get("claude/bad-wf")).toBe(broken);
    expect(result.brokenIndex.get("opencode/bad-wf")).toBe(broken);
  });
});

describe("mergeIntoRegistry — multi-agent broken entry brokenList dedup", () => {
  test("one alias with two agents → brokenList has 1 entry, brokenIndex has 2 keys", () => {
    const builtin = createBuiltinRegistry();
    const broken: BrokenWorkflow = {
      alias: "demo",
      origin: "local",
      agents: ["claude", "opencode"],
      reason: "x",
      source: "y",
      fix: "z",
    };
    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, emptyResult(), brokenResult(broken));
    } finally {
      cap.restore();
    }

    expect(result.brokenList).toHaveLength(1);
    expect(result.brokenIndex.size).toBe(2);
    expect(result.brokenIndex.has("claude/demo")).toBe(true);
    expect(result.brokenIndex.has("opencode/demo")).toBe(true);
  });
});

describe("mergeIntoRegistry — summary counts unique broken aliases not agent fan-out", () => {
  test("one alias with two agents → summary says '1 skipped' not '2 skipped'", () => {
    const builtin = createBuiltinRegistry();
    const broken: BrokenWorkflow = {
      alias: "fan-out-wf",
      origin: "local",
      agents: ["claude", "opencode"],
      reason: "reason",
      source: SETTINGS_PATH,
      fix: "fix",
    };
    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, emptyResult(), brokenResult(broken));
    } finally {
      cap.restore();
    }

    // brokenList.length = 1 alias; brokenIndex.size = 2 (one per agent)
    expect(result.summary).toContain("1 skipped");
    expect(result.summary).not.toContain("2 skipped");
  });
});

describe("mergeIntoRegistry — §5.7.4+§8.3 healthy-override subtraction", () => {
  test("global broken + local healthy same alias/agent: registry resolves local, brokenIndex has no entry", () => {
    const builtin = createBuiltinRegistry();

    const globalBroken: BrokenWorkflow = {
      alias: "Z",
      origin: "global",
      agents: ["claude"],
      reason: "global command not found",
      source: SETTINGS_PATH,
      fix: "install it",
    };

    const localWf = makeExternalWorkflow("Z", "claude");
    const globalRes: LoadCustomWorkflowsResult = { loaded: [], broken: [globalBroken] };
    const localRes: LoadCustomWorkflowsResult = {
      loaded: [{ alias: "Z", origin: "local", workflow: localWf }],
      broken: [],
    };

    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, globalRes, localRes);
    } finally {
      cap.restore();
    }

    // (a) registry resolves the local healthy entry
    const resolved = result.registry.resolve("Z", "claude");
    expect(resolved).toBeDefined();
    expect(resolved).toBe(localWf);

    // (b) brokenIndex does NOT key "claude/Z" — subtraction kicked in
    expect(result.brokenIndex.get("claude/Z")).toBeUndefined();

    // (c) brokenList excludes fully-shadowed entries (RFC §5.7 filteredBrokenList).
    //     All (alias, agent) pairs for globalBroken are covered by the healthy
    //     local override, so the entry is removed from brokenList entirely.
    expect(result.brokenList).toHaveLength(0);
  });
});

describe("mergeIntoRegistry — §8.3 alias-vs-name divergence", () => {
  test("local healthy alias overrides global broken even when workflow.name differs from alias", () => {
    const builtin = createBuiltinRegistry();

    const globalBroken: BrokenWorkflow = {
      alias: "X",
      origin: "global",
      agents: ["claude"],
      reason: "command not found",
      source: SETTINGS_PATH,
      fix: "install it",
    };

    // workflow.name differs from alias ("X-impl" vs "X")
    const localWf = makeExternalWorkflow("X-impl", "claude");
    const globalRes: LoadCustomWorkflowsResult = { loaded: [], broken: [globalBroken] };
    const localRes: LoadCustomWorkflowsResult = {
      loaded: [{ alias: "X", origin: "local", workflow: localWf }],
      broken: [],
    };

    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, globalRes, localRes);
    } finally {
      cap.restore();
    }

    // brokenIndex must NOT contain "claude/X" — the alias-keyed healthy set subsumed it
    expect(result.brokenIndex.get("claude/X")).toBeUndefined();

    // brokenList must be empty — the sole broken entry is fully shadowed
    expect(result.brokenList).toHaveLength(0);

    // registry resolves the local healthy entry by workflow.name
    const resolved = result.registry.resolve("X-impl", "claude");
    expect(resolved).toBeDefined();
    expect(resolved).toBe(localWf);
  });
});

describe("mergeIntoRegistry — §8.3 partial-agent shadow", () => {
  test("local healthy for claude only: claude/X removed from brokenIndex, copilot/X retained", () => {
    const builtin = createBuiltinRegistry();

    const globalBroken: BrokenWorkflow = {
      alias: "X",
      origin: "global",
      agents: ["claude", "copilot"],
      reason: "command not found",
      source: SETTINGS_PATH,
      fix: "install it",
    };

    // Only claude is healthy; workflow.name === alias
    const localWf = makeExternalWorkflow("X", "claude");
    const globalRes: LoadCustomWorkflowsResult = { loaded: [], broken: [globalBroken] };
    const localRes: LoadCustomWorkflowsResult = {
      loaded: [{ alias: "X", origin: "local", workflow: localWf }],
      broken: [],
    };

    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, globalRes, localRes);
    } finally {
      cap.restore();
    }

    // claude is healthy → subtracted from brokenIndex
    expect(result.brokenIndex.get("claude/X")).toBeUndefined();

    // copilot is NOT healthy → still in brokenIndex
    expect(result.brokenIndex.get("copilot/X")).toBe(globalBroken);

    // At least one agent (copilot) is un-shadowed → entry survives in brokenList,
    // but the brokenList entry is a NEW object with agents narrowed to only the
    // un-shadowed agents (the fix narrows via map+filter).
    expect(result.brokenList).toHaveLength(1);
    expect(result.brokenList[0]!.alias).toBe(globalBroken.alias);
    expect(result.brokenList[0]!.agents).toEqual(["copilot"]);
    expect(result.brokenList[0]!.reason).toBe(globalBroken.reason);
    expect(result.brokenList[0]!.source).toBe(globalBroken.source);
    expect(result.brokenList[0]!.fix).toBe(globalBroken.fix);
    expect(result.brokenList[0]!.origin).toBe(globalBroken.origin);
  });
});

describe("mergeIntoRegistry — §8.3 brokenList vs brokenIndex consistency invariant", () => {
  test("every brokenList entry appears in brokenIndex and every brokenIndex value appears in brokenList", () => {
    const builtin = createBuiltinRegistry();

    // Multi-alias, multi-agent, partial shadows — non-trivial mix
    const brokenA: BrokenWorkflow = {
      alias: "alpha",
      origin: "global",
      agents: ["claude", "opencode"],
      reason: "reason-A",
      source: SETTINGS_PATH,
      fix: "fix-A",
    };
    const brokenB: BrokenWorkflow = {
      alias: "beta",
      origin: "global",
      agents: ["copilot"],
      reason: "reason-B",
      source: SETTINGS_PATH,
      fix: "fix-B",
    };
    const brokenC: BrokenWorkflow = {
      alias: "gamma",
      origin: "local",
      agents: ["claude", "copilot"],
      reason: "reason-C",
      source: SETTINGS_PATH,
      fix: "fix-C",
    };

    // Healthy local: shadows alpha/opencode (not alpha/claude) and all of gamma
    const wfAlphaOpencode = makeExternalWorkflow("alpha-oc", "opencode");
    const wfGammaClaude = makeExternalWorkflow("gamma", "claude");
    const wfGammaCopilot = makeExternalWorkflow("gamma-cp", "copilot");

    const globalRes: LoadCustomWorkflowsResult = { loaded: [], broken: [brokenA, brokenB] };
    const localRes: LoadCustomWorkflowsResult = {
      loaded: [
        { alias: "alpha", origin: "local", workflow: wfAlphaOpencode },
        { alias: "gamma", origin: "local", workflow: wfGammaClaude },
        { alias: "gamma", origin: "local", workflow: wfGammaCopilot },
      ],
      broken: [brokenC],
    };

    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, globalRes, localRes);
    } finally {
      cap.restore();
    }

    // Invariant 1: every entry in brokenList maps into brokenIndex for at least
    // one (agent, alias) key. brokenList entries are new objects (map+filter),
    // so compare by alias instead of reference equality.
    for (const b of result.brokenList) {
      const mapsIn = b.agents.some((a) => result.brokenIndex.get(`${a}/${b.alias}`)?.alias === b.alias);
      expect(mapsIn).toBe(true);
    }

    // Invariant 2: every value in brokenIndex appears (by alias) in brokenList.
    // brokenIndex still references the original allBroken objects, while
    // brokenList contains new narrowed objects — so check by alias.
    for (const [, b] of result.brokenIndex) {
      expect(result.brokenList.some((x) => x.alias === b.alias)).toBe(true);
    }
  });
});

// ─── Iter-11 regression tests (§5.7.2) ──────────────────────────────────────

describe("mergeIntoRegistry — §5.7.2 broken alias collides with builtin name", () => {
  test("broken alias 'ralph' for claude is filtered because builtin ralph/claude exists", () => {
    const builtin = createBuiltinRegistry();

    // ralph is a known builtin for claude — broken entry should be filtered
    const broken: BrokenWorkflow = {
      alias: "ralph",
      origin: "global",
      agents: ["claude"],
      reason: "command not found",
      source: SETTINGS_PATH,
      fix: "install it",
    };

    const globalRes: LoadCustomWorkflowsResult = { loaded: [], broken: [broken] };
    const localRes: LoadCustomWorkflowsResult = { loaded: [], broken: [] };

    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, globalRes, localRes);
    } finally {
      cap.restore();
    }

    // Builtin collision: brokenIndex must NOT have claude/ralph
    expect(result.brokenIndex.has("claude/ralph")).toBe(false);

    // brokenList must not contain an entry with alias "ralph"
    expect(result.brokenList.some((b) => b.alias === "ralph")).toBe(false);
  });
});

describe("mergeIntoRegistry — §5.7.2 broken alias collides with healthy custom name", () => {
  test("broken alias 'deep-research' is filtered because healthy alt-alias resolves to same name", () => {
    const builtin = createBuiltinRegistry();

    // Broken alias "deep-research" for claude
    const broken: BrokenWorkflow = {
      alias: "deep-research",
      origin: "global",
      agents: ["claude"],
      reason: "command not found",
      source: SETTINGS_PATH,
      fix: "install it",
    };

    // Healthy entry: alias is "alt-alias" but workflow.name === "deep-research"
    const healthyWf = makeExternalWorkflow("deep-research", "claude");

    const globalRes: LoadCustomWorkflowsResult = {
      loaded: [],
      broken: [broken],
    };
    const localRes: LoadCustomWorkflowsResult = {
      loaded: [{ alias: "alt-alias", origin: "local", workflow: healthyWf }],
      broken: [],
    };

    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, globalRes, localRes);
    } finally {
      cap.restore();
    }

    // Healthy compiled name "deep-research" for claude shadows the broken alias
    expect(result.brokenIndex.get("claude/deep-research")).toBeUndefined();
  });
});

describe("mergeIntoRegistry — §5.7.2 broken alias no collision still hard-blocks", () => {
  test("broken alias 'missing-pkg' with no healthy entry remains in brokenIndex and brokenList", () => {
    const builtin = createBuiltinRegistry();

    // Broken alias not matching any builtin or healthy entry
    const broken: BrokenWorkflow = {
      alias: "missing-pkg",
      origin: "global",
      agents: ["claude"],
      reason: "command not found",
      source: SETTINGS_PATH,
      fix: "install it",
    };

    const globalRes: LoadCustomWorkflowsResult = { loaded: [], broken: [broken] };
    const localRes: LoadCustomWorkflowsResult = { loaded: [], broken: [] };

    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, globalRes, localRes);
    } finally {
      cap.restore();
    }

    // No collision — must stay broken
    expect(result.brokenIndex.has("claude/missing-pkg")).toBe(true);
    expect(result.brokenList.some((b) => b.alias === "missing-pkg")).toBe(true);
  });
});

describe("mergeIntoRegistry — §5.7.2 brokenIndex invariant: registry.resolve fails for every key", () => {
  test("every key in brokenIndex has no matching resolve in registry", () => {
    const builtin = createBuiltinRegistry();

    // Mix: some broken, some healthy, some colliding with builtins
    const brokenRalph: BrokenWorkflow = {
      alias: "ralph",
      origin: "global",
      agents: ["claude"],
      reason: "command not found",
      source: SETTINGS_PATH,
      fix: "install it",
    };
    const brokenMissing: BrokenWorkflow = {
      alias: "missing-pkg",
      origin: "global",
      agents: ["claude", "opencode"],
      reason: "command not found",
      source: SETTINGS_PATH,
      fix: "install it",
    };
    const brokenDeep: BrokenWorkflow = {
      alias: "my-custom-broken",
      origin: "local",
      agents: ["copilot"],
      reason: "non-zero exit",
      source: SETTINGS_PATH,
      fix: "fix the script",
    };

    // Healthy entry that does NOT share a name with any broken alias
    const healthyWf = makeExternalWorkflow("healthy-entry", "claude");

    const globalRes: LoadCustomWorkflowsResult = {
      loaded: [],
      broken: [brokenRalph, brokenMissing],
    };
    const localRes: LoadCustomWorkflowsResult = {
      loaded: [{ alias: "healthy-entry", origin: "local", workflow: healthyWf }],
      broken: [brokenDeep],
    };

    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, globalRes, localRes);
    } finally {
      cap.restore();
    }

    // Property invariant: for every key in brokenIndex, registry.resolve returns undefined
    for (const key of result.brokenIndex.keys()) {
      const [agent, ...nameParts] = key.split("/") as [string, ...string[]];
      const name = nameParts.join("/");
      const resolved = result.registry.resolve(name, agent as "claude" | "opencode" | "copilot");
      expect(resolved).toBeUndefined();
    }
  });
});

describe("mergeIntoRegistry — summary formatting", () => {
  test("loaded only → no skipped suffix", () => {
    const builtin = createBuiltinRegistry();
    const wf = makeExternalWorkflow("sum-wf-1", "claude");
    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, loadedResult(wf), emptyResult());
    } finally {
      cap.restore();
    }
    expect(result.summary).toBe("[atomic/workflows] loaded 1 custom workflow(s)");
    expect(result.summary).not.toContain("skipped");
  });

  test("loaded + broken → skipped suffix", () => {
    const builtin = createBuiltinRegistry();
    const wf = makeExternalWorkflow("sum-wf-2", "claude");
    const broken: BrokenWorkflow = {
      alias: "broken-sum",
      origin: "local",
      agents: ["opencode"],
      reason: "r",
      source: SETTINGS_PATH,
      fix: "f",
    };
    const globalRes: LoadCustomWorkflowsResult = {
      loaded: [{ alias: "sum-wf-2", origin: "global", workflow: wf }],
      broken: [broken],
    };

    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, globalRes, emptyResult());
    } finally {
      cap.restore();
    }
    expect(result.summary).toBe("[atomic/workflows] loaded 1 custom workflow(s) (1 skipped — see warnings above)");
  });

  test("empty inputs → null summary", () => {
    const builtin = createBuiltinRegistry();
    const cap = captureStderr();
    let result;
    try {
      result = mergeIntoRegistry(builtin, emptyResult(), emptyResult());
    } finally {
      cap.restore();
    }
    expect(result.summary).toBeNull();
  });
});
