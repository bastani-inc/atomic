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
import type { AgentType, WorkflowDefinition } from "@bastani/atomic-sdk/workflows";
import type { BrokenWorkflow } from "@bastani/atomic-sdk";

function def(agent: AgentType, name: string, description = ""): WorkflowDefinition {
  return {
    __brand: "WorkflowDefinition",
    agent,
    name,
    description,
    inputs: [],
    minSDKVersion: null,
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

function brokenEntry(alias: string, reason: string, source = "/path/to/settings.json"): BrokenWorkflow {
  return {
    alias,
    origin: "local",
    agents: ["claude"],
    reason,
    source,
    fix: "Check your settings.json",
  };
}

describe("workflowListCommand — broken workflows", () => {
  test("no skipped section when activeBroken empty", async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await workflowListCommand(
        {},
        { list: () => fixture, broken: () => [] },
      );
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).not.toContain("skipped");
    expect(cap.stdout).not.toContain("✗");
  });

  test("skipped section appears after healthy section when broken non-empty", async () => {
    const brokenList: readonly BrokenWorkflow[] = [
      brokenEntry("bad-wf", "SyntaxError: unexpected token"),
    ];
    const cap = captureOutput();
    let code: number;
    try {
      code = await workflowListCommand(
        {},
        { list: () => fixture, broken: () => brokenList },
      );
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    // healthy content appears first
    const ralphIdx = cap.stdout.indexOf("ralph");
    const skippedIdx = cap.stdout.indexOf("skipped");
    expect(ralphIdx).toBeGreaterThan(-1);
    expect(skippedIdx).toBeGreaterThan(ralphIdx);
  });

  test("skipped row format: ✗ <alias>   failed to load — <reason>", async () => {
    const brokenList: readonly BrokenWorkflow[] = [
      brokenEntry("my-wf", "TypeError: cannot read property"),
    ];
    const cap = captureOutput();
    try {
      await workflowListCommand(
        {},
        { list: () => [], broken: () => brokenList },
      );
    } finally {
      cap.restore();
    }
    expect(cap.stdout).toContain("✗");
    expect(cap.stdout).toContain("my-wf");
    expect(cap.stdout).toContain("failed to load — TypeError: cannot read property");
  });

  test("summary line format: <N> custom workflow(s) skipped — fix at <path>", async () => {
    const sourcePath = "/home/user/.config/atomic/settings.json";
    const brokenList: readonly BrokenWorkflow[] = [
      brokenEntry("wf-a", "some error", sourcePath),
      brokenEntry("wf-b", "another error", sourcePath),
    ];
    const cap = captureOutput();
    try {
      await workflowListCommand(
        {},
        { list: () => [], broken: () => brokenList },
      );
    } finally {
      cap.restore();
    }
    expect(cap.stdout).toContain(`2 custom workflow(s) skipped — fix at ${sourcePath}`);
  });

  test("multiple broken entries sorted deterministically by alias", async () => {
    const brokenList: readonly BrokenWorkflow[] = [
      brokenEntry("zebra-wf", "err"),
      brokenEntry("alpha-wf", "err"),
      brokenEntry("middle-wf", "err"),
    ];
    const cap = captureOutput();
    try {
      await workflowListCommand(
        {},
        { list: () => [], broken: () => brokenList },
      );
    } finally {
      cap.restore();
    }
    const alphaIdx = cap.stdout.indexOf("alpha-wf");
    const middleIdx = cap.stdout.indexOf("middle-wf");
    const zebraIdx = cap.stdout.indexOf("zebra-wf");
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(zebraIdx);
  });

  test("long reason truncated at 80 chars with ellipsis", async () => {
    const longReason = "x".repeat(100);
    const brokenList: readonly BrokenWorkflow[] = [
      brokenEntry("wf", longReason),
    ];
    const cap = captureOutput();
    try {
      await workflowListCommand(
        {},
        { list: () => [], broken: () => brokenList },
      );
    } finally {
      cap.restore();
    }
    // Should NOT contain the full 100-char reason
    expect(cap.stdout).not.toContain(longReason);
    // Should contain the truncated prefix + ellipsis
    expect(cap.stdout).toContain("x".repeat(80) + "…");
  });

  test("no broken section when deps.broken is omitted (backward compat)", async () => {
    const cap = captureOutput();
    let code: number;
    try {
      // deliberately omit broken field — old callers
      code = await workflowListCommand({}, { list: () => fixture });
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.stdout).not.toContain("skipped");
  });

  test("multi-agent broken entry renders exactly one row when no agent filter", async () => {
    const multiAgentEntry: BrokenWorkflow = {
      alias: "shared-wf",
      origin: "local",
      agents: ["claude", "opencode"],
      reason: "ImportError: missing dep",
      source: "/path/to/settings.json",
      fix: "Check your settings.json",
    };
    const cap = captureOutput();
    try {
      await workflowListCommand(
        {},
        { list: () => [], broken: () => [multiAgentEntry] },
      );
    } finally {
      cap.restore();
    }
    // Exactly one ✗ row for the single entry
    expect(cap.stdout.match(/✗/g)?.length).toBe(1);
    expect(cap.stdout).toContain("shared-wf");
    expect(cap.stdout).toContain("1 custom workflow(s) skipped");
  });

  test("-a claude filter: only entries whose agents include claude render", async () => {
    const claudeEntry: BrokenWorkflow = {
      alias: "claude-only-wf",
      origin: "local",
      agents: ["claude"],
      reason: "SyntaxError",
      source: "/path/settings.json",
      fix: "fix it",
    };
    const opencodeEntry: BrokenWorkflow = {
      alias: "opencode-only-wf",
      origin: "local",
      agents: ["opencode"],
      reason: "ParseError",
      source: "/path/settings.json",
      fix: "fix it",
    };
    const bothEntry: BrokenWorkflow = {
      alias: "both-wf",
      origin: "local",
      agents: ["claude", "opencode"],
      reason: "TypeError",
      source: "/path/settings.json",
      fix: "fix it",
    };
    const brokenList: readonly BrokenWorkflow[] = [claudeEntry, opencodeEntry, bothEntry];
    const cap = captureOutput();
    try {
      await workflowListCommand(
        { agent: "claude" },
        { list: () => [], broken: () => brokenList },
      );
    } finally {
      cap.restore();
    }
    // claude-only and both entries include claude
    expect(cap.stdout).toContain("claude-only-wf");
    expect(cap.stdout).toContain("both-wf");
    // opencode-only entry does NOT include claude
    expect(cap.stdout).not.toContain("opencode-only-wf");
  });

  test("summary uses visible.length after agent filter", async () => {
    const sourcePath = "/path/settings.json";
    const entry1: BrokenWorkflow = {
      alias: "wf-1",
      origin: "local",
      agents: ["claude"],
      reason: "err",
      source: sourcePath,
      fix: "fix",
    };
    const entry2: BrokenWorkflow = {
      alias: "wf-2",
      origin: "local",
      agents: ["claude", "opencode"],
      reason: "err",
      source: sourcePath,
      fix: "fix",
    };
    const entry3: BrokenWorkflow = {
      alias: "wf-3",
      origin: "local",
      agents: ["opencode"],
      reason: "err",
      source: sourcePath,
      fix: "fix",
    };
    const brokenList: readonly BrokenWorkflow[] = [entry1, entry2, entry3];
    const cap = captureOutput();
    try {
      // Filter to claude: entry1 and entry2 qualify (2 of 3)
      await workflowListCommand(
        { agent: "claude" },
        { list: () => [], broken: () => brokenList },
      );
    } finally {
      cap.restore();
    }
    expect(cap.stdout).toContain(`2 custom workflow(s) skipped — fix at ${sourcePath}`);
  });
});

// mock import kept at module scope to match the lint pattern used by
// other test files — suppresses an unused-import warning if any.
void mock;

describe("workflowListCommand — defaultDeps", () => {
  test("runs against the live active registry when no deps are passed", async () => {
    const cap = captureOutput();
    let code: number;
    try {
      code = await workflowListCommand({});
    } finally {
      cap.restore();
    }
    // The active registry contains the builtin set; we don't assert specific
    // names (they shift as builtins evolve) — just that the command runs to
    // completion against it and produces some output.
    expect(code).toBe(0);
    expect(cap.stdout.length).toBeGreaterThan(0);
  });
});
