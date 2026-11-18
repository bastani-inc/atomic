import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
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
	emit?: (event: string, payload: Announcement) => void,
) {
	const registry = createStageControlRegistry();
	const store = createStore();
	const fixture = createPersistedStageFixture({ reply: (text) => `answer: ${text}` });
	const announcements: Announcement[] = [];
	const dispose = registerReleasedStageIntercomRoutes(
		{ events: { emit: emit ?? ((_event, payload) => announcements.push(payload)) } },
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
	return { announcements, fixture, dispose, store, registry, runId: store.runs()[0]!.id };
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

test("a released stage's old route cannot reopen a successor even when it uses the same transcript (#5577)", async () => {
	const { announcements, fixture, store, runId } = await runAndCollectAnnouncements([{ name: "reviewer" }]);
	const [old] = announcements;
	assert.ok(old);
	store.recordRunStart(structuredClone(store.run(runId)!));
	await assert.rejects(old.answer("old conversation"), /replaced/);
	assert.equal(fixture.sessions.length, 1);
});

test.each(["before ask", "during transcript read"] as const)(
	"an old address refuses an ask when another registration takes the same stored stage %s (#5577)",
	async (when) => {
		const { announcements, fixture, registry, store, runId } = await runAndCollectAnnouncements([
			{ name: "reviewer" },
		]);
		const route = announcements[0]!;
		const started = Promise.withResolvers<void>(),
			finish = Promise.withResolvers<void>();
		let ask: Promise<string> | undefined;
		if (when === "during transcript read") {
			const read = fixture.store.load.bind(fixture.store);
			vi.spyOn(fixture.store, "load").mockImplementationOnce(async (id) => {
				started.resolve();
				await finish.promise;
				return read(id);
			});
			ask = route.answer("for old address");
			await started.promise;
		}
		const reopen = createPostMortemHandleResolver({
			store,
			stageControlRegistry: registry,
			adapters: fixture.adapters,
			resolveDefaultStageSessionDir: () => undefined,
		});
		const replacement = await reopen(runId, route.stageId);
		assert.ok(replacement?.ok);
		const letGo = replacement.handle.subscribe(() => {});
		try {
			finish.resolve();
			await assert.rejects(ask ?? route.answer("for old address"), /replaced/);
			assert.equal(fixture.sessions.flatMap((session) => session.prompts).includes("for old address"), false);
		} finally {
			finish.resolve();
			letGo();
		}
	},
);

test("an admitted ask cannot use a different registration of its reopened handle after attachment yields (#5577)", async () => {
	const { announcements, fixture, registry, runId } = await runAndCollectAnnouncements([{ name: "reviewer" }]);
	const started = Promise.withResolvers<void>(),
		finish = Promise.withResolvers<void>();
	const adapter = fixture.adapters.agentSession!;
	const create = adapter.create.bind(adapter);
	vi.spyOn(adapter, "create").mockImplementationOnce(async (...args) => {
		started.resolve();
		await finish.promise;
		return create(...args);
	});
	const route = announcements[0]!;
	const ask = route.answer("for the original registration");
	await started.promise;
	try {
		registry.register(registry.peek(runId, route.stageId)!);
		finish.resolve();
		await assert.rejects(ask, /replaced/);
		assert.equal(
			fixture.sessions.flatMap((session) => session.prompts).includes("for the original registration"),
			false,
		);
	} finally {
		finish.resolve();
	}
});

test("replacing a stage during disposal cannot announce an old route under the successor's ID (#5577)", async () => {
	const store = createStore();
	const registry = createStageControlRegistry();
	const events: string[] = [];
	const stop = registerReleasedStageIntercomRoutes(
		{ events: { emit: (_, route) => events.push(route.stageId) } },
		registry,
		store,
		() => undefined,
	);
	cleanups.push(async () => {
		stop();
		await registry.clear();
	});
	const fixture = createPersistedStageFixture({
		reply: () => "done",
		async onCreate() {
			return async () => {
				store.recordRunStart(structuredClone(store.runs()[0]!));
			};
		},
	});
	await run(
		workflow({
			name: "stage-route",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.stage("reviewer").prompt("work");
				return {};
			},
		}),
		{},
		{ store, stageControlRegistry: registry, adapters: fixture.adapters },
	);
	assert.equal(fixture.disposals(), 1);
	assert.deepEqual(events, []);
});

test("a host that closed its session mid-teardown does not warn per released stage, but other emit failures still do (#3966)", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	cleanups.push(() => warn.mockRestore());
	const emitFailures: string[] = [];
	const failWith = (error: Error) => () => {
		emitFailures.push(error.message);
		throw error;
	};
	const stages = [{ name: "one" }, { name: "two" }, { name: "three" }];

	await runAndCollectAnnouncements(
		stages,
		failWith(Object.assign(new Error("SessionClosed"), { code: "SessionClosed" })),
	);
	assert.equal(emitFailures.length, 1, "a closed session stops further announcements");
	assert.deepEqual(
		warn.mock.calls.filter(([message]) => String(message).includes("released stage listener failed")),
		[],
	);

	await runAndCollectAnnouncements(stages, failWith(new Error("boom")));
	assert.equal(
		warn.mock.calls.filter(([message]) => String(message).includes("released stage listener failed")).length,
		3,
		"an unrelated emit failure is still reported for each stage",
	);
});
