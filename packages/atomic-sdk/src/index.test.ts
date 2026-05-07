/**
 * Tests for the registry-iteration helpers exported from the SDK barrel.
 *
 * `listWorkflows` and `getWorkflow` are thin wrappers around the
 * registry's `list` / `resolve` methods, but they're the public surface
 * that downstream CLIs use to enumerate registered workflows — worth
 * pinning to a regression test so changes to the wrapper signature
 * surface here first.
 */

import { describe, expect, test } from "bun:test";
import {
  createRegistry,
  defineWorkflow,
  getWorkflow,
  listWorkflows,
  getName,
  getDescription,
  getAgent,
  getInputSchema,
  getSource,
  getMinSDKVersion,
} from "./index.ts";
import type { ExternalWorkflow } from "./index.ts";

function makeWorkflow(name: string, agent: "claude" | "copilot" | "opencode") {
  return defineWorkflow({ name, source: import.meta.path })
    .for(agent)
    .run(async () => {})
    .compile();
}

describe("listWorkflows", () => {
  test("returns an empty array for an empty registry", () => {
    const registry = createRegistry();
    expect(listWorkflows(registry)).toEqual([]);
  });

  test("returns every registered workflow regardless of agent", () => {
    const registry = createRegistry()
      .register(makeWorkflow("a", "claude"))
      .register(makeWorkflow("b", "copilot"))
      .register(makeWorkflow("c", "opencode"));

    const all = listWorkflows(registry);
    expect(all).toHaveLength(3);
    expect(all.map((w) => `${w.agent}/${w.name}`).sort()).toEqual([
      "claude/a",
      "copilot/b",
      "opencode/c",
    ]);
  });

  test("preserves the (agent, name) pair so the same name across agents stays distinct", () => {
    const registry = createRegistry()
      .register(makeWorkflow("ralph", "claude"))
      .register(makeWorkflow("ralph", "copilot"));

    const all = listWorkflows(registry);
    expect(all).toHaveLength(2);
    const keys = all.map((w) => `${w.agent}/${w.name}`).sort();
    expect(keys).toEqual(["claude/ralph", "copilot/ralph"]);
  });
});

describe("getWorkflow", () => {
  test("returns undefined when the (name, agent) pair is not registered", () => {
    const registry = createRegistry();
    expect(getWorkflow(registry, "claude", "missing")).toBeUndefined();
  });

  test("returns undefined when only the name (but not the agent) matches", () => {
    const registry = createRegistry().register(makeWorkflow("ralph", "claude"));
    // Same name, different agent — must NOT resolve.
    expect(getWorkflow(registry, "copilot", "ralph")).toBeUndefined();
  });

  test("resolves the matching (name, agent) pair", () => {
    const wf = makeWorkflow("ralph", "claude");
    const registry = createRegistry().register(wf);
    const result = getWorkflow(registry, "claude", "ralph");
    expect(result).toBeDefined();
    expect(result!.name).toBe("ralph");
    expect(result!.agent).toBe("claude");
  });

  test("does not return a workflow registered under a different agent", () => {
    const registry = createRegistry()
      .register(makeWorkflow("ralph", "claude"))
      .register(makeWorkflow("ralph", "copilot"));

    const claudeRalph = getWorkflow(registry, "claude", "ralph");
    const copilotRalph = getWorkflow(registry, "copilot", "ralph");
    expect(claudeRalph).toBeDefined();
    expect(copilotRalph).toBeDefined();
    expect(claudeRalph!.agent).toBe("claude");
    expect(copilotRalph!.agent).toBe("copilot");
  });
});

// ─── ExternalWorkflow + metadata accessors ───────────────────────────────────

function makeExternal(name: string, agent: "claude" | "copilot" | "opencode" = "claude"): ExternalWorkflow {
  return {
    kind: "external",
    name,
    agent,
    description: `${name} description`,
    inputs: [{ name: "query", type: "string" }],
    source: { command: "bunx", args: [`@me/${name}`] },
  };
}

