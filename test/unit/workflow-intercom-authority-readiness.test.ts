import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { spawnSyncCollect } from "../helpers/runtime.js";
import { makeMockSession } from "./stage-runner-helpers.js";

afterEach(() => setDurableBackend(undefined));

// Cold-root regression: the first stage used to enter session_start/live-route
// registration while its owner's announcement was still awaiting broker processing.
test("cold workflow waits for acknowledged route authority before creating its first stage session", async () => {
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const runId = testRunId("cold-authority-readiness");
	const publication = Promise.withResolvers<void>();
	const admissionStarted = Promise.withResolvers<void>();
	let acknowledged = false;
	let announcements = 0;
	let creations = 0;
	let prompts = 0;
	const dispose = registerPendingStageIntercomBridge(
		{
			events: {
				emit(event, payload) {
					if (event !== "atomic:workflow-pending-stage-route") return;
					announcements++;
					payload.completion = publication.promise;
				},
			},
		},
		store,
	);
	const definition = workflow({
		name: "cold-authority-readiness",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			const prompt = ctx.stage("first-stage").prompt("work");
			admissionStarted.resolve();
			await prompt;
			return {};
		},
	});
	assert.equal(announcements, 0, "an empty root does not prewarm Intercom");
	const execution = run(
		definition,
		{},
		{
			runId,
			store,
			durableBackend: backend,
			adapters: {
				agentSession: {
					async create(options) {
						creations++;
						assert.equal(acknowledged, true, "live registration must not overtake owner authority");
						assert.ok(options.orchestrationContext?.pendingStageDelivery?.routeCapability);
						return makeMockSession({
							async prompt() {
								prompts++;
								return "done";
							},
						}).session;
					},
				},
			},
		},
	);
	try {
		await admissionStarted.promise;
		// Drain runnable work, not a timing delay: publication remains explicitly held.
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.ok(announcements > 0);
		assert.equal(store.runs()[0]?.pendingStageMessages?.length ?? 0, 0);
		assert.equal(creations, 0, "stage session_start must wait even with an empty pending queue");
		assert.equal(prompts, 0);
		acknowledged = true;
		publication.resolve();
		assert.equal((await execution).status, "completed");
		assert.equal(creations, 1);
		assert.equal(prompts, 1);
	} finally {
		publication.resolve();
		await execution;
		dispose();
	}
});

function authorityFixture(
	claim: (payload: Record<string, unknown>) => void,
	options: { beforePrompt?: () => Promise<void>; signal?: AbortSignal } = {},
) {
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const started = Promise.withResolvers<void>();
	let creations = 0;
	const dispose = registerPendingStageIntercomBridge(
		{
			events: {
				emit: (event, payload) => {
					if (event === "atomic:workflow-pending-stage-route") claim(payload);
				},
			},
		},
		store,
	);
	const definition = workflow({
		name: "authority-lifecycle",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			const stage = ctx.stage("first-stage");
			await options.beforePrompt?.();
			const prompt = stage.prompt("work");
			started.resolve();
			await prompt;
			return {};
		},
	});
	const launch = (name = "authority-lifecycle") =>
		run(
			definition,
			{},
			{
				runId: testRunId(name),
				store,
				durableBackend: backend,
				signal: options.signal,
				adapters: {
					agentSession: {
						async create() {
							creations++;
							return makeMockSession({
								async prompt() {
									return "done";
								},
							}).session;
						},
					},
				},
			},
		);
	const execution = launch();
	return { store, execution, launch, started: started.promise, dispose, creations: () => creations };
}

const drainRunnableWork = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a rejected claimed publication fails the waiting stage without creating a session", async () => {
	const publication = Promise.withResolvers<void>();
	const fixture = authorityFixture((payload) => {
		payload.completion = publication.promise;
	});
	try {
		await fixture.started;
		await drainRunnableWork();
		assert.equal(fixture.creations(), 0);
		publication.reject(new Error("root authority publication refused"));
		assert.equal((await fixture.execution).status, "failed");
		assert.match(fixture.store.runs()[0]?.stages[0]?.error ?? "", /root authority publication refused/);
		assert.equal(fixture.creations(), 0);
	} finally {
		publication.resolve();
		await fixture.execution;
		fixture.dispose();
	}
});

test("a publication rejected before admission is not mistaken for an absent consumer", async () => {
	const publication = Promise.withResolvers<void>();
	const fixture = authorityFixture(
		(payload) => {
			payload.completion = publication.promise;
		},
		{
			async beforePrompt() {
				publication.reject(new Error("authority already refused"));
				await drainRunnableWork();
			},
		},
	);
	try {
		assert.equal((await fixture.execution).status, "failed");
		assert.match(fixture.store.runs()[0]?.stages[0]?.error ?? "", /authority already refused/);
		assert.equal(fixture.creations(), 0);
	} finally {
		fixture.dispose();
	}
});

test("an optional consumer that does not claim publication never blocks stage startup", async () => {
	let announcements = 0;
	const fixture = authorityFixture(() => {
		announcements++;
	});
	try {
		assert.equal((await fixture.execution).status, "completed");
		assert.ok(announcements > 0);
		assert.equal(fixture.creations(), 1);
	} finally {
		fixture.dispose();
	}
});

test("aborting a workflow releases its authority wait and fences late acknowledgement", async () => {
	const publication = Promise.withResolvers<void>();
	const abort = new AbortController();
	const fixture = authorityFixture(
		(payload) => {
			payload.completion = publication.promise;
		},
		{ signal: abort.signal },
	);
	try {
		await fixture.started;
		await drainRunnableWork();
		assert.equal(fixture.creations(), 0);
		abort.abort(new Error("cancel cold workflow"));
		assert.equal((await fixture.execution).status, "killed");
		publication.resolve();
		await drainRunnableWork();
		assert.equal(fixture.creations(), 0, "late publication must not start an aborted session");
	} finally {
		publication.resolve();
		await fixture.execution;
		fixture.dispose();
	}
});

