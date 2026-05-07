/**
 * Unit tests for the workflow-inputs CLI command.
 *
 * Focused on the pure helpers (`buildInputsPayload` + `renderInputsText`)
 * since they carry the schema-shaping logic. The thin command wrapper
 * is exercised end-to-end by the existing workflow-command harness.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import {
  buildInputsPayload,
  renderInputsText,
  workflowInputsCommand,
  type WorkflowInputsDeps,
  type ResolvedWorkflowEntry,
} from "./workflow-inputs.ts";
import type { AgentType, WorkflowInput, WorkflowDefinition, ExternalWorkflow } from "@bastani/atomic-sdk/workflows";
import { rebuildWorkflowCommand, getActiveRegistry } from "./workflow.ts";

let originalNoColor: string | undefined;
beforeAll(() => {
  originalNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
});
afterAll(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
});

describe("buildInputsPayload", () => {
  test("synthesises a 'prompt' field for free-form workflows", () => {
    const out = buildInputsPayload("ralph", "claude", "loop", []);
    expect(out.freeform).toBe(true);
    expect(out.inputs).toHaveLength(1);
    expect(out.inputs[0]!.name).toBe("prompt");
    expect(out.inputs[0]!.type).toBe("text");
  });

  test("clones structured inputs without mutating callers' arrays", () => {
    const schema: WorkflowInput[] = [
      { name: "research_doc", type: "string", required: true },
      {
        name: "focus",
        type: "enum",
        values: ["minimal", "standard"],
        default: "standard",
      },
    ];
    const out = buildInputsPayload("gen-spec", "claude", "spec", schema);
    expect(out.freeform).toBe(false);
    expect(out.inputs).toHaveLength(2);
    expect(out.inputs[0]!.name).toBe("research_doc");
    expect(out.inputs[1]!.values).toEqual(["minimal", "standard"]);
    // mutating the output must not leak into the input
    out.inputs[0]!.required = false;
    expect(schema[0]!.required).toBe(true);
  });

  test("propagates description and agent into the payload", () => {
    const out = buildInputsPayload("foo", "copilot", "describe me", []);
    expect(out.workflow).toBe("foo");
    expect(out.agent).toBe("copilot");
    expect(out.description).toBe("describe me");
  });
});

describe("renderInputsText", () => {
  test("free-form workflows show the positional-prompt run hint", () => {
    const payload = buildInputsPayload("ralph", "claude", "loop", []);
    const out = renderInputsText(payload);
    expect(out).toContain("ralph");
    expect(out).toContain("claude");
    expect(out).toContain("free-form");
    expect(out).toContain('atomic workflow -n ralph -a claude "<prompt>"');
  });

  test("renders placeholder hint when a field declares one", () => {
    const schema: WorkflowInput[] = [
      {
        name: "note",
        type: "text",
        placeholder: "short summary goes here",
      },
    ];
    const payload = buildInputsPayload("foo", "claude", "", schema);
    const out = renderInputsText(payload);
    expect(out).toContain("placeholder:");
    expect(out).toContain("short summary goes here");
  });

  test("structured workflows render flag names, types, required, defaults, and enum values", () => {
    const schema: WorkflowInput[] = [
      {
        name: "research_doc",
        type: "string",
        required: true,
        description: "path to research notes",
      },
      {
        name: "focus",
        type: "enum",
        values: ["minimal", "standard", "exhaustive"],
        default: "standard",
      },
    ];
    const payload = buildInputsPayload("gen-spec", "claude", "spec", schema);
    const out = renderInputsText(payload);

    expect(out).toContain("--research_doc");
    expect(out).toContain("(required)");
    expect(out).toContain("[string]");
    expect(out).toContain("path to research notes");

    expect(out).toContain("--focus");
    expect(out).toContain("[enum]");
    expect(out).toContain("minimal, standard, exhaustive");
    expect(out).toContain("default: standard");

    // run hint references both flags
    expect(out).toContain("--research_doc=<string>");
    expect(out).toContain("--focus=<enum>");
  });
});

// ─── workflowInputsCommand ─────────────────────────────────────────

function captureOutput(): {
  stdout: () => string;
  stderr: () => string;
  restore: () => void;
} {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((c: string | Uint8Array) => {
    outChunks.push(typeof c === "string" ? c : new TextDecoder().decode(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    errChunks.push(typeof c === "string" ? c : new TextDecoder().decode(c));
    return true;
  }) as typeof process.stderr.write;
  return {
    stdout: () => outChunks.join(""),
    stderr: () => errChunks.join(""),
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

function fakeDiscovered(name: string): ResolvedWorkflowEntry {
  return {
    name,
    agent: "claude",
  };
}

function fakeDefinition(
  name: string,
  description: string,
  inputs: WorkflowInput[],
  agent: AgentType = "claude",
): WorkflowDefinition {
  return {
    __brand: "WorkflowDefinition",
    name,
    agent,
    description,
    inputs,
    minSDKVersion: null,
    source: import.meta.path,
    run: async () => {},
  } as WorkflowDefinition;
}

function makeDeps(overrides: Partial<WorkflowInputsDeps> = {}): WorkflowInputsDeps {
  return {
    findWorkflow: mock(async () => fakeDiscovered("gen-spec")) as unknown as
      WorkflowInputsDeps["findWorkflow"],
    loadWorkflow: mock(async () => ({
      ok: true,
      value: {
        definition: fakeDefinition("gen-spec", "spec generator", [
          { name: "research_doc", type: "string", required: true },
        ]),
      },
    })) as unknown as WorkflowInputsDeps["loadWorkflow"],
    ...overrides,
  };
}

describe("workflowInputsCommand", () => {
  test("returns 1 with a JSON error envelope on unknown agent", async () => {
    const cap = captureOutput();
    try {
      const code = await workflowInputsCommand(
        { name: "gen-spec", agent: "bogus", format: "json" },
        makeDeps(),
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.error).toContain("Unknown agent");
    } finally {
      cap.restore();
    }
  });

  test("returns 1 with a JSON error envelope when the workflow is missing", async () => {
    const deps = makeDeps({
      findWorkflow: mock(async () => null) as unknown as
        WorkflowInputsDeps["findWorkflow"],
    });
    const cap = captureOutput();
    try {
      const code = await workflowInputsCommand(
        { name: "missing", agent: "claude", format: "json" },
        deps,
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.error).toContain("not found");
    } finally {
      cap.restore();
    }
  });

  test("returns 1 when the loader fails to load the workflow", async () => {
    const deps = makeDeps({
      loadWorkflow: mock(async () => ({
        ok: false,
        stage: "load" as const,
        error: new Error("boom"),
        message: "boom",
      })) as unknown as WorkflowInputsDeps["loadWorkflow"],
    });
    const cap = captureOutput();
    try {
      const code = await workflowInputsCommand(
        { name: "gen-spec", agent: "claude", format: "json" },
        deps,
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.error).toBe("boom");
    } finally {
      cap.restore();
    }
  });

  test("prints the JSON payload on success", async () => {
    const cap = captureOutput();
    try {
      const code = await workflowInputsCommand(
        { name: "gen-spec", agent: "claude", format: "json" },
        makeDeps(),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.workflow).toBe("gen-spec");
      expect(parsed.agent).toBe("claude");
      expect(parsed.inputs).toHaveLength(1);
      expect(parsed.inputs[0].name).toBe("research_doc");
    } finally {
      cap.restore();
    }
  });

  test("prints the text render on success when format is 'text'", async () => {
    const cap = captureOutput();
    try {
      const code = await workflowInputsCommand(
        { name: "gen-spec", agent: "claude", format: "text" },
        makeDeps(),
      );
      expect(code).toBe(0);
      const out = cap.stdout();
      expect(out).toContain("gen-spec");
      expect(out).toContain("--research_doc");
    } finally {
      cap.restore();
    }
  });

  test("writes errors to stderr when format is 'text'", async () => {
    const deps = makeDeps({
      findWorkflow: mock(async () => null) as unknown as
        WorkflowInputsDeps["findWorkflow"],
    });
    const cap = captureOutput();
    try {
      const code = await workflowInputsCommand(
        { name: "missing", agent: "claude", format: "text" },
        deps,
      );
      expect(code).toBe(1);
      expect(cap.stderr()).toContain("not found");
    } finally {
      cap.restore();
    }
  });

  test("defaults format to 'json' when omitted", async () => {
    const cap = captureOutput();
    try {
      const code = await workflowInputsCommand(
        { name: "gen-spec", agent: "claude" },
        makeDeps(),
      );
      expect(code).toBe(0);
      // JSON parses cleanly
      JSON.parse(cap.stdout());
    } finally {
      cap.restore();
    }
  });

  test("default deps resolve against the builtin registry on success", async () => {
    // Omit the deps argument so the module-level `defaultDeps` runs —
    // this exercises `registryFindWorkflow` + `registryLoadWorkflow`.
    const cap = captureOutput();
    try {
      const code = await workflowInputsCommand({
        name: "ralph",
        agent: "claude",
        format: "json",
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.workflow).toBe("ralph");
      expect(parsed.agent).toBe("claude");
    } finally {
      cap.restore();
    }
  });

  test("default deps report 'not found' for an unknown workflow", async () => {
    const cap = captureOutput();
    try {
      const code = await workflowInputsCommand({
        name: "definitely-not-a-real-workflow",
        agent: "claude",
        format: "json",
      });
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.error).toContain("not found");
    } finally {
      cap.restore();
    }
  });

  // ─── Regression: builtin lookup still works via activeRegistry ────────────

  test("builtin lookup unchanged after rebuildWorkflowCommand with empty broken", async () => {
    // Reset to clean builtin-only registry with empty broken map.
    rebuildWorkflowCommand(getActiveRegistry(), new Map());
    const cap = captureOutput();
    try {
      const code = await workflowInputsCommand({
        name: "ralph",
        agent: "claude",
        format: "json",
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.workflow).toBe("ralph");
    } finally {
      cap.restore();
    }
  });

  // ─── ExternalWorkflow inputs render correctly via activeRegistry ──────────

  test("ExternalWorkflow in activeRegistry renders inputs correctly", async () => {
    const ext: ExternalWorkflow = {
      kind: "external",
      name: "my-ext-wf",
      agent: "claude",
      description: "my external workflow",
      inputs: [
        { name: "target", type: "string", required: true, description: "target path" },
      ],
      source: { command: "/usr/bin/ext", args: [] },
    };

    // Upsert the external workflow into the active registry.
    const originalRegistry = getActiveRegistry();
    const mergedRegistry = originalRegistry.upsert(ext);
    rebuildWorkflowCommand(mergedRegistry, new Map());

    const cap = captureOutput();
    try {
      const code = await workflowInputsCommand({
        name: "my-ext-wf",
        agent: "claude",
        format: "json",
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.workflow).toBe("my-ext-wf");
      expect(parsed.agent).toBe("claude");
      expect(parsed.description).toBe("my external workflow");
      expect(parsed.inputs).toHaveLength(1);
      expect(parsed.inputs[0].name).toBe("target");
    } finally {
      cap.restore();
      // Restore to original registry.
      rebuildWorkflowCommand(originalRegistry, new Map());
    }
  });
});

// ─── Hard-block: activeBroken populated ──────────────────────────────────────

describe("hard-block on activeBroken", () => {
  beforeEach(() => {
    // Ensure activeBroken is empty before each test to avoid cross-test pollution.
    rebuildWorkflowCommand(getActiveRegistry(), new Map());
  });

  test("writes all three diagnostic lines to stderr and calls process.exit(2)", async () => {
    const brokenEntry = {
      alias: "bad-ext",
      origin: "local" as const,
      agents: ["claude" as AgentType],
      reason: "SyntaxError: unexpected token",
      source: "/home/user/.atomic/workflows/bad-ext.ts",
      fix: "Fix the syntax error in the workflow file.",
    };
    const brokenMap = new Map([["claude/bad-ext", brokenEntry]]);
    rebuildWorkflowCommand(getActiveRegistry(), brokenMap);

    const errChunks: string[] = [];
    const origErr = process.stderr.write;
    process.stderr.write = ((c: string | Uint8Array) => {
      errChunks.push(typeof c === "string" ? c : new TextDecoder().decode(c));
      return true;
    }) as typeof process.stderr.write;

    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      await workflowInputsCommand(
        { name: "bad-ext", agent: "claude", format: "json" },
        makeDeps(),
      );
      throw new Error("should have thrown from process.exit");
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith("process.exit")) throw err;
    } finally {
      process.stderr.write = origErr;
      process.exit = origExit;
    }

    expect(exitCode).toBe(2);
    const stderrOutput = errChunks.join("");
    expect(stderrOutput).toContain("reason ·");
    expect(stderrOutput).toContain("source ·");
    expect(stderrOutput).toContain("fix    ·");
    expect(stderrOutput).toContain("SyntaxError: unexpected token");
    expect(stderrOutput).toContain("/home/user/.atomic/workflows/bad-ext.ts");
  });

  test("non-broken workflow is not blocked", async () => {
    // Only 'other-wf' is broken, 'gen-spec' should pass through.
    const brokenMap = new Map([
      ["claude/other-wf", {
        alias: "other-wf",
        origin: "local" as const,
        agents: ["claude" as AgentType],
        reason: "error",
        source: "/path",
        fix: "fix it",
      }],
    ]);
    rebuildWorkflowCommand(getActiveRegistry(), brokenMap);

    const cap = captureOutput();
    try {
      const code = await workflowInputsCommand(
        { name: "gen-spec", agent: "claude", format: "json" },
        makeDeps(),
      );
      expect(code).toBe(0);
    } finally {
      cap.restore();
    }
  });
});
