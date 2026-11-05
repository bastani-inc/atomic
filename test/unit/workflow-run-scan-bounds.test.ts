import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { bindRunDurableBackend } from "../../packages/workflows/src/durable/run-owner-backend.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { createToolNodeLifecycle } from "../../packages/workflows/src/engine/run-tool-node-lifecycle.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { registerReleasedStageIntercomRoutes } from "../../packages/workflows/src/extension/released-stage-intercom-route.js";
import { run as runWorkflow } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStandaloneRouteOwnership } from "../../packages/workflows/src/runs/foreground/sdk-intercom.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { countRunListScans, holdFinishedRuns } from "../helpers/finished-runs.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import {
	type AgentSession,
	type AgentSessionAdapter,
	assistantMessageWithUsage,
	makeMockSession,
} from "./stage-runner-helpers.js";

const ROOT = "4ac72924-c452-4e5f-9e63-2435722109f7";
const CHILD = "5bd82a35-c563-4f60-9a74-3546832210a8";
const GRAND = "6ce93b46-d674-4071-8b85-4657943321b9";
const OTHER = "7df04c57-e785-4182-9c96-5768a54432ca";
const GROUP = `workflow:${ROOT}`;
const EVENT = "atomic:workflow-pending-stage-message";
const ROUTE_EVENT = "atomic:workflow-pending-stage-route";
const UNDELIVERABLE_EVENT = "atomic:workflow-pending-stage-undeliverable";
const SENDER = { id: "sender", name: "sender", group: GROUP };

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function stage(id: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return {
		id,
		name: id,
		status: "pending",
		parentIds: [],
		toolEvents: [],
		replayKey: `stage:${id}:1`,
		pendingStageDeliveryAvailable: true,
		...overrides,
	};
}

function run(id: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return { id, name: id, inputs: {}, status: "running", stages: [], toolNodes: [], startedAt: 1, ...overrides };
}

type Completion = Promise<{ readonly outcome: string; readonly position?: number }>;

interface RouteAnnouncement {
	readonly runId: string;
	readonly possibleStages?: readonly { readonly target: string; readonly queuedCount: number }[];
	completion?: Promise<void>;
}

/**
 * A store holding thousands of finished runs, with the root and its nested runs recorded after them. The nested runs
 * are recorded child, grandchild, other so that store order differs from a walk down the parent links. With
 * `observeStore` the bridge sees the store's invalidations and announces routes and sweeps as a host does; without it,
 * no invalidation-driven announcement can run mid-measurement. `standalone` owns routes as an SDK run or a local
 * pool's root does: only the runs under the root this host runs.
 */
