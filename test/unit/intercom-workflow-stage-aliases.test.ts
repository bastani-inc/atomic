import assert from "node:assert/strict";
import { test } from "vitest";
import {
	WORKFLOW_STAGE_ALIASES_PER_RUN_MAX,
	WorkflowStageAliases,
} from "../../packages/intercom/broker/workflow-stage-aliases.js";

const RUN = "46390000-3528-413e-84c4-87a43e5037a2";
const STAGE = { runId: RUN, target: `workflow:${RUN}/orchestrator-id`, group: `workflow:${RUN}` };

test("a stage session's names and ids stand for its stage, matched like session names (#4639)", () => {
	const aliases = new WorkflowStageAliases();
	aliases.record(STAGE, ["subagent-chat-01A1C7AC", " 4916c2d7-c5db-4522-aa79-b2eff81245ec ", "", "   "]);
	assert.equal(aliases.size, 2, "blank aliases are not kept");
	assert.deepEqual(aliases.resolve(" SUBAGENT-CHAT-01a1c7ac "), STAGE);
	assert.deepEqual(aliases.resolve("4916C2D7-C5DB-4522-AA79-B2EFF81245EC"), STAGE);
	assert.equal(aliases.resolve("subagent-chat-other"), undefined);
	assert.equal(aliases.resolve(""), undefined);
});

test("a replacement session's aliases join the old ones, which keep reaching the same stage (#4639)", () => {
	const aliases = new WorkflowStageAliases();
	aliases.record(STAGE, ["subagent-chat-first"]);
	aliases.record(STAGE, ["subagent-chat-second"]);
	assert.deepEqual(aliases.resolve("subagent-chat-first"), STAGE);
	assert.deepEqual(aliases.resolve("subagent-chat-second"), STAGE);
});

test("an alias registered again by another run's stage moves to it, and the first run's end leaves it (#4639)", () => {
	const aliases = new WorkflowStageAliases();
	const other = { runId: "other-run", target: "workflow:other-run/stage", group: "workflow:other-run" };
	aliases.record(STAGE, ["shared", "only-first"]);
	aliases.record(other, ["shared"]);
	assert.deepEqual(aliases.resolve("shared"), other);
	aliases.forgetRun(RUN);
	assert.equal(aliases.resolve("only-first"), undefined);
	assert.deepEqual(aliases.resolve("shared"), other, "the alias another run took over survives the first run");
	assert.equal(aliases.size, 1);
	aliases.forgetRun(other.runId);
	assert.deepEqual(aliases.sizes(), { aliases: 0, runs: 0 });
	aliases.forgetRun("never-recorded");
	assert.deepEqual(aliases.sizes(), { aliases: 0, runs: 0 });
});

test("a run keeps a bounded number of aliases, forgetting the oldest first (#4639)", () => {
	assert.equal(WORKFLOW_STAGE_ALIASES_PER_RUN_MAX, 256);
	const aliases = new WorkflowStageAliases(3);
	aliases.record(STAGE, ["a", "b", "c"]);
	aliases.record(STAGE, ["a"]);
	aliases.record(STAGE, ["d"]);
	assert.equal(aliases.resolve("b"), undefined, "the oldest alias goes first; recording one again makes it newest");
	assert.deepEqual(aliases.resolve("a"), STAGE);
	assert.deepEqual(aliases.resolve("c"), STAGE);
	assert.deepEqual(aliases.resolve("d"), STAGE);
	assert.equal(aliases.size, 3);
	aliases.record(STAGE, ["e"]);
	assert.equal(aliases.size, 3, "every alias past the bound evicts one, not only the first");
	assert.equal(aliases.resolve("c"), undefined);
	const other = { runId: "other-run", target: "workflow:other-run/stage", group: "workflow:other-run" };
	aliases.record(other, ["x", "y", "z", "w"]);
	assert.equal(aliases.size, 6, "each run is bounded on its own");
	assert.equal(aliases.resolve("x"), undefined);
});
