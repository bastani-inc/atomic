import assert from "node:assert/strict";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

function failingChild(name: string, message: string) {
	return workflow({
		name,
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("fail", {}, async () => {
				throw new Error(message);
			});
			return {};
		},
	});
}

async function runRootOver(child: ReturnType<typeof failingChild>, runId: string) {
	const root = workflow({
		name: "root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.workflow(child);
			return {};
		},
	});
	const store = createStore();
	const result = await run(root, {}, { runId, store });
	return { result, snapshot: store.runs().find((snapshot) => snapshot.id === runId) };
}

test.each(["rate-limit-child", "overloaded-child", "quota-child"])(
	"a child workflow named %s that fails for an ordinary reason fails the root, not a resumable block (#4031)",
	async (name) => {
		const { result, snapshot } = await runRootOver(failingChild(name, "boom: an ordinary failure"), `root-${name}`);
		assert.equal(result.status, "failed", JSON.stringify(result));
		assert.match(result.error ?? "", /boom: an ordinary failure/);
		assert.equal(snapshot?.status, "failed");
		assert.equal(snapshot?.failureKind, "unknown");
		assert.notEqual(snapshot?.failureDisposition, "active_blocked");
	},
);

test("a child workflow that fails on a rate limit still blocks the root resumably (#4031)", async () => {
	const { result, snapshot } = await runRootOver(failingChild("plain-child", "429 Too Many Requests"), "root-limited");
	assert.equal(result.status, "running", JSON.stringify(result));
	assert.equal(snapshot?.failureKind, "rate_limit");
	assert.equal(snapshot?.failureDisposition, "active_blocked");
	assert.equal(snapshot?.resumable, true);
});
