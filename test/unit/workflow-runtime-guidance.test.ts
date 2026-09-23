import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import {
	DEFAULT_PROMPT_GUIDANCE,
	WORKFLOW_TOOL_DESCRIPTION,
} from "../../packages/workflows/src/extension/workflow-prompts.js";
import { moduleDir, readText } from "../helpers/runtime.js";

const root = resolve(moduleDir(import.meta.url), "../..");
const guidance = DEFAULT_PROMPT_GUIDANCE.join("\n");

const contracts = [
	{
		name: "uses project timing evidence without benchmarking a full suite for an estimate",
		phrases: [
			"dependency-constrained task-scheduling problem",
			"historical runtimes from comparable CI jobs, test-suite reports, and prior workflow stages",
			"runner/cache differences",
			"resource contention",
		],
	},
	{
		name: "defers redundant full suites without deleting slice gates or repair reruns",
		phrases: [
			"focused tests and necessary build/type/contract checks at each implementation slice",
			"run the full suite once on the final candidate instead of after every stage",
			"Preserve mandatory per-slice checks, required CI contexts, approval gates, and repair reruns",
			"checked commit or artifact identity",
		],
	},
	{
		name: "overlaps independent work but joins candidate-specific CI results before acceptance",
		phrases: [
			"workflow-owned CI launch/wait/result checks in durable `ctx.tool` nodes",
			"finite timeouts and cancellation",
			"before acceptance, merge, or publication",
			"Background admission is not check completion",
			"end-turn/no-polling",
		],
	},
	{
		name: "reports duration estimates without treating them as budgets",
		phrases: ["unknown", "critical path", "not measured", "budget", "actual elapsed time against the estimate"],
	},
	{
		name: "inherits limits without a routine budget question and honors explicit overrides",
		phrases: [
			"Proceed with inherited budget limits without asking the user to choose a budget before each launch",
			"preserve existing budget limits and approval gates",
			"When the user does state a limit, pass only the fields they named",
			"Never convert an estimate into a cap",
		],
	},
];

for (const contract of contracts) {
	test(contract.name, async () => {
		const docs = await readText(resolve(root, "packages/coding-agent/docs/workflows/reliable-design.md"));
		for (const phrase of contract.phrases) {
			assert.ok(docs.includes(phrase), `design docs missing: ${phrase}`);
		}
	});
}

test("uses available question tools and continues autonomously when none is usable", () => {
	for (const phrase of [
		"When `ask_user_question` or an equivalent question tool is available",
		"all agent-authored questions to the user must use that tool instead of plain text",
		"Prefer `ask_user_question` when available; otherwise use the equivalent tool's supported schema",
		"never end a status or final message with a prose-only question",
		"This does not replace workflow-authored `ctx.ui` gates",
		"relaying an actual user response to a pending prompt",
		"no usable question tool exists",
		"continue fully autonomously on best judgment",
		"Tool unavailability alone is not a blocker",
		"Preserve explicit approval gates, safety, authorization, and budget limits",
	]) {
		assert.ok(guidance.includes(phrase), `model guidance missing: ${phrase}`);
	}
	assert.ok(!guidance.includes("prefer the `ask_user_question` tool"));
});

test("keeps estimates honest and preserves approval boundaries", async () => {
	const docs = await readText(resolve(root, "packages/coding-agent/docs/workflows/reliable-design.md"));
	for (const text of [guidance, docs]) {
		assert.ok(!text.includes("Immediately after a successful workflow launch"));
		assert.ok(!text.includes("Before launching a workflow, give the user an estimated"));
		assert.ok(!text.includes("estimatedDuration"));
		assert.ok(!text.includes("estimate as low-confidence"));
		assert.ok(!text.includes("or nobody answers, do not stall"));
		assert.ok(!text.includes("assuming no budget is always the correct default"));
		assert.ok(!text.includes("ask whether the user wants an explicit budget"));
		assert.ok(!text.includes('Offer "Proceed with inherited limits"'));
		assert.ok(guidance.includes("resume with a raised `budget` only after approval"));
	}
});

test("tool description inherits limits without offering a routine budget choice", () => {
	assert.ok(
		guidance.includes(
			"Preserve inherited budget limits and approval gates without asking for a budget before each launch",
		),
	);
	assert.ok(WORKFLOW_TOOL_DESCRIPTION.includes("Pass budget only for a user-specified limit"));
	assert.ok(!WORKFLOW_TOOL_DESCRIPTION.includes("ask whether the user wants an explicit budget"));
});
