// @ts-nocheck
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { WorkflowDefinition } from "../../packages/workflows/src/types.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

describe("goal reviewer failure fail-fast", () => {
  test("reviewer fallback exhaustion stops as needs_human without another worker turn", async () => {
    const mod = await import("../../packages/workflows/builtin/goal.js");
    const d = mod.default as unknown as WorkflowDefinition;
    const ctx = makeMockCtx(
      { objective: "Finish documentation", max_turns: 3 },
      {
        parallel: () => {
          throw new AggregateError([
            new Error("reviewer auth failed after fallbackModels exhausted"),
            new Error("No API key for provider: github-copilot"),
          ], "atomic-workflows: reviewer model fallbacks exhausted");
        },
      },
    );

    const result = await d.run(ctx);

    assert.equal(result["status"], "needs_human");
    assert.equal(result["approved"], false);
    assert.equal(result["turns_completed"], 1);
    assert.deepEqual(ctx.calls.task, ["work-turn-1"]);
    assert.equal(ctx.calls.parallel.length, 1);
    assert.equal(ctx.calls.parallelOptions[0]?.failFast, true);
    assert.match(String(result["remaining_work"]), /Recover reviewer execution/);
    assert.match(String(result["remaining_work"]), /github-copilot/);

    const ledger = JSON.parse(readFileSync(result["ledger_path"] as string, "utf8")) as {
      status: string;
      receipts: readonly unknown[];
      reviews: readonly { reviewer: string; decision: string }[];
      decisions: readonly { decision: string; reason: string }[];
      lifecycle: readonly { event: string }[];
    };
    assert.equal(ledger.status, "needs_human");
    assert.equal(ledger.receipts.length, 1);
    assert.equal(ledger.reviews.length, 1);
    assert.equal(ledger.reviews[0]!.reviewer, "reviewer-error");
    assert.deepEqual(ledger.decisions.map((decision) => decision.decision), ["needs_human"]);
    assert.match(ledger.decisions[0]!.reason, /Reviewer execution failed before quorum/);
    assert.deepEqual(
      ledger.lifecycle.map((event) => event.event),
      ["created", "work_turn_started", "receipt_recorded", "reviews_recorded", "status_decided"],
    );
  });
});