async function bridgeHost(
	options: { readonly observeStore?: boolean; readonly standalone?: boolean; readonly finishedRuns?: number } = {},
) {
	const backend = await createMemoryTestBackend();
	cleanups.push(() => backend.close());
	await backend.commitWorkflowRegistration({
		workflowId: ROOT,
		name: ROOT,
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const real = createStore();
	const counted = countRunListScans(real);
	const store: Store =
		options.observeStore === true
			? counted.store
			: Object.assign(Object.create(real) as Store, { subscribeInvalidation: () => () => {} });
	bindStoreDurableBackend(store, backend);
	const finished = holdFinishedRuns(real, options.finishedRuns ?? 5_000);
	const boundary = (id: string, name: string, runId: string) =>
		stage(id, {
			name,
			status: "running",
			pendingStageDeliveryAvailable: false,
			workflowChildRun: { alias: name, workflow: name, runId },
		});
	const live = (id: string) => stage(id, { status: "running", sessionId: `session-${id}` });
	const root = run(ROOT, {
		rootRunId: ROOT,
		possibleStages: [],
		stages: [
			stage("reviewer"),
			live("live"),
			boundary("child-boundary", "child", CHILD),
			boundary("other-boundary", "other", OTHER),
		],
	});
	bindRunDurableBackend(root, backend);
	real.recordRunStart(root);
	const nested = (id: string, parentRunId: string, parentStageId: string, stages: StageSnapshot[]) =>
		run(id, { parentRunId, parentStageId, rootRunId: ROOT, stages });
	real.recordRunStart(
		nested(CHILD, ROOT, "child-boundary", [
			stage("nested-reviewer"),
			live("nested-live"),
			boundary("grand-boundary", "grand", GRAND),
		]),
	);
	real.recordRunStart(nested(GRAND, CHILD, "grand-boundary", [live("grand-live")]));
	real.recordRunStart(nested(OTHER, ROOT, "other-boundary", [live("other-live")]));
	const listeners: Array<(payload: unknown) => void> = [];
	const announcements: RouteAnnouncement[] = [];
	const undeliverable: Array<{ readonly messageId: string; readonly reason: string }> = [];
	/** Runs whose route announcements no consumer claims, or whose publication fails. */
	const unclaimed = new Set<string>();
	const rejected = new Set<string>();
	const pi = {
		events: {
			emit(name: string, payload: Record<string, unknown>) {
				if (name === ROUTE_EVENT) {
					const announcement = payload as unknown as RouteAnnouncement;
					announcements.push(announcement);
					if (rejected.has(announcement.runId))
						announcement.completion = Promise.reject(new Error("route publication failed"));
					else if (!unclaimed.has(announcement.runId)) announcement.completion = Promise.resolve();
				}
				if (name === UNDELIVERABLE_EVENT) {
					undeliverable.push({ messageId: String(payload.messageId), reason: String(payload.reason) });
					Object.assign(payload, { handled: true, completion: Promise.resolve(true) });
				}
			},
			on(name: string, listener: (payload: unknown) => void) {
				if (name === EVENT) listeners.push(listener);
				return () => {};
			},
		},
	};
	const ownership =
		options.standalone === true ? createStandaloneRouteOwnership(store, new Map([[ROOT, 1]])) : undefined;
	if (ownership !== undefined) cleanups.push(ownership.dispose);
	const bridge = registerPendingStageIntercomBridge(pi, store, ownership?.owns);
	cleanups.push(bridge);
	await bridge.flush();
	finished.reads = 0;
	counted.scans.reads = 0;
	announcements.length = 0;
	const send = async (target: string, runId: string, id: string) => {
		const payload: { handled: boolean; completion?: Completion; [key: string]: unknown } = {
			handled: false,
			runId,
			target,
			from: SENDER,
			message: { id, timestamp: 1, content: { text: id } },
		};
		for (const listener of listeners) listener(payload);
		return { handled: payload.handled, outcome: await payload.completion };
	};
	return { real, finished, scans: counted.scans, send, bridge, announcements, undeliverable, unclaimed, rejected };
}

test("routing a message to a pending, nested or live stage reads none of the finished runs the store holds (#4190)", async () => {
	const host = await bridgeHost();
	const sent = {
		pending: await host.send(`${GROUP}/reviewer`, ROOT, "pending-4190"),
		nestedById: await host.send(`${GROUP}/${CHILD}/nested-reviewer`, CHILD, "nested-id-4190"),
		nestedByName: await host.send(`${GROUP}/child/nested-reviewer`, CHILD, "nested-name-4190"),
		live: await host.send(`${GROUP}/live`, ROOT, "live-4190"),
		nestedLiveById: await host.send(`${GROUP}/${CHILD}/nested-live`, CHILD, "live-id-4190"),
		nestedLiveByName: await host.send(`${GROUP}/child/nested-live`, CHILD, "live-name-4190"),
		grandLive: await host.send(`${GROUP}/child/grand/grand-live`, GRAND, "grand-4190"),
	};
	assert.deepEqual(
		Object.entries(sent).map(([name, { handled, outcome }]) => [name, handled, outcome]),
		[
			["pending", true, { outcome: "queued", position: 1 }],
			["nestedById", true, { outcome: "queued", position: 1 }],
			["nestedByName", true, { outcome: "queued", position: 2 }],
			["live", true, { outcome: "forward", target: `${GROUP}/live` }],
			["nestedLiveById", true, { outcome: "forward", target: `${GROUP}/child/nested-live` }],
			["nestedLiveByName", true, { outcome: "forward", target: `${GROUP}/child/nested-live` }],
			["grandLive", true, { outcome: "forward", target: `${GROUP}/child/grand/grand-live` }],
		],
	);
	assert.equal(host.finished.reads, 0, `routing seven messages read finished runs ${host.finished.reads} times`);
});

test("a message for a stage that has not started, and a broadcast, queue and forward in store order without reading the finished runs (#4190)", async () => {
	const host = await bridgeHost();
	const future = await host.send(`${GROUP}/future`, ROOT, "future-4190");
	const broadcast = await host.send(`${GROUP}/**`, ROOT, "broadcast-4190");
	assert.deepEqual(
		[future.handled, future.outcome, broadcast.handled, broadcast.outcome],
		[
			true,
			{ outcome: "queued", position: 1, prediction: "unknown" },
			true,
			{
				outcome: "queued",
				position: 1,
				prediction: "known",
				forwardTargets: [
					`${GROUP}/live`,
					`${GROUP}/child/nested-live`,
					`${GROUP}/child/grand/grand-live`,
					`${GROUP}/other/other-live`,
				],
			},
		],
	);
	assert.deepEqual(
		host.real.run(ROOT)?.pendingStageMessages?.map((entry) => [entry.message.id, entry.sticky]),
		[
			["future-4190", true],
			["broadcast-4190", true],
		],
	);
	assert.equal(host.finished.reads, 0, `queueing two sticky messages read finished runs ${host.finished.reads} times`);
});

test.each([
	["an extension host", false],
	["a standalone host", true],
])(
	"in %s, a queued message and a run's end re-announce routes and settle undeliverable messages without reading the finished runs (#4190)",
	async (_host, standalone) => {
		const host = await bridgeHost({ observeStore: true, standalone });
		// Each store change schedules an announcement whose sweep may change the store again; settle every round.
		const settle = async () => {
			for (let round = 0; round < 4; round++) await host.bridge.flush();
		};
		const pending = await host.send(`${GROUP}/reviewer`, ROOT, "observed-pending-4190");
		await settle();
		const broadcast = await host.send(`${GROUP}/**`, ROOT, "observed-broadcast-4190");
		await settle();
		const broadcastRow = host.announcements
			.filter((announcement) => announcement.runId === ROOT)
			.at(-1)
			?.possibleStages?.find((row) => row.target === `${GROUP}/**`);
		host.real.recordRunEnd(ROOT, "cancelled");
		await settle();

		assert.deepEqual(
			[pending.outcome?.outcome, broadcast.outcome?.outcome, broadcastRow?.queuedCount],
			["queued", "queued", 1],
			"the root's announcement after the broadcast counts it",
		);
		assert.deepEqual(
			host.undeliverable.map(({ messageId, reason }) => [
				messageId,
				/terminated with status cancelled/.test(reason),
			]),
			[
				["observed-pending-4190", true],
				["observed-broadcast-4190", true],
			],
		);
		assert.deepEqual(
			host.real
				.run(ROOT)
				?.pendingStageMessages?.map((entry) => [
					entry.message.id,
					entry.status,
					entry.undeliverableNotifiedAt !== undefined,
				]),
			[
				["observed-pending-4190", "undeliverable", true],
				["observed-broadcast-4190", "undeliverable", true],
			],
		);
		assert.deepEqual(
			[host.finished.reads, host.scans.reads],
			[0, 0],
			`finished-run reads and run-list accesses: ${host.finished.reads}, ${host.scans.reads}`,
		);
	},
);

test.each([
	["no consumer claimed", "unclaimed"],
	["failed", "rejected"],
] as const)(
	"a route whose publication %s is published again with the next announcement, whichever run changed (#4190)",
	async (_case, failure) => {
		const host = await bridgeHost({ observeStore: true, finishedRuns: 3 });
		const settle = async () => {
			for (let round = 0; round < 3; round++) await host.bridge.flush();
		};
		host[failure].add(CHILD);
		host.real.recordStageSession(CHILD, "nested-reviewer", { sessionId: "reviewer-session" });
		await settle();
		assert.deepEqual(
			host.announcements.map((announcement) => announcement.runId),
			[CHILD],
		);

		host[failure].delete(CHILD);
		host.announcements.length = 0;
		// A change to a run of another invocation: the child's route is not settled yet, so it is published again.
		host.real.recordStageStart("finished-0", stage("late"));
		await settle();
		assert.deepEqual(
			host.announcements.map((announcement) => announcement.runId),
			["finished-0", CHILD],
		);

		host.announcements.length = 0;
		host.real.recordStageStart("finished-1", stage("late"));
		await settle();
		assert.deepEqual(
			host.announcements.map((announcement) => announcement.runId),
			["finished-1"],
			"a claimed route is not published again",
		);
	},
);

/** A small deterministic generator, so a failing sequence replays. */
function sequence(seed: number): () => number {
	let state = seed;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

test.each([
	["an extension host", false],
	["a standalone host", true],
])(
	"in %s, announcing every route and sweeping every run after random run changes finds nothing the run-scoped announcements and sweeps missed (#4190)",
	async (_host, standalone) => {
		const host = await bridgeHost({ observeStore: true, standalone, finishedRuns: 3 });
		const { real } = host;
		const next = sequence(standalone ? 4250 : 4190);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
		const settle = async () => {
			for (let round = 0; round < 3; round++) await host.bridge.flush();
		};
		const names = ["agent", "child", "grand", "other", "reviewer", "live"];
		const runIds = [ROOT, CHILD, GRAND, OTHER];
		const pendingMessages = () =>
			JSON.stringify(runIds.map((runId) => [runId, real.run(runId)?.pendingStageMessages ?? []]));
		await host.send(`${GROUP}/**`, ROOT, "random-broadcast");
		const operations = new Map<string, number>();
		let scoped = 0;
		for (let step = 0; step < 150; step++) {
			const scans = host.scans.reads;
			const runId = pick(runIds);
			const current = real.run(runId);
			const stages = current?.stages ?? [];
			const roll = next();
			let operation: string;
			if (roll < 0.2 || stages.length === 0) {
				operation = "stage start";
				real.recordStageStart(
					runId,
					stage(`s${step}`, { name: pick(names), pendingStageDeliveryAvailable: next() < 0.7 }),
				);
			} else if (roll < 0.35) {
				operation = "stage session";
				real.recordStageSession(runId, pick(stages).id, { sessionId: `session-${step}` });
			} else if (roll < 0.5) {
				operation = "stage end";
				const ended = pick(stages);
				real.recordStageEnd(runId, {
					...ended,
					status: pick(["completed", "failed", "skipped"] as const),
					endedAt: step,
				});
			} else if (roll < 0.58) {
				operation = "boundary child";
				real.recordStageWorkflowChildRun(runId, pick(stages).id, {
					alias: "x",
					workflow: "x",
					runId: pick(runIds),
				});
			} else if (roll < 0.75) {
				operation = "message";
				const target = pick([
					"reviewer",
					"child/nested-reviewer",
					`${CHILD}/nested-reviewer`,
					"future",
					"**",
					"child/*",
				]);
				await host.send(`${GROUP}/${target}`, ROOT, `message-${step}`);
			} else if (roll < 0.8 && runId !== ROOT) {
				operation = "run end";
				real.recordRunEnd(runId, pick(["completed", "cancelled"] as const));
			} else if (roll < 0.88) {
				operation = "run added";
				const id = `late-${step}`;
				const parent = real.run(pick(runIds));
				real.recordRunStart(
					run(id, {
						parentRunId: parent?.id ?? ROOT,
						parentStageId: pick([...(parent?.stages.map((candidate) => candidate.id) ?? []), "missing"]),
						rootRunId: ROOT,
						stages: [stage(`${id}-agent`)],
					}),
				);
				runIds.push(id);
			} else {
				operation = "run republished";
				// A new snapshot under the same id, its first stage renamed: a boundary rename moves its children's targets.
				real.recordRunStart({
					...current!,
					stages: stages.map((candidate, index) =>
						index === 0 ? { ...candidate, name: pick(names) } : candidate,
					),
				});
			}
			operations.set(operation, (operations.get(operation) ?? 0) + 1);
			await settle();
			// A change that moved no lineage is announced and swept without reading the run list.
			if (host.scans.reads === scans) scoped++;
			const announced = host.announcements.length;
			const notified = host.undeliverable.length;
			const messages = pendingMessages();
			host.bridge.refresh();
			await settle();
			assert.deepEqual(
				host.announcements.slice(announced).map((announcement) => announcement.runId),
				[],
				`step ${step} (${operation}): routes a full announcement corrected`,
			);
			assert.deepEqual(
				[host.undeliverable.length, pendingMessages()],
				[notified, messages],
				`step ${step} (${operation}): messages a full sweep settled`,
			);
		}
		assert.equal(operations.size, 8, `every kind of change ran: ${JSON.stringify([...operations])}`);
		assert.ok(scoped >= 50 && scoped <= 140, `${scoped} of 150 changes were announced by run`);
	},
);

function toolNode(id: string): ToolNodeSnapshot {
	return {
		kind: "tool",
		id,
		name: "preflight",
		argsHash: "preflight-hash",
		ordinal: 1,
		parentIds: [],
		status: "running",
		attachable: false,
	};
}

test("tool node events find their run without scanning the run list, and only the run the store holds records them (#4190)", () => {
	const real = createStore();
	holdFinishedRuns(real, 5_000);
	const owned = run("owned");
	real.recordRunStart(owned);
	const { store, scans } = countRunListScans(real);
	const lifecycle = createToolNodeLifecycle({
		store,
		tracker: new GraphFrontierTracker(),
		run: owned,
		sourceToContinuationNodeIds: new Map(),
	});
	lifecycle.onNodeStart?.(toolNode("tool-1"));
	lifecycle.onNodeRunning?.("tool-1", 5);
	lifecycle.onNodeEnd?.("tool-1", { status: "completed", endedAt: 9 });
	assert.equal(scans.reads, 0, `three tool node events scanned the run list ${scans.reads} times`);
	assert.deepEqual(
		real.run("owned")?.toolNodes.map((node) => [node.id, node.status]),
		[["tool-1", "completed"]],
	);

	real.recordRunStart(run("owned", { name: "replacement" }));
	lifecycle.onNodeStart?.(toolNode("tool-2"));
	assert.deepEqual(
		real.run("owned")?.toolNodes.map((node) => node.id),
		[],
		"a run replaced under the same id no longer takes the stale executor's tool nodes",
	);
});

test("announcing a released stage to Intercom reads none of the finished runs the store holds (#4190)", () => {
	const store = createStore();
	const finished = holdFinishedRuns(store, 5_000);
	store.recordRunStart(run("released-run", { stages: [stage("released-stage", { status: "completed" })] }));
	let release: Parameters<Parameters<typeof registerReleasedStageIntercomRoutes>[1]["onStageReleased"]>[0] = () => {};
	const registry = {
		onStageReleased: (listener: typeof release) => {
			release = listener;
			return () => {};
		},
	};
	const announced: Array<{ readonly runId?: string; readonly stageId?: string; readonly group?: string }> = [];
	cleanups.push(
		registerReleasedStageIntercomRoutes(
			{ events: { emit: (_event, payload) => announced.push(payload) } },
			registry as never,
			store,
			(() => undefined) as never,
		),
	);
	finished.reads = 0;
	release({ runId: "released-run", stageId: "released-stage", stageName: "released-stage", sessionId: "session" });
	assert.deepEqual(
		announced.map(({ runId, stageId, group }) => [runId, stageId, group]),
		[["released-run", "released-stage", "workflow:released-run"]],
	);
	assert.equal(finished.reads, 0, `announcing one released stage read finished runs ${finished.reads} times`);
});

test("a run under a token budget meters its usage without reading the finished runs the store holds (#4190)", async () => {
	const messages: AgentSession["messages"] = [];
	let text = "";
	const agentSession: AgentSessionAdapter = {
		async create() {
			return makeMockSession({
				messages,
				async prompt() {
					text = "metered";
					messages.push(
						assistantMessageWithUsage(text, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }),
					);
				},
				getLastAssistantText: () => text,
			}).session;
		},
	};
	const definition = workflow({
		name: "metered-4190",
		description: "",
		budget: { maxTokens: 1_000_000 },
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => ({ result: await ctx.stage("one").prompt("go") }),
	});
	const store = createStore();
	const finished = holdFinishedRuns(store, 5_000);
	const result = await runWorkflow(definition, {}, { store, adapters: { agentSession } });
	assert.deepEqual(result.result, { result: "metered" });
	assert.equal(finished.reads, 0, `metering one run read finished runs ${finished.reads} times`);
});
