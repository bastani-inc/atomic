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

  test("explains intent-first goal versus ralph routing across onboarding sections", () => {
    const cwd = "/repo";
    const overview = getAtomicGuideMessage(normalizeAtomicGuideMode("overview"), cwd);
    const example = getAtomicGuideMessage(normalizeAtomicGuideMode("example"), cwd);
    const workflows = getAtomicGuideMessage(normalizeAtomicGuideMode("workflows"), cwd);
    const onboarding = `${overview}\n${example}\n${workflows}`;

    assert.match(overview, /`goal` \| autonomous work that benefits from a durable goal ledger, bounded worker turns, named validation, and reviewer-gated completion/);
    assert.match(overview, /`ralph` \| autonomous work that benefits from a durable research-first pipeline, delegated implementation, and iterative review/);
    assert.match(example, /Keep interactive or conversation-led implementation inline\. Use bounded subagents when specialist delegation helps/);
    assert.match(example, /clearly delegates an autonomous job whose long-running\/background nature or durable execution needs justify it/);
    assert.match(workflows, /\| `goal` \| autonomous work that benefits from a durable goal ledger, bounded worker turns, named validation, and reviewer-gated completion/);
    assert.match(workflows, /\| `ralph` \| autonomous work that benefits from a durable research-first pipeline, delegated implementation, and iterative review/);

    for (const stalePolicy of [
      "small-to-medium scoped changes when you can name the work surface",
      "larger migrations, new features, broad refactors, and multi-package changes",
      "loop wording like review/fix/test until passing is workflow-shaped",
      "reserve direct debugger/subagent calls for narrow diagnosis or truly tiny deterministic fixes",
      "for bounded scoped work with explicit validation",
    ]) {
      assert.doesNotMatch(onboarding, new RegExp(stalePolicy));
    }
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
