import assert from "node:assert/strict";
import type { CreateAgentSessionOptions } from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { registerDormantRunIntercomRoutes } from "../../packages/workflows/src/extension/dormant-run-intercom.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createDurableResumeRuntime } from "../../packages/workflows/src/extension/runtime-durable-resume.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { expireWorkflowLease } from "../helpers/workflow-lease.js";
import { mockSession } from "./executor-shared.js";

const ROOT_RUN_ID = "3760bbbb-2222-4222-8222-222222222222";
const GROUP = `workflow:${ROOT_RUN_ID}`;
const ROUTE_EVENT = "atomic:workflow-pending-stage-route";
const MESSAGE_EVENT = "atomic:workflow-pending-stage-message";
const REVOKED_EVENT = "atomic:workflow-pending-stage-route-revoked";
const SUBAGENT_HOLD_EVENT = "atomic:workflow-dormant-run-subagent-hold";
const SENDER = { id: "parent-after-restart", name: "parent", group: GROUP, groups: [GROUP], cwd: "/repo" };

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface RouteAnnouncement {
	readonly runId: string;
	readonly dormant?: true;
	readonly capability: string;
	readonly stages?: ReadonlyArray<{ readonly stageName: string; readonly target: string; readonly lifecycle: string }>;
	readonly possibleStages?: ReadonlyArray<{ readonly target: string; readonly queuedCount: number }>;
}

type Outcome = { readonly outcome: string; readonly position?: number; readonly reason?: string };

const hooks: { beforeLane?: () => Promise<void> } = {};
const flow = workflow({
	name: "dormant-route-3760",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.stage("prep").prompt("prepare");
		await hooks.beforeLane?.();
		await ctx.stage("lane").prompt("long lane work");
		return {};
	},
});

type StageCreateOptions = CreateAgentSessionOptions & {
	readonly sessionManager: NonNullable<Parameters<typeof mockSession>[0]>;
};

/** Stage adapters; `onCreated` plays the lane's Intercom extension draining its pre-start queue. */
function stageAdapters(
	sessionStore: MemorySessionStore,
	lane: { readonly block?: Promise<never>; readonly onCreated?: (options: StageCreateOptions) => Promise<void> },
): StageAdapters {
	return {
		sessionStore,
		agentSession: {
			create: async (options) => {
				const created = options as StageCreateOptions;
				const session = mockSession(created.sessionManager);
				const isLane = created.orchestrationContext?.workflowStageName === "lane";
				if (isLane) await lane.onCreated?.(created);
				return {
					...session,
					async prompt() {
						if (isLane && lane.block !== undefined) await lane.block;
					},
				};
			},
		},
	};
}

