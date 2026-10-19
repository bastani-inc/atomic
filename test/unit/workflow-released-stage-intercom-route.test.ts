import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createPostMortemHandleResolver } from "../../packages/workflows/src/extension/postmortem-deps.js";
import { registerReleasedStageIntercomRoutes } from "../../packages/workflows/src/extension/released-stage-intercom-route.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createPersistedStageFixture } from "./persisted-stage-fixture.js";

interface Announcement {
	readonly runId: string;
	readonly stageId: string;
	readonly stageName: string;
	readonly group: string;
	readonly liveRoute?: { readonly stageKeys: readonly string[] };
	readonly answer: (content: string) => Promise<string>;
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Runs a workflow of one prompt per stage and collects what the host announces to Intercom. */
async function runAndCollectAnnouncements(
	stages: ReadonlyArray<{ name: string; options?: { builtins: { intercom: false } } }>,
) {
	const registry = createStageControlRegistry();
	const store = createStore();
	const fixture = createPersistedStageFixture({ reply: (text) => `answer: ${text}` });
	const announcements: Announcement[] = [];
	const dispose = registerReleasedStageIntercomRoutes(
		{ events: { emit: (_event, payload) => announcements.push(payload) } },
		registry,
		store,
		createPostMortemHandleResolver({
			adapters: fixture.adapters,
			resolveDefaultStageSessionDir: () => undefined,
			store,
			stageControlRegistry: registry,
		}),
	);
	cleanups.push(async () => {
		dispose();
		await registry.clear();
	});
	await run(
		workflow({
			name: "released-route",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				for (const stage of stages) await ctx.stage(stage.name, stage.options).prompt("work");
				return {};
			},
		}),
		{},
		{ store, stageControlRegistry: registry, adapters: fixture.adapters },
	);
	return { announcements, fixture, dispose, runId: store.runs()[0]!.id };
}

test("a released stage is announced to Intercom with ids and its invocation group, and only if it was a peer (#3622)", async () => {
	const { announcements, fixture, runId } = await runAndCollectAnnouncements([
		{ name: "reviewer" },
		{ name: "quiet", options: { builtins: { intercom: false } } },
	]);

	assert.equal(fixture.disposals(), 2, "both completed stages were released");
	assert.deepEqual(
		announcements.map((announcement) => announcement.stageName),
		["reviewer"],
		"a stage without Intercom access never had a peer, so it gets no route",
	);
	const [reviewer] = announcements;
	assert.equal(reviewer?.runId, runId);
	assert.equal(reviewer?.group, `workflow:${runId}`);
	assert.deepEqual(reviewer?.liveRoute?.stageKeys, [reviewer?.stageId, "reviewer"]);
});

test("a released stage answers an ask by reopening its saved conversation, and refuses once the host session ends (#3622)", async () => {
	const { announcements, fixture, dispose } = await runAndCollectAnnouncements([{ name: "reviewer" }]);
	const [reviewer] = announcements;
	assert.ok(reviewer);
	assert.equal(fixture.sessions.length, 1, "announcing does not reopen the stage");

	assert.equal(await reviewer.answer("what changed?"), "answer: what changed?");
	assert.equal(fixture.sessions.length, 2);

	dispose();
	await assert.rejects(reviewer.answer("still there?"), /its owning session has closed/);
});
