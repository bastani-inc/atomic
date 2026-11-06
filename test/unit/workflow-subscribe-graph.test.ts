import assert from "node:assert/strict";
import { join } from "node:path";
import { afterAll, test } from "vitest";
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

test("a workflow whose only tracked call is ctx.subscribe passes discovery and names no stage (#4311)", () => {
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
	assert.equal(scanPossibleStagesFromSource(eventsOnly).hasTrackedNodes, false);
});