/** A workflow host session whose previous process crashed while `lane` was running. */
function restartedHost(cwd: string) {
	const lifecycle = new Map<string, Array<(event: object, ctx: object) => unknown>>();
	const listeners = new Map<string, Array<(payload: unknown) => void>>();
	const routes: RouteAnnouncement[] = [];
	/** What the subagents extension is asked to hold for the run, and what the run did with each hold. */
	const subagentHolds: Array<{
		readonly runId: string;
		readonly group: string;
		readonly stageSessionIds: readonly string[];
		readonly releases: Array<{ readonly refusal: string | undefined }>;
	}> = [];
	const entries = [
		{
			id: "run-start",
			type: "custom",
			customType: "workflow.run.start",
			data: { runId: ROOT_RUN_ID, name: flow.name, inputs: {}, ts: 1 },
		},
	];
	const pi = {
		on(name: string, handler: (event: object, ctx: object) => unknown) {
			lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
		},
		events: {
			on(name: string, listener: (payload: unknown) => void) {
				listeners.set(name, [...(listeners.get(name) ?? []), listener]);
				return () =>
					listeners.set(
						name,
						(listeners.get(name) ?? []).filter((entry) => entry !== listener),
					);
			},
			emit(name: string, payload: Record<string, unknown>) {
				if (name === ROUTE_EVENT) {
					routes.push(structuredClone(payload) as unknown as RouteAnnouncement);
					payload.completion = Promise.resolve();
				}
				if (name === SUBAGENT_HOLD_EVENT) {
					const request = payload as { runId: string; group: string; stageSessionIds: string[] };
					const hold = {
						runId: request.runId,
						group: request.group,
						stageSessionIds: [...request.stageSessionIds],
						releases: [] as Array<{ refusal: string | undefined }>,
					};
					subagentHolds.push(hold);
					payload.completion = Promise.resolve({
						ready: Promise.resolve(),
						release: async (refusal?: string) => {
							hold.releases.push({ refusal });
						},
					});
				}
				for (const listener of listeners.get(name) ?? []) listener(payload);
			},
		},
	};
	const ctx = {
		cwd,
		hasUI: false,
		ui: { notify() {} },
		sessionManager: { getEntries: () => entries, getCwd: () => cwd },
	};
	return {
		pi,
		routes,
		subagentHolds,
		async start() {
			for (const handler of lifecycle.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		},
		async send(target: string, id: string, text: string, expectsReply?: true): Promise<Outcome | "unhandled"> {
			const payload: Record<string, unknown> & { handled: boolean; completion?: Promise<Outcome> } = {
				handled: false,
				runId: ROOT_RUN_ID,
				target,
				from: SENDER,
				message: { id, timestamp: 1, content: { text }, ...(expectsReply ? { expectsReply } : {}) },
			};
			pi.events.emit(MESSAGE_EVENT, payload);
			return payload.handled && payload.completion !== undefined ? await payload.completion : "unhandled";
		},
	};
}

/** Run until `lane` is in flight, then lose the process without settling it. */
async function interruptedRun(
	cwd: string,
	sessionStore: MemorySessionStore,
	crashedLeaseHeld = false,
): Promise<JournalTestBackend> {
	const writer = await JournalTestBackend.create();
	const laneStarted = Promise.withResolvers<void>();
	const crashed = new AbortController();
	const firstRun = run(
		flow,
		{},
		{
			runId: ROOT_RUN_ID,
			cwd,
			store: createStore(),
			durableBackend: writer,
			signal: crashed.signal,
			adapters: stageAdapters(sessionStore, {
				block: new Promise<never>(() => {}),
				onCreated: async () => laneStarted.resolve(),
			}),
		},
	);
	void firstRun.catch(() => {});
	await laneStarted.promise;
	await waitFor(() =>
		writer
			.listCheckpoints(ROOT_RUN_ID)
			.some((checkpoint) => checkpoint.kind === "stage" && checkpoint.name === "lane"),
	);
	cleanups.push(() => crashed.abort(new Error("crashed process reaped")));
	// A killed process never releases its lease; a clean close does.
	return crashedLeaseHeld ? await JournalTestBackend.create(writer.databasePath) : await writer.reopen();
}

function dormantHost(store: Store, cwd: string, backend: DurableWorkflowBackend, recheckMs?: number) {
	const host = restartedHost(cwd);
	cleanups.push(registerPendingStageIntercomBridge(host.pi as never, store));
	const dormant = registerDormantRunIntercomRoutes(host.pi as never, store, {
		prepareBackend: async () => {
			await backend.hydrateResumableWorkflows();
			bindStoreDurableBackend(store, backend);
			return backend;
		},
		...(recheckMs === undefined ? {} : { recheckMs }),
	});
	cleanups.push(dormant.dispose);
	return { ...host, dormant };
}

async function restartedSession() {
	const cwd = makeTempDirectory("dormant-run-");
	cleanups.push(() => removeTempDirectory(cwd));
	const sessionStore = new MemorySessionStore();
	const backend = await interruptedRun(cwd, sessionStore);
	const store = createStore();
	const host = dormantHost(store, cwd, backend);
	await host.start();
	await host.dormant.settled();
	return { cwd, sessionStore, backend, store, host };
}

/** Resume through the host runtime, as `/workflow resume` does, recording what the lane drains when it goes live. */
function resumeRuntime(
	store: Store,
	cwd: string,
	backend: DurableWorkflowBackend,
	sessionStore: MemorySessionStore,
	delivered: string[],
) {
	const jobs = createJobTracker();
	const runtime = createDurableResumeRuntime({
		registry: createRegistry([flow]),
		store,
		runtimeCwd: cwd,
		jobs,
		ensureReady: async () => backend,
		baseRunOpts: () => ({
			store,
			jobs,
			cwd,
			adapters: stageAdapters(sessionStore, {
				onCreated: async (options) => {
					// Like the stage's Intercom, the recipient reports what its session already admitted.
					const recipient = { sessionId: options.sessionManager.getSessionId(), receivedMessageIds: delivered };
					const drain = (): Promise<void> | undefined =>
						options.orchestrationContext?.pendingStageDelivery?.deliverPending(async (_from, message) => {
							delivered.push(message.id);
						}, recipient);
					await drain();
					await drain();
				},
			}),
		}),
	});
	return { runtime, jobs };
}

test("an interrupted run's stage targets queue before resume and deliver exactly once after it resumes (#3760)", async () => {
	const { cwd, sessionStore, backend, store, host } = await restartedSession();

	const announced = host.routes.find((route) => route.runId === ROOT_RUN_ID);
	assert.ok(announced, "the restarted owner must make the interrupted run addressable before resume");
	assert.equal(announced.dormant, true);
	assert.equal(announced.stages?.find((stage) => stage.stageName === "lane")?.lifecycle, "pending");
	assert.deepEqual(
		announced.possibleStages?.map((row) => row.target),
		[`${GROUP}/**`],
	);

	assert.deepEqual(await host.send(`${GROUP}/lane`, "exact-before-resume", "for the lane"), {
		outcome: "queued",
		position: 1,
	});
	assert.deepEqual(await host.send(`${GROUP}/lane`, "exact-before-resume", "for the lane"), {
		outcome: "queued",
		position: 1,
	});
	assert.deepEqual(await host.send(`${GROUP}/**`, "broadcast-before-resume", "for every stage"), {
		outcome: "queued",
		position: 1,
	});
	const ask = await host.send(`${GROUP}/lane`, "ask-before-resume", "answer me", true);
	assert.equal(ask !== "unhandled" && ask.outcome, "refused");
	assert.equal(
		await backend.workflowOwnership(ROOT_RUN_ID),
		"available",
		"queueing must release the interrupted run's lease so it still resumes and reports as crashed",
	);

	const delivered: string[] = [];
	const { runtime, jobs } = resumeRuntime(store, cwd, backend, sessionStore, delivered);
	const laneMayStart = Promise.withResolvers<void>();
	hooks.beforeLane = () => laneMayStart.promise;
	cleanups.push(() => {
		hooks.beforeLane = undefined;
	});
	const resumed = await runtime.resumeDurableWorkflow(ROOT_RUN_ID);
	assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.message);

	const whileResuming = await host.send(`${GROUP}/lane`, "while-resuming", "between resume and the stage going live");
	assert.equal(
		whileResuming !== "unhandled" && whileResuming.outcome,
		"queued",
		"a send after resume but before the stage is live still queues",
	);
	laneMayStart.resolve();
	await jobs.get(ROOT_RUN_ID)?.promise;
	assert.equal(store.runs().find((candidate) => candidate.id === ROOT_RUN_ID)?.status, "completed");
	assert.deepEqual(delivered.sort(), ["broadcast-before-resume", "exact-before-resume", "while-resuming"]);
});