test("disposing the bridge rejects waiting startup without awaiting its publication", async () => {
	const publication = Promise.withResolvers<void>();
	const fixture = authorityFixture((payload) => {
		payload.completion = publication.promise;
	});
	try {
		await fixture.started;
		await drainRunnableWork();
		fixture.dispose();
		assert.equal((await fixture.execution).status, "failed");
		assert.match(fixture.store.runs()[0]?.stages[0]?.error ?? "", /authority owner retired/);
		publication.resolve();
		await drainRunnableWork();
		assert.equal(fixture.creations(), 0);
	} finally {
		publication.resolve();
		await fixture.execution;
		fixture.dispose();
	}
});

test("replacement cannot lend authority to old waiters and old disposal cannot retire the replacement", async () => {
	const publication = Promise.withResolvers<void>();
	const fixture = authorityFixture((payload) => {
		payload.completion = publication.promise;
	});
	let disposeReplacement = () => {};
	try {
		await fixture.started;
		await drainRunnableWork();
		disposeReplacement = registerPendingStageIntercomBridge(
			{
				events: {
					emit(event, payload) {
						if (event === "atomic:workflow-pending-stage-route") payload.completion = Promise.resolve();
					},
				},
			},
			fixture.store,
		);
		fixture.dispose();
		assert.equal((await fixture.execution).status, "failed");
		assert.match(fixture.store.runs()[0]?.stages[0]?.error ?? "", /authority owner retired/);
		assert.equal(fixture.creations(), 0);
		assert.equal((await fixture.launch("replacement-authority")).status, "completed");
		assert.equal(fixture.creations(), 1);
		publication.resolve();
		await drainRunnableWork();
		assert.equal(fixture.creations(), 1);
	} finally {
		publication.resolve();
		await fixture.execution;
		fixture.dispose();
		disposeReplacement();
	}
});

test("a later roster publication is immediate but does not extend an admitted stage's snapshot wait", async () => {
	const first = Promise.withResolvers<void>();
	const later = Promise.withResolvers<void>();
	let current = first.promise;
	let announcements = 0;
	const fixture = authorityFixture((payload) => {
		announcements++;
		payload.completion = current;
	});
	try {
		await fixture.started;
		await drainRunnableWork();
		const before = announcements;
		current = later.promise;
		fixture.store.recordStageStart(testRunId("authority-lifecycle"), {
			id: "later-stage",
			name: "later-stage",
			status: "pending",
			parentIds: [],
			toolEvents: [],
			pendingStageDeliveryAvailable: true,
		});
		assert.equal(announcements, before + 1, "changed rosters publish even while authority is outstanding");
		assert.equal(fixture.creations(), 0);
		first.resolve();
		assert.equal((await fixture.execution).status, "completed", "the later publication is still held");
		assert.equal(fixture.creations(), 1);
	} finally {
		first.resolve();
		later.resolve();
		await fixture.execution;
		fixture.dispose();
	}
});

test("overlapping roots in one store wait only for their own authority", async () => {
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const fixture = authorityFixture((payload) => {
		payload.completion = payload.runId === testRunId("authority-lifecycle") ? first.promise : second.promise;
	});
	let other: ReturnType<typeof fixture.launch> | undefined;
	try {
		await fixture.started;
		other = fixture.launch("independent-root");
		await drainRunnableWork();
		assert.equal(fixture.store.runs().length, 2);
		assert.equal(fixture.creations(), 0);
		second.resolve();
		assert.equal((await other).status, "completed");
		assert.equal(fixture.creations(), 1);
		assert.equal(fixture.store.runs().find((run) => run.id === testRunId("authority-lifecycle"))?.status, "running");
		first.resolve();
		assert.equal((await fixture.execution).status, "completed");
		assert.equal(fixture.creations(), 2);
	} finally {
		first.resolve();
		second.resolve();
		await Promise.all([fixture.execution, other]);
		fixture.dispose();
	}
});

test("bridge retirement racing acknowledgement still fences startup before session creation", async () => {
	const publication = Promise.withResolvers<void>();
	const fixture = authorityFixture((payload) => {
		payload.completion = publication.promise;
	});
	try {
		await fixture.started;
		await drainRunnableWork();
		publication.resolve();
		queueMicrotask(fixture.dispose);
		assert.equal((await fixture.execution).status, "failed");
		assert.match(fixture.store.runs()[0]?.stages[0]?.error ?? "", /authority owner retired/);
		assert.equal(fixture.creations(), 0);
	} finally {
		publication.resolve();
		await fixture.execution;
		fixture.dispose();
	}
});

// Bound the real Node/Jiti child independently of the test runner's own timer.
const CANCELLATION_PROCESS_TIMEOUT_MS = 20_000;
for (const settlement of ["retire", "reject"] as const) {
	test(`public prompt cancelled during model lookup survives authority ${settlement}`, () => {
		const result = spawnSyncCollect(
			[
				process.execPath,
				fileURLToPath(new URL("../fixtures/workflow-authority-cancelled-model.mjs", import.meta.url)),
				settlement,
			],
			{
				env: { ...process.env, NODE_OPTIONS: "" },
				timeout: CANCELLATION_PROCESS_TIMEOUT_MS,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		assert.equal(result.signalCode, null, result.stderr.toString());
		assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
		assert.match(result.stdout.toString(), new RegExp(`SURVIVED_AUTHORITY_SETTLEMENT ${settlement}`));
	});
}
