/**
 * Unit tests for the `/workflow <name> …` dispatch confirmation
 * (`src/tui/dispatch-confirm.ts`).
 *
 * Visual contract — ui/dispatch-mockup.html §1 (compact two-row shape):
 *  - One rounded dispatched panel: rounded run card with 8-char runId + workflow name +
 *    inline inputs (`k=v · k=v · +N more`) + right-aligned `● running`
 *    badge.
 *  - Inputs wrap to a second body row only when row 1's interior cannot
 *    hold them; the body row uses the same overflow rules.
 *  - Runs keep one hint row: `▸ /workflow connect <short-id>   see agents working · chat with and steer each stage`.
 *
 * Explicitly removed (was in the legacy 7-row layout): the `✓ submitted`
 * echo, the `[ DISPATCHED ]` band, the `run id` muted caption beside the
 * tag, and the `status starting…` body row.
 *
 * cross-ref: src/tui/dispatch-confirm.ts · src/tui/chat-surface.ts
 *            · ui/dispatch-mockup.html
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { renderDispatchConfirm } from "../../packages/workflows/src/tui/dispatch-confirm.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

describe("renderDispatchConfirm — themed", () => {
  test("emits rounded dispatched panel with run card and connect hint", () => {
    const out = renderDispatchConfirm({
      workflowName: "deep-research-codebase",
      runId: "0391c9c1-aaaa-bbbb-cccc-dddddddddddd",
      inputs: { prompt: "map the codebase", max_partitions: 4 },
      theme: deriveGraphTheme({}),
      width: 140,
    });
    const plain = stripAnsi(out);

    // Identity: short runId in the tag + workflow name on the same row.
    assert.match(plain, /0391c9c1/);
    assert.match(plain, /deep-research-codebase/);

    // Status badge in the trailing slot.
    assert.match(plain, /● running/);

    // Inputs ride row 1 (wide terminal → inline path).
    assert.match(plain, /prompt="map the codebase"/);
    assert.match(plain, /max_partitions=4/);

    // Guidance preserves the actionable short id and explains the graph in
    // plain language without attach/detach jargon.
    assert.match(plain, /▸ \/workflow connect 0391c9c1\s+see agents working/);
    assert.match(plain, /chat with and steer each stage/);
    assert.doesNotMatch(plain, /attach|detach/i);
    // Legacy chrome MUST be gone.
    assert.doesNotMatch(plain, /✓ submitted/);
    assert.doesNotMatch(plain, /\[ DISPATCHED \]/);
    assert.doesNotMatch(plain, /\brun id\b/);
    assert.doesNotMatch(plain, /\bstarting…/);
    assert.doesNotMatch(plain, /▸ \/workflow status/);

    assert.match(plain, /^╭ DISPATCHED /);
    assert.match(plain, /●  0391c9c1  deep-research-codebase  ● running/);

    // Themed mode emits ANSI escapes.
    assert.match(out, /\x1b\[/);
  });

  test("wide terminal → inputs render inside the rounded run card", () => {
    const out = renderDispatchConfirm({
      workflowName: "deep-research-codebase",
      runId: "be3181c1-aaaa-bbbb-cccc-dddddddddddd",
      inputs: { prompt: "explore the codebase", max_partitions: 4 },
      theme: deriveGraphTheme({}),
      width: 160,
    });
    const lines = stripAnsi(out).split("\n");
    assert.match(lines[0]!, /DISPATCHED/);
    assert.match(lines[1]!, /be3181c1/);
    assert.match(lines[1]!, /deep-research-codebase/);
    assert.match(lines[2]!, /prompt="explore the codebase"/);
    assert.match(lines[2]!, /max_partitions=4/);
    assert.match(lines.join("\n"), /● running/);
    assert.match(lines.join("\n"), /▸ \/workflow connect be3181c1/);
  });

  test("narrow terminal → rounded card remains width-safe", () => {
    const out = renderDispatchConfirm({
      workflowName: "deep-research-codebase",
      runId: "be3181c1-aaaa-bbbb-cccc-dddddddddddd",
      inputs: { prompt: "explore the codebase", max_partitions: 4 },
      theme: deriveGraphTheme({}),
      width: 60,
    });
    const lines = stripAnsi(out).split("\n");
    assert.match(lines.join("\n"), /be3181c1/);
    assert.match(lines.join("\n"), /● running/);
    assert.match(lines.join("\n"), /prompt=/);
    assert.match(lines.join("\n"), /▸ \/workflow connect be3181c1/);
  });

  test("zero inputs renders a single identity row + hint, with no body row", () => {
    const out = renderDispatchConfirm({
      workflowName: "primer",
      runId: "5b91ee54-aaaa-bbbb-cccc-dddddddddddd",
      inputs: {},
      theme: deriveGraphTheme({}),
      width: 100,
    });
    const plain = stripAnsi(out);
    assert.match(plain, /5b91ee54/);
    assert.match(plain, /primer/);
    assert.match(plain, /● running/);
    assert.match(plain, /▸ \/workflow connect 5b91ee54/);
    // No legacy `(none)` placeholder.
    assert.doesNotMatch(stripAnsi(out), /\(none\)/);
  });

  test("more than 3 inputs collapses tail to +N more", () => {
    const out = renderDispatchConfirm({
      workflowName: "ship-feature",
      runId: "7c4a91bf-eeee-ffff-aaaa-bbbbbbbbbbbb",
      inputs: {
        prompt: "x",
        model: "claude-opus-4",
        max_partitions: 12,
        target: "main",
        branch: "feat/x",
        dry_run: false,
      },
      theme: deriveGraphTheme({}),
      width: 160,
    });
    const plain = stripAnsi(out);
    assert.match(plain, /\+3 more/);
  });

  test("string values are quoted; truncation preserves closing quote", () => {
    const longValue =
      "map every TypeScript file in the codebase, focus on stage runner architecture and persistence ports";
    const out = renderDispatchConfirm({
      workflowName: "deep-research",
      runId: "abcd1234-aaaa-bbbb-cccc-dddddddddddd",
      inputs: { prompt: longValue },
      theme: deriveGraphTheme({}),
      width: 80,
    });
    const plain = stripAnsi(out);
    const inputsLine = plain.split("\n").find((l) => l.includes("prompt="))!;
    assert.match(inputsLine, /prompt="[^"]+…?"/, `inputs line: ${inputsLine}`);
  });
});

describe("renderDispatchConfirm — plain", () => {
  test("preserves the rounded shape without ANSI escapes", () => {
    const out = renderDispatchConfirm({
      workflowName: "ralph",
      runId: "abc12345-aaaa-bbbb-cccc-dddddddddddd",
      inputs: { prompt: "hello" },
      width: 140,
    });
    assert.doesNotMatch(out, /\x1b\[/);

    // Plain identity row carries run id, workflow name, and status.
    assert.match(out, /●  abc12345  ralph  ● running/);
    assert.match(out, /● running/);

    // Inputs present (inline on wide terminal).
    assert.match(out, /prompt="hello"/);

    // All workflows explain how to see agents and chat with/steer stages.
    assert.match(out, /▸ \/workflow connect abc12345\s+see agents working/);
    assert.match(out, /chat with and steer each stage/);
    assert.doesNotMatch(out, /attach|detach/i);
    assert.doesNotMatch(out, /▸ \/workflow status abc12345/);
    assert.doesNotMatch(out, /Ask here anytime for status or to steer this run\./);

    // Legacy chrome MUST be gone in plain mode too.
    assert.doesNotMatch(out, /✓ submitted/);
    assert.doesNotMatch(out, /\[ DISPATCHED \]/);
    assert.doesNotMatch(out, /\brun id\b/);
    assert.doesNotMatch(out, /\bstarting…/);
  });

  test("zero inputs in plain mode renders just identity row + hint", () => {
    const out = renderDispatchConfirm({
      workflowName: "primer",
      runId: "5b91ee54-aaaa-bbbb-cccc-dddddddddddd",
      inputs: {},
      width: 100,
    });
    assert.match(out, /●  5b91ee54  primer  ● running/);
    assert.match(out, /● running/);
    assert.match(out, /▸ \/workflow connect 5b91ee54/);
  });
});