test("a message queued for an interrupted run after its resume catalog was read does not make resume stale (#3760)", async () => {
	const { cwd, sessionStore, backend, store, host } = await restartedSession();
	const delivered: string[] = [];
	const { runtime, jobs } = resumeRuntime(store, cwd, backend, sessionStore, delivered);
	assert.ok((await runtime.prepareDurableResumable()).some((entry) => entry.workflowId === ROOT_RUN_ID));
	const before = backend.getWorkflow(ROOT_RUN_ID)?.updatedAt;

	assert.equal((await host.send(`${GROUP}/lane`, "after-catalog-read", "queued late")) !== "unhandled", true);
	assert.notEqual(backend.getWorkflow(ROOT_RUN_ID)?.updatedAt, before, "queueing changes the run's journal");

	const resumed = await runtime.resumeDurableWorkflow(ROOT_RUN_ID);
	assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.message);
	await jobs.get(ROOT_RUN_ID)?.promise;
	assert.deepEqual(delivered, ["after-catalog-read"]);
});

test("an in-flight pre-resume write finishes before resume claims the run (#3760)", async () => {
	const { cwd, sessionStore, backend, store, host } = await restartedSession();
	const delivered: string[] = [];
	const { runtime, jobs } = resumeRuntime(store, cwd, backend, sessionStore, delivered);
	await runtime.prepareDurableResumable();
	const persist = backend.persistPendingStageMessages.bind(backend);
	const writeStarted = Promise.withResolvers<void>();
	const releaseWrite = Promise.withResolvers<void>();
	backend.persistPendingStageMessages = async (...args) => {
		writeStarted.resolve();
		await releaseWrite.promise;
		return await persist(...args);
	};
	cleanups.push(() => {
		backend.persistPendingStageMessages = persist;
	});
	const sent = host.send(`${GROUP}/lane`, "racing-resume", "queued while resume starts");
	await writeStarted.promise;
	const resuming = runtime.resumeDurableWorkflow(ROOT_RUN_ID);
	await new Promise((resolve) => setTimeout(resolve, 50));
	releaseWrite.resolve();
	assert.deepEqual(await sent, { outcome: "queued", position: 1 });
	const resumed = await resuming;
	assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.message);
	await jobs.get(ROOT_RUN_ID)?.promise;
	assert.deepEqual(delivered, ["racing-resume"]);
});

