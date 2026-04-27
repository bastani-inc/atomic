/**
 * Unit tests for `atomic workflow list` — the subcommand that replaced
 * the old dispatcher `-l/--list` flag.
 *
 * The command itself is thin; these tests cover the behaviors that
 * would silently break if the filter logic regressed: agent filtering,
 * empty results, unknown agent rejection, and the sort order that
 * keeps output stable across runs.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, mock } from "bun:test";
import { workflowListCommand } from "./workflow-list.ts";
import type { AgentType, WorkflowDefinition } from "../../sdk/workflows/index.ts";

function def(agent: AgentType, name: string, description = ""): WorkflowDefinition {
  return {
    __brand: "WorkflowDefinition",
    agent,
    name,
    description,
    inputs: [],
    minSDKVersion: null,
    source: import.meta.path,
    run: async () => {},
  } as unknown as WorkflowDefinition;
}

let originalNoColor: string | undefined;
beforeAll(() => {
  originalNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
});
afterAll(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
});

interface Captured {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureOutput(): Captured {
  const captured: Captured = { stdout: "", stderr: "", restore: () => {} };
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured.stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  captured.restore = () => {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  };
  return captured;
}

const fixture = [
  def("claude", "ralph", "iterative plan/orchestrate/review/debug loop"),
  def("copilot", "ralph", "iterative plan/orchestrate/review/debug loop"),
  def("opencode", "ralph", "iterative plan/orchestrate/review/debug loop"),
  def("claude", "deep-research-codebase", "scout -> explorer fan-out"),
  def("copilot", "deep-research-codebase", "scout -> explorer fan-out"),
  def("opencode", "deep-research-codebase", "scout -> explorer fan-out"),
  def("claude", "open-claude-design", "design system onboarding"),
  def("copilot", "open-claude-design", "design system onboarding"),
  def("opencode", "open-claude-design", "design system onboarding"),
];

let savedNoColor: string | undefined;
beforeEach(() => {
  savedNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
});
afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
});

describe("workflowListCommand", () => {
  test("no agent filter: prints every registered workflow, grouped by name", async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await workflowListCommand({}, { list: () => fixture });
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).toContain("ralph");
    expect(cap.stdout).toContain("deep-research-codebase");
    expect(cap.stdout).toContain("open-claude-design");
    // Grouping deduplicates identical (name, description) pairs, so each
    // workflow name appears exactly once.
    expect(cap.stdout.match(/\bralph\b/g)?.length).toBe(1);
    // Agents are rendered as a badge line under each group.
    expect(cap.stdout).toContain("claude");
    expect(cap.stdout).toContain("copilot");
    expect(cap.stdout).toContain("opencode");
    expect(cap.stdout).toContain(" · ");
    // The old `agent=<name>` label is gone — grouping replaces it.
    expect(cap.stdout).not.toContain("agent=");
  });

  test("agent filter narrows to the selected agent only", async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await workflowListCommand({ agent: "claude" }, { list: () => fixture });
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    // Every workflow with a claude variant appears.
    expect(cap.stdout).toContain("ralph");
    expect(cap.stdout).toContain("deep-research-codebase");
    expect(cap.stdout).toContain("open-claude-design");
    // Non-matching agents should not appear in the listing. We check for
    // the agent-badge separator, not the strings themselves — a workflow
    // named "open-claude-design" legitimately contains the token
    // "claude" outside the badge list.
    expect(cap.stdout).not.toContain("copilot");
    expect(cap.stdout).not.toContain("opencode");
    // Filtered output suppresses the agent-badge line entirely, since
    // the filter itself provides the context.
    expect(cap.stdout).not.toContain(" · ");
  });

  test("unknown agent returns non-zero and writes an error message", async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await workflowListCommand({ agent: "bogus" }, { list: () => fixture });
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
    expect(cap.stderr).toContain("Unknown agent 'bogus'");
  });

  test("empty registry prints a helpful placeholder", async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await workflowListCommand({}, { list: () => [] });
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).toContain("No workflows registered.");
  });

  test("agent filter with zero matches prints the placeholder, not an error", async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await workflowListCommand(
        { agent: "opencode" },
        { list: () => [def("claude", "ralph")] },
      );
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).toContain("No workflows registered.");
  });

  test("groups are sorted alphabetically by workflow name", async () => {
    const shuffled = [
      def("opencode", "ralph"),
      def("claude", "deep-research-codebase"),
      def("claude", "ralph"),
      def("copilot", "ralph"),
    ];
    const cap = captureOutput();
    try {
      await workflowListCommand({}, { list: () => shuffled });
    } finally {
      cap.restore();
    }
    const deepIdx = cap.stdout.indexOf("deep-research-codebase");
    const ralphIdx = cap.stdout.indexOf("ralph");
    expect(deepIdx).toBeGreaterThan(-1);
    expect(ralphIdx).toBeGreaterThan(deepIdx);
  });

  test("agents within a group are sorted alphabetically", async () => {
    const shuffled = [
      def("opencode", "ralph", "plan"),
      def("claude", "ralph", "plan"),
      def("copilot", "ralph", "plan"),
    ];
    const cap = captureOutput();
    try {
      await workflowListCommand({}, { list: () => shuffled });
    } finally {
      cap.restore();
    }
    const claudeIdx = cap.stdout.indexOf("claude");
    const copilotIdx = cap.stdout.indexOf("copilot");
    const opencodeIdx = cap.stdout.indexOf("opencode");
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeLessThan(copilotIdx);
    expect(copilotIdx).toBeLessThan(opencodeIdx);
  });

  test("variants with differing descriptions print as separate groups", async () => {
    // Two variants of `ralph` with different descriptions — the grouping
    // should keep them separate so no information is lost, instead of
    // silently collapsing to one arbitrary description.
    const entries = [
      def("claude", "ralph", "plan version A"),
      def("copilot", "ralph", "plan version B"),
    ];
    const cap = captureOutput();
    try {
      await workflowListCommand({}, { list: () => entries });
    } finally {
      cap.restore();
    }
    expect(cap.stdout).toContain("plan version A");
    expect(cap.stdout).toContain("plan version B");
    // Two separate groups means "ralph" appears as a heading twice.
    expect(cap.stdout.match(/\bralph\b/g)?.length).toBe(2);
  });
});

// mock import kept at module scope to match the lint pattern used by
// other test files — suppresses an unused-import warning if any.
void mock;
