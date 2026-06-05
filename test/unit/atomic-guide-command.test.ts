import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  atomicGuideModeForChoice,
  getAtomicGuideArgumentCompletions,
  getAtomicGuideMessage,
  normalizeAtomicGuideMode,
} from "../../packages/coding-agent/src/core/atomic-guide-command.js";
import { BUILTIN_SLASH_COMMANDS } from "../../packages/coding-agent/src/core/slash-commands.js";

describe("/atomic guide command", () => {
  test("is listed as a builtin command with static guide completions", async () => {
    const builtinCommand = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "atomic");

    assert.ok(builtinCommand, "expected /atomic to be listed as a builtin command");
    assert.equal(builtinCommand.description, "Atomic onboarding and help guide");
    assert.equal(builtinCommand.getArgumentCompletions, getAtomicGuideArgumentCompletions);

    const completions = (await builtinCommand.getArgumentCompletions?.("")) ?? [];
    assert.deepEqual(
      completions.map((completion) => completion.value),
      ["overview", "workflows", "example", "what's new"],
    );
  });

  test("shows the static help menu by default", () => {
    const content = getAtomicGuideMessage(normalizeAtomicGuideMode(""), "/repo");

    assert.match(content, /^# Atomic/);
    assert.match(content, /`overview` — run `\/atomic overview`/);
  });

  test("keeps explicit onboarding options routed to their static guides", () => {
    const cwd = "/repo";

    assert.match(getAtomicGuideMessage(normalizeAtomicGuideMode("overview"), cwd), /^# Atomic overview/);
    assert.match(getAtomicGuideMessage(normalizeAtomicGuideMode("workflows"), cwd), /^# Workflows primer/);
    assert.match(getAtomicGuideMessage(normalizeAtomicGuideMode("example"), cwd), /^# Practical example/);
    assert.match(getAtomicGuideMessage(normalizeAtomicGuideMode("what's new"), cwd), /^# What's new/);
  });

  test("explains goal versus ralph across onboarding sections", () => {
    const cwd = "/repo";
    const overview = getAtomicGuideMessage(normalizeAtomicGuideMode("overview"), cwd);
    const example = getAtomicGuideMessage(normalizeAtomicGuideMode("example"), cwd);
    const workflows = getAtomicGuideMessage(normalizeAtomicGuideMode("workflows"), cwd);

    assert.match(overview, /`goal` \| small-to-medium scoped changes/);
    assert.match(overview, /`ralph` \| larger migrations, broad refactors, multi-package changes, and spec-to-reviewed-change work/);
    assert.match(example, /For small-to-medium scoped changes where you can identify the work surface, exact outcome, and validation, use `goal`/);
    assert.match(workflows, /\| `goal` \| small-to-medium scoped changes with a clear outcome and named validation/);
    assert.match(workflows, /\| `ralph` \| larger migrations, broad refactors, multi-package changes, and spec-to-reviewed-change work/);
  });

  test("treats adversarial punctuation arguments as unknown help requests", () => {
    assert.equal(normalizeAtomicGuideMode(`${"!".repeat(50_000)}a`), "help");
  });

  test("UI help choices map only to static guide options", () => {
    assert.equal(atomicGuideModeForChoice("overview"), "overview");
    assert.equal(atomicGuideModeForChoice("workflows"), "workflows");
    assert.equal(atomicGuideModeForChoice("example"), "example");
    assert.equal(atomicGuideModeForChoice("what's new"), "whats-new");
  });
});
