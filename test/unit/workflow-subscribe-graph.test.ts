import assert from "node:assert/strict";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { isSubscriptionCheckpointHash } from "../../packages/workflows/src/durable/subscription-records.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { scanPossibleStagesFromSource } from "../../packages/workflows/src/shared/possible-stages.js";
import { makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

const TEST_DIR = makeTempDirectory("subscribe-graph");
afterAll(() => removeTempDirectory(TEST_DIR));

test("a detached node keeps its parents but never joins the frontier (#4311)", () => {
	const tracker = new GraphFrontierTracker();
	assert.deepEqual(tracker.onSpawn("subscriber", "subscriber"), []);
	tracker.onSettle("subscriber");
	assert.deepEqual(tracker.onSpawn("event-child", "ci/e1"), ["subscriber"]);
	tracker.detach("event-child");
	tracker.onSettle("event-child");
	assert.deepEqual(tracker.currentParents(), ["subscriber"]);
	assert.deepEqual(tracker.getParents("event-child"), ["subscriber"]);
	assert.deepEqual(tracker.onSpawn("next", "next"), ["subscriber"]);
	tracker.onSettle("next");
	assert.deepEqual(tracker.currentParents(), ["next"]);
	tracker.reset();
	assert.deepEqual(tracker.onSpawn("event-child", "again"), []);
	tracker.onSettle("event-child");
	assert.deepEqual(tracker.currentParents(), ["event-child"]);
});

test("a workflow whose only tracked call is ctx.subscribe or ctx.events passes discovery and names no stage (#4311)", () => {
	const path = join(TEST_DIR, "subscribe-only.ts");
	writeTextSync(
		path,
		`
		export default workflow({
			name: "watch",
			run: async (ctx) => {
				await ctx.subscribe(source, async (event, child) => {
					await child.task({ prompt: "triage" });
				}).done;
			},
		});
	`,
	);
	const result = scanPossibleStagesFromSource(path);
	assert.equal(result.hasTrackedNodes, true);
	assert.deepEqual(result.stages, []);
	const eventsOnly = join(TEST_DIR, "events-only.ts");
	writeTextSync(
		eventsOnly,
		"export default workflow({ run: async (ctx) => { for await (const e of ctx.events(s)) {} } });",
	);
	const inline = scanPossibleStagesFromSource(eventsOnly);
	assert.deepEqual({ tracked: inline.hasTrackedNodes, stages: [...inline.stages] }, { tracked: true, stages: [] });
});

test("discovery names stage, task, chain and parallel steps beside ctx.subscribe, but never a tool or subscription (#4311)", () => {
	const path = join(TEST_DIR, "mixed.ts");
	writeTextSync(
		path,
		`
		export default workflow({
			name: "mixed",
			run: async (ctx) => {
				await ctx.stage("plan").prompt("p");
				await ctx.task("build", { prompt: "b" });
				await ctx.chain([{ name: "lint", prompt: "l" }]);
				await ctx.parallel([{ name: "test", prompt: "t" }]);
				await ctx.tool("fetch", async () => 1);
				await ctx.subscribe(source, async () => {}).done;
			},
		});
	`,
	);
	const result = scanPossibleStagesFromSource(path);
	assert.equal(result.hasTrackedNodes, true);
	assert.deepEqual([...result.stages].sort(), ["build", "lint", "plan", "test"]);
	const singleCalls: ReadonlyArray<readonly [string, string, readonly string[]]> = [
		["tool-only.ts", 'await ctx.tool("fetch", async () => 1);', []],
		["workflow-only.ts", "await ctx.workflow(child, {});", ["workflow:child"]],
	];
	for (const [file, call, stages] of singleCalls) {
		const only = join(TEST_DIR, file);
		writeTextSync(only, `export default workflow({ run: async (ctx) => { ${call} } });`);
		const scanned = scanPossibleStagesFromSource(only);
		assert.deepEqual({ tracked: scanned.hasTrackedNodes, stages: [...scanned.stages] }, { tracked: true, stages });
	}
});

test("subscription records are recognised at the root and under a child workflow's scope, and nothing else is (#4311)", () => {
	const recognised = [
		"workflow-subscription:ci#1",
		"workflow-subscription-event:5f2a",
		"child-run:workflow-subscription:ci#1",
		"child-run:workflow-subscription-event:5f2a",
	];
	const ordinary = ["tool:fetch", "my-workflow-subscription:x", "workflow-subscriptions", "stage:ci#1"];
	assert.deepEqual(recognised.map(isSubscriptionCheckpointHash), [true, true, true, true]);
	assert.deepEqual(ordinary.map(isSubscriptionCheckpointHash), [false, false, false, false]);
});