test("a dormant owner stops answering once another process resumes the interrupted run (#3760)", async () => {
	const { backend, host } = await restartedSession();
	assert.deepEqual(await host.send(`${GROUP}/lane`, "before-takeover", "queued"), { outcome: "queued", position: 1 });

	const otherProcess = await JournalTestBackend.create(backend.databasePath);
	await otherProcess.hydrateWorkflow(ROOT_RUN_ID);
	await otherProcess.commitWorkflowStatus(ROOT_RUN_ID, "running");
	assert.equal(await backend.workflowOwnership(ROOT_RUN_ID), "foreign");

	const refused = await host.send(`${GROUP}/lane`, "after-takeover", "too late");
	assert.equal(refused !== "unhandled" && refused.outcome, "refused");
	assert.match(refused !== "unhandled" ? (refused.reason ?? "") : "", /resumed in another Atomic session/);
	assert.equal(await host.send(`${GROUP}/lane`, "after-drop", "not ours"), "unhandled");
	assert.deepEqual(
		(otherProcess.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages ?? []).map((entry) => entry.message.id),
		["before-takeover"],
		"only the send accepted before the takeover is queued for the resuming process",
	);
});

test("a revoked dormant route stops answering for its run (#3760)", async () => {
	const { host } = await restartedSession();
	const announced = host.routes.find((route) => route.runId === ROOT_RUN_ID);
	assert.ok(announced);
	host.pi.events.emit(REVOKED_EVENT, { runId: ROOT_RUN_ID, capability: "another-process-capability" });
	assert.notEqual(await host.send(`${GROUP}/lane`, "foreign-revocation", "still ours"), "unhandled");
	host.pi.events.emit(REVOKED_EVENT, { runId: ROOT_RUN_ID, capability: announced.capability });
	assert.equal(await host.send(`${GROUP}/lane`, "after-revocation", "resumed elsewhere"), "unhandled");
});