describe("ExternalWorkflow in registry", () => {
  test("upsert inserts an ExternalWorkflow and list() returns it", () => {
    const ext = makeExternal("my-wf");
    const registry = createRegistry().upsert(ext);

    const all = listWorkflows(registry);
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe("my-wf");
    const first = all[0];
    expect(first && "kind" in first ? first.kind : undefined).toBe("external");
  });

  test("getWorkflow resolves an ExternalWorkflow by (name, agent)", () => {
    const ext = makeExternal("my-wf", "copilot");
    const registry = createRegistry().upsert(ext);

    const result = getWorkflow(registry, "copilot", "my-wf");
    expect(result).toBeDefined();
    expect(result!.agent).toBe("copilot");
    expect(result!.name).toBe("my-wf");
  });

  test("ExternalWorkflow coexists with builtin in registry", () => {
    const builtin = makeWorkflow("builtin-wf", "claude");
    const ext = makeExternal("external-wf", "claude");
    const registry = createRegistry().register(builtin).upsert(ext);

    const all = listWorkflows(registry);
    expect(all).toHaveLength(2);
    const names = all.map((w) => w.name).sort();
    expect(names).toEqual(["builtin-wf", "external-wf"]);
  });

  // RFC §8.3 bullet 4: Registry.upsert() replaces matching (agent, name) while
  // Registry.register() keeps its strict semantics.

  test("upsert replaces a builtin with an ExternalWorkflow", () => {
    const builtin = makeWorkflow("wf", "claude");
    const ext = makeExternal("wf", "claude");
    const registry = createRegistry().register(builtin).upsert(ext);

    const resolved = getWorkflow(registry, "claude", "wf");
    expect(resolved && "kind" in resolved ? resolved.kind : undefined).toBe("external");
  });

  test("upsert replaces an ExternalWorkflow with a builtin WorkflowDefinition", () => {
    const ext = makeExternal("wf", "claude");
    const builtin = makeWorkflow("wf", "claude");
    const registry = createRegistry().upsert(ext).upsert(builtin);

    const resolved = getWorkflow(registry, "claude", "wf");
    // builtin WorkflowDefinition has no `kind` field (or kind === "builtin")
    expect(resolved).toBeDefined();
    expect(resolved && "kind" in resolved ? resolved.kind : "builtin").toBe("builtin");
    expect(resolved!.name).toBe("wf");
    // list() reflects replacement — only one entry
    expect(listWorkflows(registry)).toHaveLength(1);
  });

  test("list() after upsert reflects replacement, not original", () => {
    const builtin = makeWorkflow("wf", "claude");
    const ext = makeExternal("wf", "claude");
    const registry = createRegistry().register(builtin).upsert(ext);

    const all = listWorkflows(registry);
    expect(all).toHaveLength(1);
    const first = all[0];
    // Replacement is the external
    expect(first && "kind" in first ? first.kind : undefined).toBe("external");
  });
});

describe("metadata accessors with ExternalWorkflow", () => {
  test("getName returns the name", () => {
    expect(getName(makeExternal("my-wf"))).toBe("my-wf");
  });

  test("getDescription returns description (present)", () => {
    expect(getDescription(makeExternal("my-wf"))).toBe("my-wf description");
  });

  test("getDescription returns empty string when description is absent", () => {
    const ext: ExternalWorkflow = { kind: "external", name: "x", agent: "claude", inputs: [], source: { command: "bunx", args: [] } };
    expect(getDescription(ext)).toBe("");
  });

  test("getAgent returns the agent", () => {
    expect(getAgent(makeExternal("my-wf", "copilot"))).toBe("copilot");
  });

  test("getInputSchema returns the inputs array", () => {
    const ext = makeExternal("my-wf");
    expect(getInputSchema(ext)).toEqual([{ name: "query", type: "string" }]);
  });

  test("getSource returns formatted command string", () => {
    const ext = makeExternal("my-wf");
    expect(getSource(ext)).toBe("bunx @me/my-wf");
  });

  test("getSource returns just command when args are empty", () => {
    const ext: ExternalWorkflow = { kind: "external", name: "x", agent: "claude", inputs: [], source: { command: "/abs/path/bin", args: [] } };
    expect(getSource(ext)).toBe("/abs/path/bin");
  });

  test("getMinSDKVersion returns null for ExternalWorkflow", () => {
    expect(getMinSDKVersion(makeExternal("my-wf"))).toBeNull();
  });
});