test("an interrupted run becomes addressable once its crashed owner's lease expires (#3760)", async () => {
	const cwd = makeTempDirectory("dormant-run-lease-");
	cleanups.push(() => removeTempDirectory(cwd));
	const backend = await interruptedRun(cwd, new MemorySessionStore(), true);
	const store = createStore();
	const host = dormantHost(store, cwd, backend, 10);
	await host.start();
	await host.dormant.settled();
	assert.equal(await backend.workflowOwnership(ROOT_RUN_ID), "foreign");
	assert.equal(
		host.routes.some((route) => route.runId === ROOT_RUN_ID),
		false,
		"a run whose owner may still be live is not answered for",
	);
	assert.equal(await host.send(`${GROUP}/lane`, "before-expiry", "too early"), "unhandled");

	expireWorkflowLease(backend.databasePath, ROOT_RUN_ID);
	await waitFor(() => host.routes.some((route) => route.runId === ROOT_RUN_ID));
	assert.deepEqual(await host.send(`${GROUP}/lane`, "after-expiry", "queued"), { outcome: "queued", position: 1 });
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("an interrupted run's stage subagents are held while it waits for resume, kept across its resume and released when it ends (#3760)", async () => {
	const { cwd, sessionStore, backend, store, host } = await restartedSession();
	assert.equal(host.subagentHolds.length, 1, "the run's subagents are held once, when the run becomes addressable");
	const [hold] = host.subagentHolds;
	assert.equal(hold?.runId, ROOT_RUN_ID);
	assert.equal(hold?.group, GROUP);
	const laneSession = backend
		.listCheckpoints(ROOT_RUN_ID)
		.find((checkpoint) => checkpoint.kind === "stage" && checkpoint.name === "lane");
	assert.ok(laneSession?.kind === "stage" && laneSession.sessionId, "the lane stage has a session in the journal");
	assert.deepEqual(hold?.stageSessionIds, [laneSession.sessionId]);
	await host.send(`${GROUP}/lane`, "queued-while-dormant", "still one hold");
	assert.equal(host.subagentHolds.length, 1, "queueing a message never asks for the holds again");
	assert.equal(hold?.releases.length, 0);

	const delivered: string[] = [];
	const { runtime, jobs } = resumeRuntime(store, cwd, backend, sessionStore, delivered);
	const laneMayStart = Promise.withResolvers<void>();
	hooks.beforeLane = () => laneMayStart.promise;
	cleanups.push(() => {
		hooks.beforeLane = undefined;
	});
	const resumed = await runtime.resumeDurableWorkflow(ROOT_RUN_ID);
	assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.message);
	assert.equal(
		hold?.releases.length,
		0,
		"the holds stay until the resumed stage restores its subagents and takes them over: ending them now would open a gap",
	);
	laneMayStart.resolve();
	await jobs.get(ROOT_RUN_ID)?.promise;
	assert.equal(store.runs().find((candidate) => candidate.id === ROOT_RUN_ID)?.status, "completed");
	await waitFor(() => hold?.releases.length === 1);
	assert.deepEqual(hold?.releases, [{ refusal: undefined }], "a finished run restores nothing more, so its holds end");
});

test("a revoked dormant route releases its subagent holds with the explicit resumed-elsewhere reason (#3760)", async () => {
	const { host } = await restartedSession();
	const announced = host.routes.find((route) => route.runId === ROOT_RUN_ID);
	assert.ok(announced);
	const [hold] = host.subagentHolds;
	host.pi.events.emit(REVOKED_EVENT, { runId: ROOT_RUN_ID, capability: "another-process-capability" });
	assert.equal(hold?.releases.length, 0, "a notice for another capability is not ours");
	host.pi.events.emit(REVOKED_EVENT, { runId: ROOT_RUN_ID, capability: announced.capability });
	await waitFor(() => hold?.releases.length === 1);
	assert.match(hold?.releases[0]?.refusal ?? "", /was resumed in another Atomic session; send to it again there/);
	assert.match(hold?.releases[0]?.refusal ?? "", new RegExp(ROOT_RUN_ID));
});

test("a dormant owner that finds another process holds the run's lease releases its subagent holds explicitly (#3760)", async () => {
	const { backend, host } = await restartedSession();
	await host.send(`${GROUP}/lane`, "before-takeover", "queued");
	const [hold] = host.subagentHolds;
	assert.equal(hold?.releases.length, 0);
	const otherProcess = await JournalTestBackend.create(backend.databasePath);
	await otherProcess.hydrateWorkflow(ROOT_RUN_ID);
	await otherProcess.commitWorkflowStatus(ROOT_RUN_ID, "running");
	await host.send(`${GROUP}/lane`, "after-takeover", "too late");
	await waitFor(() => hold?.releases.length === 1);
	assert.match(hold?.releases[0]?.refusal ?? "", /was resumed in another Atomic session/);
});

test("disposing the dormant routes releases their subagent holds without refusing anyone (#3760)", async () => {
	const { host } = await restartedSession();
	const [hold] = host.subagentHolds;
	host.dormant.dispose();
	await waitFor(() => hold?.releases.length === 1);
	assert.deepEqual(hold?.releases, [{ refusal: undefined }]);
});
