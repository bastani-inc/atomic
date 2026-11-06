import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	type EventSource,
	isSubscriptionClosedError,
	isSubscriptionConfigError,
	isSubscriptionHandlerError,
	isSubscriptionSubscriberUnavailableError,
	publishEvent,
	type SessionStore,
	SUBSCRIPTION_REPORT_TOOL_NAME,
	type SubscriptionEvent,
	type SubscriptionStats,
	type ToolDefinition,
} from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedWorkflowSnapshot,
	listOpenableCompletedWorkflows,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { subscriptionEventProcessed } from "../../packages/workflows/src/durable/subscription-records.js";
import { pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
	type StageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type {
	WorkflowEventStream,
	WorkflowSubscription,
} from "../../packages/workflows/src/shared/authoring-contract-events.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";
import { mockSession } from "./executor-shared.js";

const poolProbe = vi.hoisted(() => ({ open: undefined as (() => Promise<SessionStore>) | undefined }));
vi.mock("../../packages/workflows/src/workers/pool-session-store.js", () => ({
	poolSessionStore: async () => poolProbe.open?.(),
}));

afterEach(closeMemoryTestBackends);

const EVENT_COUNT = 1000;
const RELEVANT_EVERY = 100;
const REDELIVERED = 50;
const SUBSCRIBER = "ci-watcher";
const SUBSCRIPTION = "ci";
/** Structural: 1,000 tracked child stages run through the real engine and journal. */
const THOUSAND_CHILDREN_TIMEOUT_MS = 120_000;

type SessionMessage = AgentSession["messages"][number];
type Listener = (event: { readonly type: string }) => void;

function userMessage(text: string): SessionMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as SessionMessage;
}

function assistantMessage(text: string): SessionMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as SessionMessage;
}

function messageText(message: SessionMessage): string {
	const content = (message as { content?: readonly { readonly text?: string }[] }).content ?? [];
	return content.map((part) => part.text ?? "").join("");
}

/** A synthetic CI stream: every event once, then `REDELIVERED` repeats, then the source ends. */
function syntheticSource(): EventSource {
	return {
		id: "synthetic-ci",
		start: async (_signal, emit) => {
			for (let index = 0; index < EVENT_COUNT; index++) {
				emit({ id: `evt-${index}`, type: "check_run", payload: { index, failed: index % RELEVANT_EVERY === 0 } });
			}
			for (let index = 0; index < REDELIVERED; index++) {
				emit({ id: `evt-${index}`, type: "check_run", payload: { index, failed: index % RELEVANT_EVERY === 0 } });
			}
		},
	};
}

/** The subscriber's long-lived session: prompts answer, follow-on messages only append. */
function subscriberSession(): StageSessionRuntime {
	const listeners = new Set<Listener>();
	const messages: SessionMessage[] = [];
	const emit = (type: string): void => {
		for (const listener of [...listeners]) listener({ type });
	};
	return {
		...mockSession(),
		async prompt(text: string) {
			emit("agent_start");
			messages.push(userMessage(text), assistantMessage("watching"));
			emit("agent_end");
		},
		async sendUserMessage(content) {
			emit("agent_start");
			messages.push(userMessage(typeof content === "string" ? content : ""));
			emit("agent_end");
		},
		subscribe(listener) {
			listeners.add(listener as Listener);
			return () => listeners.delete(listener as Listener);
		},
		get messages() {
			return messages as AgentSession["messages"];
		},
	};
}

/** An event child's model: it reads the seeded event and reports only failed checks. */
function eventChildSession(customTools: readonly ToolDefinition[] | undefined, seeds: string[]): StageSessionRuntime {
	const reportTool = customTools?.find((tool) => tool.name === SUBSCRIPTION_REPORT_TOOL_NAME);
	return {
		...mockSession(),
		async prompt(text: string) {
			seeds.push(text);
			const payload = JSON.parse(text.slice(text.indexOf("```json\n") + 8, text.lastIndexOf("\n```"))) as {
				readonly index: number;
				readonly failed: boolean;
			};
			if (payload.failed && reportTool !== undefined) {
				await reportTool.execute(
					`call-${payload.index}`,
					{ text: `check ${payload.index} failed` },
					undefined,
					undefined,
					undefined as never,
				);
			}
		},
	};
}

interface AcceptanceRun {
	readonly status: string;
	readonly stages: readonly StageSnapshot[];
	readonly subscriberMessages: readonly SessionMessage[];
	readonly messagesBeforeSubscription: number;
	readonly stats: SubscriptionStats;
	readonly seeds: readonly string[];
	readonly backend: MemoryJournalBackend;
	readonly runId: string;
	readonly error?: string;
}

async function runAcceptance(): Promise<AcceptanceRun> {
	const backend = await createMemoryTestBackend();
	const store = createStore();
	const seeds: string[] = [];
	const subscriber = subscriberSession();
	let messagesBeforeSubscription = -1;
	let stats: SubscriptionStats | undefined;
	const definition = workflow({
		name: "ci-triage",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const watcher = ctx.stage(SUBSCRIBER);
			await watcher.prompt("Watch CI for pull request 42 and act on reports.");
			messagesBeforeSubscription = watcher.messages.length;
			const subscription = ctx.subscribe(
				syntheticSource(),
				async (_event, child) => {
					await child.task({ prompt: "Report a check only when it failed." });
				},
				{ subscriber: watcher, name: SUBSCRIPTION, maxConcurrent: 16 },
			);
			stats = await subscription.done;
			await ctx.stage("after-subscription").prompt("summarize");
			return {};
		},
	}) as WorkflowDefinition;
	const runId = "33333333-3333-4333-8333-000000004311";
	const result = await run(
		definition,
		{},
		{
			runId,
			store,
			durableBackend: backend,
			adapters: {
				agentSession: {
					create: async (options, meta) =>
						meta?.stageName === SUBSCRIBER
							? subscriber
							: meta?.stageName.startsWith(`${SUBSCRIPTION}#1/`) === true
								? eventChildSession(options.customTools as readonly ToolDefinition[] | undefined, seeds)
								: subscriberSession(),
				},
			},
		},
	);
	assert.ok(stats !== undefined, result.error);
	return {
		status: result.status,
		stages: result.stages,
		subscriberMessages: subscriber.messages as readonly SessionMessage[],
		messagesBeforeSubscription,
		stats,
		seeds,
		backend,
		runId,
		...(result.error === undefined ? {} : { error: result.error }),
	};
}

test(
	"a stage subscribed to 1,000 events, 10 relevant, receives exactly 10 reports and grows only by them (#4311)",
	async () => {
		const outcome = await runAcceptance();
		assert.equal(outcome.status, "completed", outcome.error);

		const added = outcome.subscriberMessages.slice(outcome.messagesBeforeSubscription);
		assert.equal(added.length, EVENT_COUNT / RELEVANT_EVERY);
		assert.deepEqual(
			added.map(messageText).sort(),
			Array.from({ length: EVENT_COUNT / RELEVANT_EVERY }, (_, n) => n * RELEVANT_EVERY)
				.map(
					(index) =>
						`Report from event child "${SUBSCRIPTION}#1/evt-${index}" (event evt-${index}):\n\ncheck ${index} failed`,
				)
				.sort(),
		);
		assert.equal(
			added.every((message) => (message as { role?: string }).role === "user"),
			true,
		);

		assert.deepEqual(outcome.stats, {
			received: EVENT_COUNT + REDELIVERED,
			duplicates: REDELIVERED,
			handled: EVENT_COUNT,
			active: 0,
			queued: 0,
			reports: EVENT_COUNT / RELEVANT_EVERY,
		});
		assert.equal(outcome.seeds.length, EVENT_COUNT);
		assert.match(outcome.seeds[0]!, /^Report a check only when it failed\.\n\n## Event\nSubscription: ci\n/);
	},
	THOUSAND_CHILDREN_TIMEOUT_MS,
);

function sortedTexts(messages: readonly SessionMessage[]): string[] {
	return messages.map(messageText).sort();
}

test(
	"every event child is a distinct detached graph node under the subscriber, and the graph stays acyclic (#4311)",
	async () => {
		const outcome = await runAcceptance();
		const byId = new Map(outcome.stages.map((stage) => [stage.id, stage]));
		const watcher = outcome.stages.find((stage) => stage.name === SUBSCRIBER)!;
		const children = outcome.stages.filter((stage) => stage.name.startsWith(`${SUBSCRIPTION}#1/`));
		assert.equal(children.length, EVENT_COUNT);
		assert.equal(new Set(children.map((stage) => stage.id)).size, EVENT_COUNT);
		assert.equal(new Set(children.map((stage) => stage.name)).size, EVENT_COUNT);
		for (const child of children) {
			assert.deepEqual(child.parentIds, [watcher.id]);
			assert.equal(child.status, "completed");
		}
		const childIds = new Set(children.map((stage) => stage.id));
		const after = outcome.stages.find((stage) => stage.name === "after-subscription")!;
		assert.deepEqual(after.parentIds, [watcher.id]);
		for (const stage of outcome.stages) {
			assert.equal(
				stage.parentIds.some((parent) => childIds.has(parent)),
				false,
				`${stage.name} must not depend on an event child`,
			);
		}
		const visiting = new Set<string>();
		const done = new Set<string>();
		const visit = (id: string): void => {
			if (done.has(id)) return;
			assert.equal(visiting.has(id), false, `cycle through ${id}`);
			visiting.add(id);
			for (const parent of byId.get(id)?.parentIds ?? []) visit(parent);
			visiting.delete(id);
			done.add(id);
		};
		for (const stage of outcome.stages) visit(stage.id);
		assert.deepEqual(
			sortedTexts(outcome.subscriberMessages.slice(0, 2)),
			["Watch CI for pull request 42 and act on reports.", "watching"].sort(),
		);
	},
	THOUSAND_CHILDREN_TIMEOUT_MS,
);

test(
	"the subscription and every processed event are recorded durably in the journal (#4311)",
	async () => {
		const outcome = await runAcceptance();
		const records = outcome.backend.listCheckpoints(outcome.runId).filter((checkpoint) => checkpoint.kind === "tool");
		const subscriptionRecords = records.filter((checkpoint) =>
			checkpoint.checkpointId.startsWith("workflow-subscription:"),
		);
		const eventRecords = records.filter((checkpoint) =>
			checkpoint.checkpointId.startsWith("workflow-subscription-event:"),
		);
		assert.equal(subscriptionRecords.length, 1);
		assert.deepEqual(subscriptionRecords[0]!.kind === "tool" ? subscriptionRecords[0]!.output : undefined, {
			subscription: `${SUBSCRIPTION}#1`,
			source: "synthetic-ci",
			mode: "child",
			maxConcurrent: 16,
			maxRate: null,
		});
		assert.equal(eventRecords.length, EVENT_COUNT);
		assert.equal(
			records.every((checkpoint) => checkpoint.kind !== "tool" || checkpoint.topology === undefined),
			true,
		);
	},
	THOUSAND_CHILDREN_TIMEOUT_MS,
);

async function runWorkflow(
	run_: (ctx: Parameters<WorkflowDefinition["run"]>[0]) => Promise<void>,
	backend?: MemoryJournalBackend,
	runId = "44444444-4444-4444-8444-000000004311",
) {
	const journal = backend ?? (await createMemoryTestBackend());
	const definition = workflow({
		name: "subscription-case",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await run_(ctx as Parameters<WorkflowDefinition["run"]>[0]);
			return {};
		},
	}) as WorkflowDefinition;
	const result = await run(
		definition,
		{},
		{
			runId,
			store: createStore(),
			durableBackend: journal,
			adapters: { agentSession: { create: async () => subscriberSession() } },
		},
	);
	return { result, backend: journal, runId };
}

function openSource(id: string): EventSource {
	return { id, start: () => {} };
}

function listSource(id: string, events: readonly SubscriptionEvent[]): EventSource {
	return {
		id,
		start: async (_signal, emit) => {
			for (const event of events) emit(event);
		},
	};
}

test("resuming a run does not process an event id twice (#4311)", async () => {
	const handled: string[] = [];
	const events = ["a", "b", "c"].map((id) => ({ id }));
	const first = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		await ctx.subscribe(listSource("list", events), async (event) => {
			handled.push(event.id);
		}).done;
	});
	assert.equal(first.result.status, "completed");
	const second = await runWorkflow(
		async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			const stats = await ctx.subscribe(listSource("list", [...events, { id: "d" }]), async (event) => {
				handled.push(event.id);
			}).done;
			assert.equal(stats.duplicates, 3);
		},
		first.backend,
		first.runId,
	);
	assert.equal(second.result.status, "completed", second.result.error);
	assert.deepEqual(handled, ["a", "b", "c", "d"]);
	const openable = await listOpenableCompletedWorkflows(second.backend);
	const entry = openable.find((candidate) => candidate.workflowId === second.runId);
	assert.ok(entry !== undefined, "subscription records must not hide a completed run from its catalog");
	const snapshot = await completedWorkflowSnapshot(second.backend, entry);
	assert.deepEqual(
		snapshot?.toolNodes.map((node) => node.name),
		[],
	);
});

test("ctx.events yields each event once, inline, in arrival order (#4311)", async () => {
	const seen: string[] = [];
	const { result } = await runWorkflow(async (ctx) => {
		const watcher = ctx.stage("log-reader");
		await watcher.prompt("read the build log");
		for await (const event of ctx.events(
			listSource("log", [
				{ id: "1", payload: "a" },
				{ id: "2", payload: "b" },
				{ id: "1", payload: "a" },
				{ id: "3", payload: "c" },
			]),
		)) {
			seen.push(`${event.id}:${String(event.payload)}`);
			await watcher.sendUserMessage(`log line ${String(event.payload)}`);
		}
	});
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(seen, ["1:a", "2:b", "3:c"]);
});

test("an inline stream left early is closed and leaves no subscription open (#4311)", async () => {
	const seen: string[] = [];
	const { result, backend, runId } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		const stream = ctx.events(listSource("early", [{ id: "x" }, { id: "y" }, { id: "z" }]));
		for await (const event of stream) {
			seen.push(event.id);
			if (event.id === "y") break;
		}
		assert.equal(stream.stats().handled, 2);
	});
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(seen, ["x", "y"]);
	const processed = backend
		.listCheckpoints(runId)
		.filter((checkpoint) => checkpoint.checkpointId.startsWith("workflow-subscription-event:"));
	assert.equal(processed.length, 2);
});

test("a run body that returns closes its open subscriptions and drains admitted events (#4311)", async () => {
	const handled: string[] = [];
	let sourceSignal: AbortSignal | undefined;
	const { result } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		const subscription = ctx.subscribe(
			{
				id: "forever",
				start: (signal) => {
					sourceSignal = signal;
				},
			},
			async (event) => {
				handled.push(event.id);
			},
		);
		publishEvent(subscription.id, { id: "first" });
		publishEvent(subscription.id, { id: "second" });
	});
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(handled, ["first", "second"]);
	assert.equal(sourceSignal, undefined);
});

test("an unobserved handler failure fails the run with a typed error (#4311)", async () => {
	const { result } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		const subscription = ctx.subscribe(openSource("boom"), async () => {
			throw new Error("triage crashed");
		});
		publishEvent(subscription.id, { id: "e1" });
	});
	assert.equal(result.status, "failed", JSON.stringify(result));
	assert.match(result.error ?? "", /handler-failed/);
});

test("an observed handler failure rejects done with SubscriptionHandlerError (#4311)", async () => {
	let caught: unknown;
	const { result } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		try {
			await ctx.subscribe(listSource("boom", [{ id: "e1" }]), async () => {
				throw new Error("triage crashed");
			}).done;
		} catch (error) {
			caught = error;
		}
	});
	assert.equal(result.status, "completed", result.error);
	assert.equal(isSubscriptionHandlerError(caught), true);
	assert.equal((caught as { eventId?: string }).eventId, "e1");
});

test("invalid ctx.subscribe options throw SubscriptionConfigError before anything is recorded (#4311)", async () => {
	const failures: unknown[] = [];
	const { result, backend, runId } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		const attempts: Array<() => unknown> = [
			() => ctx.subscribe({ id: "", start: () => {} }, async () => {}),
			() => ctx.subscribe(listSource("s", []), undefined as never),
			() => ctx.subscribe(listSource("s", []), async () => {}, { maxConcurrent: 0 }),
			() => ctx.subscribe(listSource("s", []), async () => {}, { maxRate: { events: 1, intervalMs: 0.5 } }),
			() => ctx.subscribe(listSource("s", []), async () => {}, { subscriber: {} as never }),
			() => ctx.subscribe(listSource("s", []), async () => {}, { name: "" }),
			() => ctx.subscribe(listSource("s", []), async () => {}, { name: 42 as never }),
			() => ctx.events(listSource("s", []), { maxRate: { events: -1, intervalMs: 10 } }),
		];
		for (const attempt of attempts) {
			try {
				attempt();
			} catch (error) {
				failures.push(error);
			}
		}
	});
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(
		failures.map((error) =>
			isSubscriptionConfigError(error)
				? [(error as { field: string }).field, (error as { reason: string }).reason]
				: error,
		),
		[
			["source", "not-event-source"],
			["handler", "not-function"],
			["options.maxConcurrent", "not-positive-integer"],
			["options.maxRate.intervalMs", "not-positive-integer"],
			["options.subscriber", "not-stage"],
			["options.name", "not-string"],
			["options.name", "not-string"],
			["options.maxRate.events", "not-positive-integer"],
		],
	);
	assert.equal(
		backend.listCheckpoints(runId).some((checkpoint) => checkpoint.checkpointId.startsWith("workflow-subscription")),
		false,
	);
});

test("without a subscriber stage, reports become run notices (#4311)", async () => {
	const store = createStore();
	const backend = await createMemoryTestBackend();
	const definition = workflow({
		name: "notice-reports",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			await ctx.subscribe(listSource("alerts", [{ id: "p1" }, { id: "p2" }]), async (event, child) => {
				if (event.id === "p2") await child.report("p2 needs attention");
			}).done;
			return {};
		},
	}) as WorkflowDefinition;
	const result = await run(
		definition,
		{},
		{
			runId: "55555555-5555-4555-8555-000000004311",
			store,
			durableBackend: backend,
			adapters: { agentSession: { create: async () => subscriberSession() } },
		},
	);
	assert.equal(result.status, "completed", result.error);
	const notices = store.notices().filter((notice) => notice.runId === "55555555-5555-4555-8555-000000004311");
	assert.deepEqual(
		notices.map((notice) => notice.message),
		['Report from event child "alerts#1/p2" (event p2):\n\np2 needs attention'],
	);
});

test("event children hang under the subscriber even when another stage settled after it (#4311)", async () => {
	const { result } = await runWorkflow(async (ctx) => {
		const watcher = ctx.stage("watcher");
		await watcher.prompt("watch");
		await ctx.stage("between").prompt("unrelated");
		await ctx.subscribe(
			listSource("graph", [{ id: "g1" }]),
			async (_event, child) => {
				await child.task({ prompt: "look" });
			},
			{ subscriber: watcher },
		).done;
	});
	assert.equal(result.status, "completed", result.error);
	const watcher = result.stages.find((stage) => stage.name === "watcher")!;
	const child = result.stages.find((stage) => stage.name === "graph#1/g1")!;
	assert.deepEqual(child.parentIds, [watcher.id]);
});

test("a subscriber declared while the run is paused is created on resume and still parents its event children (#4311)", async () => {
	const store = createStore();
	const backend = await createMemoryTestBackend();
	const runId = "77777777-7777-4777-8777-000000004311";
	const declared = (name: string): boolean => store.run(runId)?.stages.some((stage) => stage.name === name) === true;
	const observed: Record<string, boolean> = {};
	const definition = workflow({
		name: "paused-subscriber",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			await pauseRun(runId, { store });
			const watcher = ctx.stage("watcher");
			observed.watcherWhilePaused = declared("watcher");
			await resumeRun(runId, { store });
			await watcher.prompt("watch");
			const between = ctx.stage("between");
			observed.betweenOnDeclaration = declared("between");
			await between.prompt("unrelated");
			await ctx.subscribe(
				listSource("paused", [{ id: "p1" }]),
				async (_event, child) => {
					await child.task({ prompt: "look" });
				},
				{ subscriber: watcher },
			).done;
			return {};
		},
	}) as WorkflowDefinition;
	const result = await run(
		definition,
		{},
		{
			runId,
			store,
			durableBackend: backend,
			adapters: { agentSession: { create: async () => subscriberSession() } },
		},
	);
	assert.equal(result.status, "completed", result.error);
	const watcher = result.stages.find((stage) => stage.name === "watcher")!;
	assert.deepEqual(result.stages.find((stage) => stage.name === "paused#1/p1")!.parentIds, [watcher.id]);
	assert.deepEqual(observed, { watcherWhilePaused: false, betweenOnDeclaration: true });
});

test("a failing run stops its open subscriptions at once and drops their queued events (#4311)", async () => {
	const handled: string[] = [];
	const signals: AbortSignal[] = [];
	const gate = Promise.withResolvers<void>();
	const bodyError = new Error("body failed");
	let subscription: WorkflowSubscription | undefined;
	let doneReason: unknown;
	const { result } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		subscription = ctx.subscribe(
			{
				id: "stopping",
				start: (signal) => {
					signals.push(signal);
				},
			},
			async (event) => {
				handled.push(event.id);
				await gate.promise;
			},
			{ maxConcurrent: 1 },
		);
		void subscription.done.catch((error: unknown) => {
			doneReason = error;
		});
		for (const id of ["s1", "s2", "s3"]) publishEvent(subscription.id, { id });
		await turnsUntil(() => handled.length === 1);
		throw bodyError;
	});
	assert.equal(result.status, "failed");
	assert.equal(signals.length, 1);
	assert.equal(signals[0]!.aborted, true);
	assert.deepEqual(
		{ queued: subscription!.stats().queued, active: subscription!.stats().active },
		{ queued: 0, active: 1 },
	);
	gate.resolve();
	await turnsUntil(() => doneReason !== undefined);
	assert.equal(doneReason, bodyError);
	assert.deepEqual(handled, ["s1"]);
});

test("cancelling the run cancels its subscriptions and aborts running handlers (#4311)", async () => {
	const controller = new AbortController();
	let handlerSignal: AbortSignal | undefined;
	let doneReason: unknown;
	const definition = workflow({
		name: "cancelled-subscription",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			const subscription = ctx.subscribe(openSource("cancelled"), (_event, child) => {
				void child;
				return new Promise<void>(() => {});
			});
			void subscription.done.catch((error: unknown) => {
				doneReason = error;
			});
			ctx.subscribe(openSource("cancelled-signal"), async (_event) => {
				await new Promise<void>(() => {});
			});
			publishEvent(subscription.id, { id: "c1" });
			await new Promise((resolve) => setTimeout(resolve, 10));
			controller.abort(new Error("operator cancelled"));
			await new Promise<void>(() => {});
			return {};
		},
	}) as WorkflowDefinition;
	const result = await run(
		definition,
		{},
		{
			runId: "88888888-8888-4888-8888-000000004311",
			store: createStore(),
			durableBackend: await createMemoryTestBackend(),
			signal: controller.signal,
			adapters: { agentSession: { create: async () => subscriberSession() } },
		},
	);
	assert.equal(result.status, "killed");
	assert.deepEqual(
		{ kind: result.failure?.kind, code: result.failure?.code },
		{ kind: "cancelled", code: "cancelled" },
	);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal((doneReason as Error | undefined)?.message, "operator cancelled");
	void handlerSignal;
});

test("subscriber, report and inline-stream inputs are validated with typed errors (#4311)", async () => {
	const fields: string[][] = [];
	const record = (error: unknown): void => {
		fields.push(
			isSubscriptionConfigError(error)
				? [(error as { field: string }).field, (error as { reason: string }).reason]
				: [String(error)],
		);
	};
	const { result, backend, runId } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		for (const subscriber of ["stage", null, { sendUserMessage: async () => {} }, { name: "watcher" }]) {
			try {
				ctx.subscribe(listSource("s", []), async () => {}, { subscriber: subscriber as never });
			} catch (error) {
				record(error);
			}
		}
		for (const attempt of [
			() => ctx.events({ id: "", start: () => {} }),
			() => ctx.events(listSource("e", []), { name: "" }),
			() => ctx.events(listSource("e", []), { name: 42 as never }),
			() => ctx.events(listSource("e", []), { maxRate: { events: 1, intervalMs: 0 } }),
		]) {
			try {
				attempt();
			} catch (error) {
				record(error);
			}
		}
		await ctx
			.subscribe(listSource("bad-report", [{ id: "r1" }]), async (_event, child) => {
				await child.report(7 as never);
			})
			.done.catch((error: Error) => record(error.cause));
	});
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(fields, [
		["options.subscriber", "not-stage"],
		["options.subscriber", "not-stage"],
		["options.subscriber", "not-stage"],
		["options.subscriber", "not-stage"],
		["source", "not-event-source"],
		["options.name", "not-string"],
		["options.name", "not-string"],
		["options.maxRate.intervalMs", "not-positive-integer"],
		["report.text", "not-string"],
	]);
	assert.equal(
		backend
			.listCheckpoints(runId)
			.filter((checkpoint) => checkpoint.checkpointId.startsWith("workflow-subscription:")).length,
		1,
	);
});

test("reports steer the subscriber, keep the author's custom tools, and refuse late calls (#4311)", async () => {
	const deliveries: Array<{ readonly text: string; readonly deliverAs?: string }> = [];
	const toolNames: string[][] = [];
	let kept: { report(text: string): Promise<void> } | undefined;
	const definition = workflow({
		name: "report-delivery",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const watcher = ctx.stage("watcher");
			await watcher.prompt("watch");
			const subscriber = {
				name: watcher.name,
				sendUserMessage: async (text: string, options?: { readonly deliverAs?: "steer" | "followUp" }) => {
					deliveries.push({ text, ...(options?.deliverAs === undefined ? {} : { deliverAs: options.deliverAs }) });
				},
			};
			await ctx.subscribe(
				listSource("tools", [{ id: "t1" }]),
				async (_event, child) => {
					kept = child;
					await child.task({
						prompt: "inspect",
						customTools: [
							{
								name: "author_tool",
								label: "Author tool",
								description: "kept",
								parameters: { type: "object", properties: {} } as never,
								execute: async () => ({ content: [], details: undefined }),
							},
						],
					});
					await child.report("t1 matters");
				},
				{ subscriber },
			).done;
			return {};
		},
	}) as WorkflowDefinition;
	const result = await run(
		definition,
		{},
		{
			runId: "99999999-9999-4999-8999-000000004311",
			store: createStore(),
			durableBackend: await createMemoryTestBackend(),
			adapters: {
				agentSession: {
					create: async (options) => {
						toolNames.push((options.customTools ?? []).map((tool) => tool.name));
						return subscriberSession();
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(deliveries, [
		{ text: 'Report from event child "tools#1/t1" (event t1):\n\nt1 matters', deliverAs: "steer" },
	]);
	assert.deepEqual(toolNames.at(-1), ["author_tool", "report_to_subscriber"]);
	await assert.rejects(kept!.report("late"), (error) => {
		assert.equal(isSubscriptionClosedError(error), true);
		assert.deepEqual(
			{ operation: (error as { operation: string }).operation, code: (error as { code: string }).code },
			{ operation: "report", code: "subscription-closed" },
		);
		assert.equal(
			(error as { subscriptionId: string }).subscriptionId,
			"99999999-9999-4999-8999-000000004311/tools#1",
		);
		return true;
	});
});

test("reports without a subscriber get one notice each (#4311)", async () => {
	const store = createStore();
	const result = await run(
		workflow({
			name: "many-notices",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("anchor").prompt("start");
				await ctx.subscribe(
					listSource("n", [{ id: "a" }, { id: "b" }]),
					async (event, child) => {
						await child.report(`${event.id} one`);
						await child.report(`${event.id} two`);
					},
					{ maxConcurrent: 1 },
				).done;
				return {};
			},
		}) as WorkflowDefinition,
		{},
		{
			runId: "aaaaaaaa-aaaa-4aaa-8aaa-000000004311",
			store,
			durableBackend: await createMemoryTestBackend(),
			adapters: { agentSession: { create: async () => subscriberSession() } },
		},
	);
	assert.equal(result.status, "completed", result.error);
	const notices = store.notices().filter((notice) => notice.runId === "aaaaaaaa-aaaa-4aaa-8aaa-000000004311");
	assert.deepEqual(
		notices.map((notice) => notice.id.split("/").at(-1)),
		["n#1:report:1", "n#1:report:2", "n#1:report:3", "n#1:report:4"],
	);
	assert.deepEqual(
		notices.map((notice) => notice.level),
		["info", "info", "info", "info"],
	);
});

test("inline streams record their mode, honour maxRate, and close or throw cleanly (#4311)", async () => {
	const seen: string[] = [];
	const { result, backend, runId } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		const first = ctx.events(listSource("inline", [{ id: "1" }, { id: "2" }]), {
			maxRate: { events: 5, intervalMs: 1000 },
		});
		assert.equal(first.id.endsWith("/inline#1"), true);
		const stats = await first.close();
		assert.equal(stats.handled, 0);
		assert.deepEqual(await first.next(), { value: undefined, done: true });
		const second = ctx.events(listSource("inline", [{ id: "3" }, { id: "4" }]));
		const step = await second.next();
		seen.push(step.value?.id ?? "none");
		await assert.rejects(second.throw?.(new Error("stop reading")) ?? Promise.resolve(), /stop reading/);
		const third = ctx.events(openSource("named-only"), { name: "custom" });
		assert.equal(third.id.endsWith("/custom#1"), true);
		publishEvent(third.id, { id: "x" });
		const got = await third.next();
		seen.push(got.value?.id ?? "none");
		assert.deepEqual(await third.return?.(), { value: undefined, done: true });
	});
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(seen, ["3", "x"]);
	const records = backend
		.listCheckpoints(runId)
		.flatMap((checkpoint) =>
			checkpoint.kind === "tool" && checkpoint.checkpointId.startsWith("workflow-subscription:")
				? [checkpoint.output]
				: [],
		);
	assert.deepEqual(records, [
		{
			subscription: "inline#1",
			source: "inline",
			mode: "inline",
			maxConcurrent: 1,
			maxRate: { events: 5, intervalMs: 1000 },
		},
		{ subscription: "inline#2", source: "inline", mode: "inline", maxConcurrent: 1, maxRate: null },
		{ subscription: "custom#1", source: "named-only", mode: "inline", maxConcurrent: 1, maxRate: null },
	]);
	const processed = backend
		.listCheckpoints(runId)
		.flatMap((checkpoint) =>
			checkpoint.kind === "tool" && checkpoint.checkpointId.startsWith("workflow-subscription-event:")
				? [(checkpoint.output as { eventId: string }).eventId]
				: [],
		);
	assert.deepEqual(processed.sort(), ["x"]);
});

test("an event child replayed from cache after a resume stays detached while replayed main-line stages stay attached (#4311)", async () => {
	const backend = await createMemoryTestBackend();
	const runId = "bbbbbbbb-bbbb-4bbb-8bbb-000000004311";
	let failFirst = true;
	let pass = 0;
	const definition = workflow({
		name: "cached-event-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const watcher = ctx.stage("watcher");
			await watcher.prompt("watch");
			await ctx.task("plain", { prompt: "main-line work" });
			await ctx
				.subscribe(
					listSource("cached", [{ id: "c1" }]),
					async (_event, child) => {
						await child.task({ prompt: "inspect" });
						if (failFirst) {
							failFirst = false;
							throw new Error("crashed after the child finished");
						}
					},
					{ subscriber: watcher },
				)
				.done.catch(() => undefined);
			pass += 1;
			await ctx.stage(`after-${pass}`).prompt("continue");
			return {};
		},
	}) as WorkflowDefinition;
	const options = {
		runId,
		durableBackend: backend,
		adapters: { agentSession: { create: async () => subscriberSession() } },
	};
	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
	const second = await run(definition, {}, { ...options, store: createStore() });
	assert.equal(second.status, "completed", second.error);
	const child = second.stages.find((stage) => stage.name === "cached#1/c1");
	assert.ok(child !== undefined, JSON.stringify(second.stages.map((stage) => stage.name)));
	const after = second.stages.find((stage) => stage.name === "after-2")!;
	assert.equal(after.parentIds.includes(child.id), false);
	assert.deepEqual(after.parentIds, [second.stages.find((stage) => stage.name === "plain")!.id]);
	assert.deepEqual(child.parentIds, [second.stages.find((stage) => stage.name === "watcher")!.id]);
});

function processedEventIds(backend: MemoryJournalBackend, runId: string): string[] {
	return backend
		.listCheckpoints(runId)
		.flatMap((checkpoint) =>
			checkpoint.kind === "tool" && checkpoint.checkpointId.startsWith("workflow-subscription-event:")
				? [(checkpoint.output as { eventId: string }).eventId]
				: [],
		)
		.sort();
}

function subscriptionRecords(backend: MemoryJournalBackend, runId: string): unknown[] {
	return backend
		.listCheckpoints(runId)
		.flatMap((checkpoint) =>
			checkpoint.kind === "tool" && checkpoint.checkpointId.startsWith("workflow-subscription:")
				? [checkpoint.output]
				: [],
		);
}

const EVENT_LOOP_TURNS = 1_000;

function nextTurn(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Turns the event loop until `ready()` holds. Bounded by turns, not by a clock. */
async function turnsUntil(ready: () => boolean): Promise<void> {
	for (let turn = 0; turn < EVENT_LOOP_TURNS && !ready(); turn++) await nextTurn();
	assert.equal(ready(), true, `condition not reached within ${EVENT_LOOP_TURNS} event-loop turns`);
}

async function settlesWithinTurns(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	const mark = (): void => {
		settled = true;
	};
	void promise.then(mark, mark);
	for (let turn = 0; turn < EVENT_LOOP_TURNS && !settled; turn++) await nextTurn();
	return settled;
}

/** A source that stays open after emitting `events`, recording the signal it was started with. */
function heldOpenSource(id: string, events: readonly SubscriptionEvent[], signals: AbortSignal[]): EventSource {
	return {
		id,
		start: (signal, emit) => {
			signals.push(signal);
			for (const event of events) emit(event);
		},
	};
}

test("without a subscriber, event children hang under the stages that settled before ctx.subscribe (#4311)", async () => {
	const { result } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		await ctx.subscribe(listSource("orphans", [{ id: "o1" }]), async (_event, child) => {
			await child.task({ prompt: "look" });
		}).done;
	});
	assert.equal(result.status, "completed", result.error);
	const anchor = result.stages.find((stage) => stage.name === "anchor")!;
	assert.deepEqual(result.stages.find((stage) => stage.name === "orphans#1/o1")!.parentIds, [anchor.id]);
});

test("ctx.subscribe admits events no faster than maxRate (#4311)", async () => {
	const started: string[] = [];
	const stop = new Error("stop once the rate cap is observed");
	let observed: SubscriptionStats | undefined;
	const { result } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		const subscription = ctx.subscribe(
			openSource("rated"),
			async (event) => {
				started.push(event.id);
			},
			{ maxRate: { events: 1, intervalMs: 3_600_000 } },
		);
		void subscription.done.catch(() => undefined);
		for (const id of ["r1", "r2", "r3"]) publishEvent(subscription.id, { id });
		await turnsUntil(() => subscription.stats().handled === 1);
		observed = subscription.stats();
		throw stop;
	});
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /stop once the rate cap is observed/);
	assert.deepEqual(started, ["r1"]);
	assert.deepEqual({ handled: observed?.handled, queued: observed?.queued }, { handled: 1, queued: 2 });
});

test("an event child's seed puts the event after the task text, or stands alone, and adds only the report tool (#4311)", async () => {
	const seeds: string[] = [];
	const tools: Array<Array<{ readonly name: string; readonly description: string }>> = [];
	const definition = workflow({
		name: "seeded-children",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			await ctx.subscribe(
				listSource("seeded", [{ id: "s1" }, { id: "s2" }]),
				async (event, child) => {
					await child.task(event.id === "s1" ? { task: "Triage the check." } : {});
				},
				{ maxConcurrent: 1 },
			).done;
			return {};
		},
	}) as WorkflowDefinition;
	const result = await run(
		definition,
		{},
		{
			runId: "cccccccc-cccc-4ccc-8ccc-000000004311",
			store: createStore(),
			durableBackend: await createMemoryTestBackend(),
			adapters: {
				agentSession: {
					create: async (options, meta) => {
						if (meta?.stageName.startsWith("seeded#1/") !== true) return subscriberSession();
						tools.push(
							(options.customTools ?? []).map((tool) => ({
								name: tool.name,
								description: tool.description,
							})),
						);
						return {
							...mockSession(),
							async prompt(text: string) {
								seeds.push(text);
							},
						};
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.equal(seeds.length, 2);
	assert.equal(seeds[0]!.startsWith("Triage the check.\n\n## Event\nSubscription: seeded\nEvent id: s1\n"), true);
	assert.equal(seeds[1]!.startsWith("\n\n## Event\nSubscription: seeded\nEvent id: s2\n"), true);
	for (const childTools of tools) {
		assert.deepEqual(
			childTools.map((tool) => tool.name),
			[SUBSCRIPTION_REPORT_TOOL_NAME],
		);
		assert.match(childTools[0]!.description, /to the stage that subscribed to it/);
	}
});

test("a resumed inline stream skips the events it already yielded (#4311)", async () => {
	const seen: string[] = [];
	const first = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		for await (const event of ctx.events(listSource("tail", [{ id: "a" }, { id: "b" }]))) seen.push(event.id);
	});
	assert.equal(first.result.status, "completed", first.result.error);
	let duplicates = -1;
	const second = await runWorkflow(
		async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			const stream = ctx.events(listSource("tail", [{ id: "a" }, { id: "b" }, { id: "c" }]));
			for await (const event of stream) seen.push(event.id);
			duplicates = stream.stats().duplicates;
		},
		first.backend,
		first.runId,
	);
	assert.equal(second.result.status, "completed", second.result.error);
	assert.deepEqual(seen, ["a", "b", "c"]);
	assert.equal(duplicates, 2);
});

test("an inline event counts as processed when the body closes the stream, not when the run ends holding it (#4311)", async () => {
	const first = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		const closed = ctx.events(listSource("closed", [{ id: "c1" }, { id: "c2" }]));
		assert.equal((await closed.next()).value?.id, "c1");
		await closed.close();
		const held = ctx.events(listSource("held", [{ id: "h1" }, { id: "h2" }]));
		assert.equal((await held.next()).value?.id, "h1");
	});
	assert.equal(first.result.status, "completed", first.result.error);
	assert.deepEqual(processedEventIds(first.backend, first.runId), ["c1"]);
	const resumed: string[] = [];
	const second = await runWorkflow(
		async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			for await (const event of ctx.events(listSource("held", [{ id: "h1" }, { id: "h2" }]))) {
				resumed.push(event.id);
			}
		},
		first.backend,
		first.runId,
	);
	assert.equal(second.result.status, "completed", second.result.error);
	assert.deepEqual(resumed, ["h1", "h2"]);
});

test("a failing run releases a held inline event unprocessed and stops its source (#4311)", async () => {
	const signals: AbortSignal[] = [];
	let stream: WorkflowEventStream | undefined;
	const { result, backend, runId } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		stream = ctx.events(heldOpenSource("failing-inline", [{ id: "f1" }, { id: "f2" }], signals));
		assert.equal((await stream.next()).value?.id, "f1");
		throw new Error("body failed while reading");
	});
	assert.equal(result.status, "failed");
	assert.equal(signals[0]?.aborted, true);
	await assert.rejects(stream!.next(), /body failed while reading/);
	await turnsUntil(() => stream!.stats().active === 0);
	assert.deepEqual(processedEventIds(backend, runId), []);
});

test("cancelling a run cancels its inline streams at once and releases a held event unprocessed (#4311)", async () => {
	const controller = new AbortController();
	const signals: AbortSignal[] = [];
	const backend = await createMemoryTestBackend();
	const runId = "dddddddd-dddd-4ddd-8ddd-000000004311";
	let stream: WorkflowEventStream | undefined;
	let sourceAbortedAtCancel: boolean | undefined;
	const definition = workflow({
		name: "cancelled-inline",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			stream = ctx.events(heldOpenSource("cancelled-inline", [{ id: "k1" }, { id: "k2" }], signals));
			assert.equal((await stream.next()).value?.id, "k1");
			controller.abort(new Error("operator cancelled"));
			sourceAbortedAtCancel = signals[0]?.aborted;
			await new Promise<void>(() => {});
			return {};
		},
	}) as WorkflowDefinition;
	const result = await run(
		definition,
		{},
		{
			runId,
			store: createStore(),
			durableBackend: backend,
			signal: controller.signal,
			adapters: { agentSession: { create: async () => subscriberSession() } },
		},
	);
	assert.equal(result.status, "killed");
	assert.equal(sourceAbortedAtCancel, true);
	await assert.rejects(stream!.next(), /operator cancelled/);
	await turnsUntil(() => stream!.stats().active === 0);
	assert.deepEqual(processedEventIds(backend, runId), []);
});

test("closing an inline stream while its next event is being admitted neither hangs nor yields it later (#4311)", async () => {
	const yielded = new Map<number, boolean>();
	const { result, backend, runId } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		for (let delay = 0; delay < 64; delay++) {
			const stream = ctx.events(listSource(`race-${delay}`, [{ id: "x" }, { id: "y" }]));
			assert.equal((await stream.next()).value?.id, "x");
			const pending = stream.next();
			for (let tick = 0; tick < delay; tick++) await Promise.resolve();
			const closing = stream.close();
			assert.equal(await settlesWithinTurns(closing), true, `close() hung ${delay} microtasks after next()`);
			const after = await pending;
			assert.equal(after.done === true || after.value?.id === "y", true);
			yielded.set(delay, after.value?.id === "y");
			assert.deepEqual(await stream.next(), { value: undefined, done: true });
		}
	});
	assert.equal(result.status, "completed", result.error);
	for (const [delay, gotY] of yielded) {
		assert.equal(
			subscriptionEventProcessed(backend, runId, `race-${delay}#1`, "y"),
			gotY,
			`y must count as processed exactly when the body saw it (delay ${delay})`,
		);
	}
	assert.equal([...yielded.values()].includes(false), true);
});

test("a resumed subscription keeps its first durable record and writes no journal entry for it again (#4311)", async () => {
	const first = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		await ctx.subscribe(listSource("once", [{ id: "a" }]), async () => {}, { maxConcurrent: 2 }).done;
	});
	assert.equal(first.result.status, "completed", first.result.error);
	const commits: string[] = [];
	const commitCheckpoint = first.backend.commitCheckpoint.bind(first.backend);
	first.backend.commitCheckpoint = (checkpoint, options) => {
		commits.push(checkpoint.checkpointId);
		return commitCheckpoint(checkpoint, options);
	};
	const second = await runWorkflow(
		async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			await ctx.subscribe(listSource("once", [{ id: "a" }]), async () => {}, { maxConcurrent: 3 }).done;
		},
		first.backend,
		first.runId,
	);
	assert.equal(second.result.status, "completed", second.result.error);
	assert.deepEqual(subscriptionRecords(second.backend, second.runId), [
		{ subscription: "once#1", source: "once", mode: "child", maxConcurrent: 2, maxRate: null },
	]);
	assert.deepEqual(
		commits.filter((checkpointId) => checkpointId.startsWith("workflow-subscription")),
		[],
	);
});

test("ctx.events yields events no faster than maxRate (#4311)", async () => {
	let observed: SubscriptionStats | undefined;
	let tail: IteratorResult<SubscriptionEvent> | undefined;
	const { result } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		const stream = ctx.events(listSource("rated-inline", [{ id: "1" }, { id: "2" }]), {
			maxRate: { events: 1, intervalMs: 3_600_000 },
		});
		assert.equal((await stream.next()).value?.id, "1");
		const pending = stream.next();
		await turnsUntil(() => stream.stats().handled === 1);
		observed = stream.stats();
		await stream.close();
		tail = await pending;
	});
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual({ handled: observed?.handled, queued: observed?.queued }, { handled: 1, queued: 1 });
	assert.deepEqual(tail, { value: undefined, done: true });
});

test("a second same-name subscription gets its own child identity, so a resume never replays the first one's answer (#4311)", async () => {
	const backend = await createMemoryTestBackend();
	const runId = "eeeeeeee-eeee-4eee-8eee-000000004311";
	const answers: Record<string, string[]> = { first: [], second: [] };
	let interruptSecond = true;
	const definition = workflow({
		name: "same-name-subscriptions",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			await ctx.subscribe(
				listSource("dup", [{ id: "e1" }]),
				async (_event, child) => {
					answers.first!.push((await child.task({ prompt: "first instructions" })).text);
				},
				{ name: "dup" },
			).done;
			await ctx
				.subscribe(
					listSource("dup", [{ id: "e1" }]),
					async (_event, child) => {
						answers.second!.push((await child.task({ prompt: "second instructions" })).text);
						if (interruptSecond) {
							interruptSecond = false;
							throw new Error("interrupted after the child finished");
						}
					},
					{ name: "dup" },
				)
				.done.catch(() => undefined);
			return {};
		},
	}) as WorkflowDefinition;
	const answeringSession = (): StageSessionRuntime => {
		let instructions = "";
		return {
			...mockSession(),
			async prompt(text: string) {
				instructions = text.split("\n")[0]!;
			},
			getLastAssistantText() {
				return `answer to ${instructions}`;
			},
		};
	};
	const options = {
		runId,
		durableBackend: backend,
		adapters: { agentSession: { create: async () => answeringSession() } },
	};
	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
	const resumed = await run(definition, {}, { ...options, store: createStore() });
	assert.equal(resumed.status, "completed", resumed.error);
	assert.deepEqual(answers, {
		first: ["answer to first instructions"],
		second: ["answer to second instructions", "answer to second instructions"],
	});
	assert.deepEqual(
		resumed.stages.map((stage) => stage.name).filter((name) => name.endsWith("/e1")),
		["dup#2/e1"],
	);
});

test("a subscriber declared and prompted while the run is paused parents children whose tasks waited for the resume (#4311)", async () => {
	const store = createStore();
	const runId = "ffffffff-ffff-4fff-8fff-000000004311";
	const definition = workflow({
		name: "paused-prompted-subscriber",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			await pauseRun(runId, { store });
			const watcher = ctx.stage("watcher");
			const watching = watcher.prompt("watch");
			const subscription = ctx.subscribe(
				listSource("early", [{ id: "x1" }]),
				async (_event, child) => {
					await child.task({ prompt: "look" });
				},
				{ subscriber: watcher },
			);
			await turnsUntil(() => subscription.stats().active === 1);
			await resumeRun(runId, { store });
			await watching;
			await subscription.done;
			return {};
		},
	}) as WorkflowDefinition;
	const result = await run(
		definition,
		{},
		{
			runId,
			store,
			durableBackend: await createMemoryTestBackend(),
			adapters: { agentSession: { create: async () => subscriberSession() } },
		},
	);
	assert.equal(result.status, "completed", result.error);
	const watcher = result.stages.find((stage) => stage.name === "watcher")!;
	assert.deepEqual(result.stages.find((stage) => stage.name === "early#1/x1")!.parentIds, [watcher.id]);
});

interface ReplayedSubscriberCase {
	readonly runId: string;
	/** Where the subscriber's retained session can be found when the resumed run reopens it. */
	readonly retainedIn: "host" | "pool" | "nowhere";
	readonly registry?: StageControlRegistry;
	readonly beforeResume?: (watcherStageId: string) => void;
	/** The reopened session never finishes taking the report; the resumed run is cancelled once it started. */
	readonly cancelDuringReport?: boolean;
	/** The reopened session's turn ends a few event-loop turns after it took the report. */
	readonly turnEndsLater?: boolean;
	/** Disposing the reopened session fails. */
	readonly disposeFails?: boolean;
	/** A second relevant event arrives after the first, so the reopened session takes two reports. */
	readonly secondReport?: boolean;
	/** The reopened session refuses the report before any turn starts. */
	readonly reopenedRefuses?: boolean;
}

function writeRetainedSession(directory: string, sessionId: string): string {
	const sessionFile = join(directory, "watcher.jsonl");
	writeFileSync(
		sessionFile,
		`${[
			JSON.stringify({
				type: "session",
				version: 4,
				id: sessionId,
				createdAt: new Date(0).toISOString(),
				cwd: directory,
			}),
			JSON.stringify({
				type: "message",
				id: "watcher-message",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "watch", timestamp: 0 },
			}),
		].join("\n")}\n`,
	);
	return sessionFile;
}

/** Runs a subscriber whose first event fails before reporting, then resumes so the subscriber is replayed. */
async function runReplayedSubscriber(scenario: ReplayedSubscriberCase) {
	const directory = mkdtempSync(join(tmpdir(), "atomic-subscriber-replay-"));
	const poolDirectory = join(directory, "pool");
	mkdirSync(poolDirectory);
	const sessionStore = await JsonlSessionStore.open(directory, { exactDirectory: true });
	const sessionId = "watcher-session";
	const sessionFile =
		scenario.retainedIn === "nowhere"
			? join(directory, "watcher.jsonl")
			: writeRetainedSession(scenario.retainedIn === "host" ? directory : poolDirectory, sessionId);
	poolProbe.open = () => JsonlSessionStore.open(poolDirectory, { exactDirectory: true });
	const deliveries: Array<{ readonly session: string; readonly text: string; readonly deliverAs?: string }> = [];
	const disposed: string[] = [];
	const timeline: string[] = [];
	const delivering = Promise.withResolvers<void>();
	let watcherSessions = 0;
	const watcherSession = (): StageSessionRuntime => {
		watcherSessions += 1;
		const label = watcherSessions === 1 ? "live" : "reopened";
		const listeners = new Set<Listener>();
		let streaming = false;
		let subscribedWhileStreaming = 0;
		const emit = (type: string): void => {
			for (const listener of [...listeners]) listener({ type });
		};
		return {
			...mockSession(),
			sessionId,
			sessionFile,
			get isStreaming() {
				return streaming;
			},
			subscribe(listener) {
				listeners.add(listener as Listener);
				if (streaming) subscribedWhileStreaming += 1;
				return () => listeners.delete(listener as Listener);
			},
			async sendUserMessage(content, options) {
				deliveries.push({
					session: label,
					text: typeof content === "string" ? content : "",
					...(options?.deliverAs === undefined ? {} : { deliverAs: options.deliverAs }),
				});
				if (label === "reopened" && scenario.reopenedRefuses === true) throw new Error("missing credentials");
				if (label === "reopened" && scenario.cancelDuringReport === true) {
					streaming = true;
					delivering.resolve();
					await new Promise<void>(() => {});
				}
				if (label === "reopened" && scenario.turnEndsLater === true) {
					streaming = true;
					void (async () => {
						let updatesSeen = 0;
						for (let turn = 0; turn < EVENT_LOOP_TURNS && updatesSeen < 3; turn++) {
							await nextTurn();
							emit("message_update");
							if (subscribedWhileStreaming > 0) updatesSeen += 1;
						}
						streaming = false;
						timeline.push("turn ended");
						emit("agent_end");
					})();
				}
			},
			dispose() {
				disposed.push(label);
				timeline.push(`disposed ${label}`);
				if (label === "reopened" && scenario.disposeFails === true) throw new Error("dispose failed");
			},
		};
	};
	let failFirst = true;
	const failures: unknown[] = [];
	const definition = workflow({
		name: "replayed-subscriber",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const watcher = ctx.stage("watcher");
			await watcher.prompt("watch");
			await ctx
				.subscribe(
					listSource("ci", scenario.secondReport === true ? [{ id: "e1" }, { id: "e2" }] : [{ id: "e1" }]),
					async (event, child) => {
						if (failFirst) {
							failFirst = false;
							throw new Error("crashed before reporting");
						}
						await child.report(`${event.id} failed`);
					},
					{ subscriber: watcher, maxConcurrent: 1 },
				)
				.done.catch((error: unknown) => failures.push(error));
			return {};
		},
	}) as WorkflowDefinition;
	const options = {
		runId: scenario.runId,
		cwd: directory,
		durableBackend: await createMemoryTestBackend(),
		...(scenario.registry === undefined ? {} : { stageControlRegistry: scenario.registry }),
		adapters: {
			sessionStore,
			agentSession: {
				create: async (_options: unknown, meta?: { readonly stageName: string }) =>
					meta?.stageName === "watcher" ? watcherSession() : subscriberSession(),
			},
		},
	};
	try {
		const first = await run(definition, {}, { ...options, store: createStore() });
		assert.equal(first.status, "completed", first.error);
		const watcherStageId = first.stages.find((stage) => stage.name === "watcher")!.id;
		scenario.beforeResume?.(watcherStageId);
		const controller = new AbortController();
		if (scenario.cancelDuringReport === true) {
			void delivering.promise.then(() => controller.abort(new Error("operator cancelled")));
		}
		const resumedStore = createStore();
		const resumed = await run(definition, {}, { ...options, store: resumedStore, signal: controller.signal });
		return { resumed, resumedStore, deliveries, disposed, timeline, failures: failures.slice(1), watcherStageId };
	} finally {
		poolProbe.open = undefined;
		await sessionStore.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

test("a subscriber replayed after a resume takes reports in its retained session, which the run lets go at its end (#4311)", async () => {
	const registry = createStageControlRegistry();
	const runId = "abababab-abab-4bab-8bab-000000004311";
	const { resumed, deliveries, disposed, failures, watcherStageId } = await runReplayedSubscriber({
		runId,
		retainedIn: "host",
		registry,
	});
	assert.equal(resumed.status, "completed", resumed.error);
	assert.deepEqual(failures, []);
	assert.deepEqual(deliveries, [
		{ session: "reopened", text: 'Report from event child "ci#1/e1" (event e1):\n\ne1 failed', deliverAs: "steer" },
	]);
	assert.deepEqual(
		disposed.filter((label) => label === "reopened"),
		["reopened"],
	);
	assert.equal(registry.get(runId, watcherStageId), undefined);
});

test("a replayed subscriber whose session ran on a local worker is reopened from the pool's session store (#4311)", async () => {
	const { resumed, deliveries, failures } = await runReplayedSubscriber({
		runId: "aeaeaeae-aeae-4eae-8eae-000000004311",
		retainedIn: "pool",
	});
	assert.equal(resumed.status, "completed", resumed.error);
	assert.deepEqual(failures, []);
	assert.deepEqual(
		deliveries.map((delivery) => delivery.session),
		["reopened"],
	);
});

test("cancelling a resumed run lets a reopened subscriber session go without waiting for its turn (#4311)", async () => {
	const registry = createStageControlRegistry();
	const runId = "afafafaf-afaf-4faf-8faf-000000004311";
	const { resumed, deliveries, disposed, watcherStageId } = await runReplayedSubscriber({
		runId,
		retainedIn: "host",
		registry,
		cancelDuringReport: true,
	});
	assert.equal(resumed.status, "killed");
	assert.deepEqual(
		deliveries.map((delivery) => delivery.session),
		["reopened"],
	);
	await turnsUntil(() => disposed.includes("reopened"));
	assert.equal(registry.get(runId, watcherStageId), undefined);
});

test("a replayed subscriber whose session cannot be reopened fails the report with a typed error (#4311)", async () => {
	const { resumed, resumedStore, deliveries, failures } = await runReplayedSubscriber({
		runId: "acacacac-acac-4cac-8cac-000000004311",
		retainedIn: "nowhere",
	});
	assert.equal(resumed.status, "completed", resumed.error);
	assert.deepEqual(deliveries, []);
	assert.deepEqual(
		resumedStore.notices().filter((notice) => notice.id.startsWith("workflow-subscriber-release:")),
		[],
	);
	assert.equal(failures.length, 1);
	assert.equal(isSubscriptionHandlerError(failures[0]), true);
	const cause = (failures[0] as { cause?: unknown }).cause;
	assert.equal(isSubscriptionSubscriberUnavailableError(cause), true);
	assert.deepEqual(
		{
			code: (cause as { code: string }).code,
			subscriber: (cause as { subscriber: string }).subscriber,
			reason: (cause as { reason: string }).reason,
			retryable: (cause as { retryable: boolean }).retryable,
		},
		{ code: "subscriber-unavailable", subscriber: "watcher", reason: "invalid-session", retryable: false },
	);
	assert.equal((cause as { subscriptionId: string }).subscriptionId, "acacacac-acac-4cac-8cac-000000004311/ci#1");
});

test("a replayed subscriber whose chat handle cannot admit messages fails the report with a typed error (#4311)", async () => {
	const registry = createStageControlRegistry();
	const runId = "adadadad-adad-4dad-8dad-000000004311";
	const { resumed, deliveries, failures } = await runReplayedSubscriber({
		runId,
		retainedIn: "host",
		registry,
		beforeResume: (watcherStageId) => {
			registry.getOrCreateDetached(
				runId,
				watcherStageId,
				() => ({ runId, stageId: watcherStageId, stageName: "watcher", isDisposed: false }) as StageControlHandle,
			);
		},
	});
	assert.equal(resumed.status, "completed", resumed.error);
	assert.deepEqual(deliveries, []);
	const cause = (failures[0] as { cause?: unknown }).cause;
	assert.equal(isSubscriptionSubscriberUnavailableError(cause), true);
	assert.equal((cause as { reason: string }).reason, "no-message-admission");
});

test("a resumed run waits for a reopened subscriber's turn before letting its session go (#4311)", async () => {
	const { resumed, timeline } = await runReplayedSubscriber({
		runId: "a1a1a1a1-a1a1-4a1a-8a1a-000000004311",
		retainedIn: "host",
		registry: createStageControlRegistry(),
		turnEndsLater: true,
	});
	assert.equal(resumed.status, "completed", resumed.error);
	assert.deepEqual(
		timeline.filter((entry) => entry !== "disposed live"),
		["turn ended", "disposed reopened"],
	);
});

test("a reopened subscriber session that fails to close leaves a run warning instead of failing the run (#4311)", async () => {
	const runId = "a2a2a2a2-a2a2-4a2a-8a2a-000000004311";
	const { resumed, resumedStore } = await runReplayedSubscriber({
		runId,
		retainedIn: "host",
		registry: createStageControlRegistry(),
		disposeFails: true,
	});
	assert.equal(resumed.status, "completed", resumed.error);
	const warnings = resumedStore
		.notices()
		.filter((notice) => notice.id === `workflow-subscriber-release:${runId}:watcher`);
	assert.deepEqual(
		warnings.map((notice) => notice.level),
		["warning"],
	);
	assert.match(warnings[0]!.message, /subscriber stage "watcher" could not be released: dispose failed/);
});

test("one reopened subscriber session takes every report of a resumed run and is let go once (#4311)", async () => {
	const registry = createStageControlRegistry();
	const runId = "a3a3a3a3-a3a3-4a3a-8a3a-000000004311";
	const { resumed, deliveries, disposed, watcherStageId } = await runReplayedSubscriber({
		runId,
		retainedIn: "host",
		registry,
		secondReport: true,
	});
	assert.equal(resumed.status, "completed", resumed.error);
	assert.deepEqual(
		deliveries.map((delivery) => `${delivery.session}:${delivery.text.split("\n").at(-1)}`),
		["reopened:e1 failed", "reopened:e2 failed"],
	);
	assert.deepEqual(
		disposed.filter((label) => label === "reopened"),
		["reopened"],
	);
	assert.equal(registry.get(runId, watcherStageId), undefined);
});

test("after a resume, reports to a subscriber first created in the resumed run reach its live session (#4311)", async () => {
	let pass = 0;
	let received: string[] = [];
	const body = async (ctx: Parameters<WorkflowDefinition["run"]>[0]) => {
		pass += 1;
		await ctx.stage("anchor").prompt("start");
		if (pass === 1) return;
		const late = ctx.stage("late-watcher");
		await late.prompt("watch");
		await ctx.subscribe(
			listSource("late", [{ id: "l1" }]),
			async (_event, child) => {
				await child.report("l1 matters");
			},
			{ subscriber: late },
		).done;
		received = late.messages.map(messageText).filter((text) => text.startsWith("Report from event child"));
	};
	const first = await runWorkflow(body);
	assert.equal(first.result.status, "completed", first.result.error);
	const second = await runWorkflow(body, first.backend, first.runId);
	assert.equal(second.result.status, "completed", second.result.error);
	assert.equal(second.result.stages.find((stage) => stage.name === "anchor")?.replayed, true);
	assert.deepEqual(received, ['Report from event child "late#1/l1" (event l1):\n\nl1 matters']);
});

interface CollidingSubscription {
	readonly source: string;
	readonly name?: string;
	readonly eventId: string;
}

/**
 * Runs two subscriptions whose event children would share a name under a `<name>/<event id>` scheme. The second one's
 * handler fails after its child finished, so a resume handles its event again and must replay its own child.
 */
async function runCollidingSubscriptions(
	first: CollidingSubscription,
	second: CollidingSubscription,
	earlierName?: string,
) {
	const backend = await createMemoryTestBackend();
	const runId = "c0111de0-0000-4000-8000-000000004311";
	const answers: { first: string[]; second: string[] } = { first: [], second: [] };
	let interruptSecond = true;
	const subscribeOnce = (
		ctx: Parameters<WorkflowDefinition["run"]>[0],
		spec: CollidingSubscription,
		which: "first" | "second",
	) =>
		ctx
			.subscribe(
				listSource(spec.source, [{ id: spec.eventId }]),
				async (_event, child) => {
					answers[which].push((await child.task({ prompt: `${which} instructions` })).text);
					if (which === "second" && interruptSecond) {
						interruptSecond = false;
						throw new Error("interrupted after the child finished");
					}
				},
				spec.name === undefined ? {} : { name: spec.name },
			)
			.done.catch(() => undefined);
	const definition = workflow({
		name: "colliding-subscriptions",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			if (earlierName !== undefined)
				await ctx.subscribe(listSource("earlier", []), async () => {}, { name: earlierName }).done;
			await subscribeOnce(ctx, first, "first");
			await subscribeOnce(ctx, second, "second");
			return {};
		},
	}) as WorkflowDefinition;
	const answeringSession = (): StageSessionRuntime => {
		let instructions = "";
		return {
			...mockSession(),
			async prompt(text: string) {
				instructions = text.split("\n")[0]!;
			},
			getLastAssistantText() {
				return `answer to ${instructions}`;
			},
		};
	};
	const options = {
		runId,
		durableBackend: backend,
		adapters: { agentSession: { create: async () => answeringSession() } },
	};
	const initial = await run(definition, {}, { ...options, store: createStore() });
	assert.equal(initial.status, "completed", initial.error);
	const resumed = await run(definition, {}, { ...options, store: createStore() });
	assert.equal(resumed.status, "completed", resumed.error);
	return {
		answers,
		children: initial.stages.map((stage) => stage.name).filter((name) => name !== "anchor"),
	};
}

for (const [label, first, second, earlierName] of [
	[
		"default names: webhook:/hooks + ci/abc vs webhook:/hooks/ci + abc",
		{ source: "webhook:/hooks", eventId: "ci/abc" },
		{ source: "webhook:/hooks/ci", eventId: "abc" },
		undefined,
	],
	[
		"names a + b/c vs a/b + c",
		{ source: "s1", name: "a", eventId: "b/c" },
		{ source: "s2", name: "a/b", eventId: "c" },
		undefined,
	],
	[
		"a user name ci#2 vs the second ci",
		{ source: "s1", name: "ci#2", eventId: "e" },
		{ source: "s2", name: "ci", eventId: "e" },
		"ci",
	],
] as const) {
	test(`event children of different subscriptions never share a durable identity: ${label} (#4311)`, async () => {
		const { answers, children } = await runCollidingSubscriptions(first, second, earlierName);
		assert.equal(new Set(children).size, children.length, JSON.stringify(children));
		assert.deepEqual(answers, {
			first: ["answer to first instructions"],
			second: ["answer to second instructions", "answer to second instructions"],
		});
	});
}

test("an event child's name is the subscription key and the escaped event id (#4311)", async () => {
	const { children } = await runCollidingSubscriptions(
		{ source: "webhook:/hooks", eventId: "ci/abc#1 %" },
		{ source: "webhook:/hooks", eventId: "x" },
	);
	assert.deepEqual(children, ["webhook:/hooks#1/ci%2Fabc%231%20%25", "webhook:/hooks#2/x"]);
});

test("a run whose only tracked work is a subscription or an inline stream completes, even when no event starts a child (#4311)", async () => {
	const runs = [
		async (ctx: Parameters<WorkflowDefinition["run"]>[0]) => {
			await ctx.subscribe(listSource("quiet", [{ id: "q1" }]), async () => {}).done;
		},
		async (ctx: Parameters<WorkflowDefinition["run"]>[0]) => {
			await ctx.subscribe(listSource("notices", [{ id: "n1" }]), async (_event, child) => {
				await child.report("n1 matters");
			}).done;
		},
		async (ctx: Parameters<WorkflowDefinition["run"]>[0]) => {
			for await (const event of ctx.events(listSource("inline-only", [{ id: "i1" }]))) void event;
		},
		async (ctx: Parameters<WorkflowDefinition["run"]>[0]) => {
			await ctx.tool("tool-only", {}, async () => 1);
		},
	];
	for (const [index, body] of runs.entries()) {
		const { result } = await runWorkflow(body, undefined, `f2f2f2f2-f2f2-4f2f-8f2f-00000000431${index}`);
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(result.stages, []);
	}
	const { result } = await runWorkflow(async () => {}, undefined, "f2f2f2f2-f2f2-4f2f-8f2f-000000004319");
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /without creating any workflow stages or durable tool nodes/);
});

test("an event child limited to an explicit tool list keeps report_to_subscriber in it (#4311)", async () => {
	const toolLists: Array<readonly string[] | undefined> = [];
	const definition = workflow({
		name: "restricted-children",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			await ctx.subscribe(
				listSource("limited", [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }]),
				async (event, child) => {
					const lists: Record<string, string[]> = {
						a: ["read"],
						b: ["+read", "-bash"],
						d: [],
						e: ["read", SUBSCRIPTION_REPORT_TOOL_NAME],
					};
					const tools = lists[event.id];
					await child.task(tools === undefined ? { prompt: "look" } : { prompt: "look", tools });
				},
				{ maxConcurrent: 1 },
			).done;
			return {};
		},
	}) as WorkflowDefinition;
	const result = await run(
		definition,
		{},
		{
			runId: "dededede-dede-4ede-8ede-000000004311",
			store: createStore(),
			durableBackend: await createMemoryTestBackend(),
			adapters: {
				agentSession: {
					create: async (options, meta) => {
						if (meta?.stageName.startsWith("limited#1/") === true) toolLists.push(options.tools);
						return subscriberSession();
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(toolLists, [
		["read", SUBSCRIPTION_REPORT_TOOL_NAME],
		["+read", "-bash"],
		undefined,
		[SUBSCRIPTION_REPORT_TOOL_NAME],
		["read", SUBSCRIPTION_REPORT_TOOL_NAME],
	]);
});

test("an event child interrupted after its session was recorded restarts from its seed on resume (#4311)", async () => {
	const backend = await createMemoryTestBackend();
	const runId = "d1d1d1d1-d1d1-4d1d-8d1d-000000004311";
	const childPrompts: string[] = [];
	let crashChild = true;
	const definition = workflow({
		name: "seeded-resume",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			await ctx.subscribe(
				listSource("deploys", [{ id: "d-7", type: "deploy", payload: { service: "api", ok: false } }]),
				async (_event, child) => {
					await child.task({ prompt: "Report failed deploys." });
				},
			).done;
			return {};
		},
	}) as WorkflowDefinition;
	const options = (sessionId: string): RunOpts => ({
		runId,
		durableBackend: backend,
		adapters: {
			agentSession: {
				create: async (_sessionOptions, meta) => {
					if (meta?.stageName !== "deploys#1/d-7") return mockSession();
					return {
						...mockSession(),
						sessionId,
						async prompt(text: string) {
							childPrompts.push(text);
							if (crashChild) {
								crashChild = false;
								throw new Error("the host went away mid-turn");
							}
						},
					};
				},
			},
		},
	});
	const first = await run(definition, {}, { ...options("child-session-1"), store: createStore() });
	assert.equal(first.status, "failed");
	const firstChild = first.stages.find((stage) => stage.name === "deploys#1/d-7");
	const resumed = await run(definition, {}, { ...options("child-session-2"), store: createStore() });
	assert.equal(resumed.status, "completed", resumed.error);
	assert.equal(childPrompts.length, 2);
	for (const prompt of childPrompts) {
		assert.match(prompt, /^Report failed deploys\./);
		assert.match(prompt, /^Event id: d-7$/m);
		assert.match(prompt, /"service": "api"/);
	}
	const resumedChild = resumed.stages.find((stage) => stage.name === "deploys#1/d-7");
	assert.ok(firstChild !== undefined && resumedChild !== undefined);
	assert.equal(resumedChild.id, firstChild.id);
});

test("a report returns once the subscriber admits it, without waiting for the subscriber's turn to end (#4311)", async () => {
	const order: string[] = [];
	const turnGate = Promise.withResolvers<void>();
	const listeners = new Set<Listener>();
	const watcherMessages: string[] = [];
	let turnActive = false;
	const emit = (type: string): void => {
		for (const listener of [...listeners]) listener({ type });
	};
	const watcherSession: StageSessionRuntime = {
		...mockSession(),
		async prompt(text: string) {
			emit("agent_start");
			watcherMessages.push(text);
			emit("agent_end");
		},
		async sendUserMessage(content, options) {
			watcherMessages.push(typeof content === "string" ? content : "");
			if (turnActive && options?.deliverAs === "steer") return;
			turnActive = true;
			emit("subscriber_queued");
			order.push("subscriber-queued");
			for (let turn = 0; turn < 3; turn++) await nextTurn();
			emit("agent_start");
			order.push("subscriber-turn-start");
			await turnGate.promise;
			order.push("subscriber-turn-end");
			turnActive = false;
			emit("agent_end");
		},
		subscribe(listener) {
			listeners.add(listener as Listener);
			return () => listeners.delete(listener as Listener);
		},
	};
	const definition = workflow({
		name: "unblocked-reports",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const watcher = ctx.stage("watcher");
			await watcher.prompt("watch");
			await ctx.subscribe(
				listSource("alerts", [{ id: "a" }, { id: "b" }]),
				async (event, child) => {
					order.push(`handler-${event.id}-start`);
					await child.report(`${event.id} matters`);
					order.push(`handler-${event.id}-reported`);
					if (event.id === "b") turnGate.resolve();
				},
				{ subscriber: watcher, maxConcurrent: 1 },
			).done;
			return {};
		},
	}) as WorkflowDefinition;
	const result = await run(
		definition,
		{},
		{
			runId: "abababab-abab-4bab-8bab-000000004311",
			store: createStore(),
			durableBackend: await createMemoryTestBackend(),
			adapters: { agentSession: { create: async () => watcherSession } },
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(order, [
		"handler-a-start",
		"subscriber-queued",
		"subscriber-turn-start",
		"handler-a-reported",
		"handler-b-start",
		"handler-b-reported",
		"subscriber-turn-end",
	]);
	assert.deepEqual(watcherMessages, [
		"watch",
		'Report from event child "alerts#1/a" (event a):\n\na matters',
		'Report from event child "alerts#1/b" (event b):\n\nb matters',
	]);
});

test("a run settles the turns its reports started before it completes, and cancelling it meanwhile ends it (#4311)", async () => {
	const listeners = new Set<Listener>();
	const watcherMessages: string[] = [];
	const emit = (type: string): void => {
		for (const listener of [...listeners]) listener({ type });
	};
	const watcherSession: StageSessionRuntime = {
		...mockSession(),
		async prompt(text: string) {
			emit("agent_start");
			watcherMessages.push(text);
			emit("agent_end");
		},
		async sendUserMessage(content) {
			emit("agent_start");
			watcherMessages.push(typeof content === "string" ? content : "");
			await new Promise<void>(() => {});
		},
		subscribe(listener) {
			listeners.add(listener as Listener);
			return () => listeners.delete(listener as Listener);
		},
	};
	let bodyReturned = false;
	const definition = workflow({
		name: "stalled-subscriber",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const watcher = ctx.stage("watcher");
			await watcher.prompt("watch");
			await ctx.subscribe(
				listSource("alerts", [{ id: "a" }]),
				async (event, child) => {
					await child.report(`${event.id} matters`);
				},
				{ subscriber: watcher },
			).done;
			bodyReturned = true;
			return {};
		},
	}) as WorkflowDefinition;
	const runId = "acacacac-acac-4cac-8cac-0000000043aa";
	const store = createStore();
	const controller = new AbortController();
	const running = run(
		definition,
		{},
		{
			runId,
			store,
			durableBackend: await createMemoryTestBackend(),
			signal: controller.signal,
			adapters: { agentSession: { create: async () => watcherSession } },
		},
	);
	await turnsUntil(() => bodyReturned);
	for (let turn = 0; turn < 50; turn++) await nextTurn();
	assert.equal(watcherMessages.length, 2);
	assert.equal(store.runs().find((entry) => entry.id === runId)?.status, "running");
	controller.abort(new Error("operator cancelled"));
	const result = await running;
	assert.equal(result.status, "killed");
});

test("a subscriber turn that fails after taking a report leaves a warning; one that fails before fails the report (#4311)", async () => {
	const listeners = new Set<Listener>();
	const emit = (type: string): void => {
		for (const listener of [...listeners]) listener({ type });
	};
	const watcherSession: StageSessionRuntime = {
		...mockSession(),
		async prompt() {
			emit("agent_start");
			emit("agent_end");
		},
		async sendUserMessage(content) {
			const text = typeof content === "string" ? content : "";
			if (text.includes("(event refused)")) throw new Error("subscriber refused the report");
			emit("agent_start");
			await nextTurn();
			emit("agent_end");
			throw new Error(`subscriber model failed on ${/\(event ([^)]*)\)/.exec(text)?.[1]}`);
		},
		subscribe(listener) {
			listeners.add(listener as Listener);
			return () => listeners.delete(listener as Listener);
		},
	};
	const reported: string[] = [];
	const failures: unknown[] = [];
	const runId = "fefefefe-fefe-4efe-8efe-000000004311";
	const store = createStore();
	const result = await run(
		workflow({
			name: "failing-subscriber-turns",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const watcher = ctx.stage("watcher");
				await watcher.prompt("watch");
				await ctx
					.subscribe(
						listSource("alerts", [{ id: "a" }, { id: "b" }, { id: "refused" }]),
						async (event, child) => {
							await child.report(`${event.id} matters`);
							reported.push(event.id);
						},
						{ subscriber: watcher, maxConcurrent: 1 },
					)
					.done.catch((error: unknown) => failures.push(error));
				return {};
			},
		}) as WorkflowDefinition,
		{},
		{
			runId,
			store,
			durableBackend: await createMemoryTestBackend(),
			adapters: { agentSession: { create: async () => watcherSession } },
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(reported, ["a", "b"]);
	assert.equal(failures.length, 1);
	assert.equal(isSubscriptionHandlerError(failures[0]), true);
	assert.equal(((failures[0] as Error).cause as Error).message, "subscriber refused the report");
	const warnings = store
		.notices()
		.filter((notice) => notice.runId === runId && notice.id.startsWith("workflow-subscriber-turn:"))
		.map((notice) => ({ id: notice.id, level: notice.level, message: notice.message }))
		.sort((left, right) => left.id.localeCompare(right.id));
	assert.deepEqual(warnings, [
		{
			id: `workflow-subscriber-turn:${runId}:watcher:1`,
			level: "warning",
			message: 'Subscriber stage "watcher" failed in the turn a report started: subscriber model failed on a',
		},
		{
			id: `workflow-subscriber-turn:${runId}:watcher:2`,
			level: "warning",
			message: 'Subscriber stage "watcher" failed in the turn a report started: subscriber model failed on b',
		},
	]);
});

test("a report reaches a subscriber declared while the run was paused that nothing has used yet (#4311)", async () => {
	const store = createStore();
	const runId = "79797979-7979-4979-8979-000000004311";
	const watcherMessages: string[] = [];
	const definition = workflow({
		name: "unused-paused-subscriber",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			await pauseRun(runId, { store });
			const watcher = ctx.stage("watcher");
			await resumeRun(runId, { store });
			await ctx.subscribe(
				listSource("late", [{ id: "l1" }]),
				async (event, child) => {
					await child.report(`${event.id} matters`);
				},
				{ subscriber: watcher },
			).done;
			return {};
		},
	}) as WorkflowDefinition;
	const result = await run(
		definition,
		{},
		{
			runId,
			store,
			durableBackend: await createMemoryTestBackend(),
			adapters: {
				agentSession: {
					create: async (_options, meta) => {
						const session = subscriberSession();
						if (meta?.stageName !== "watcher") return session;
						return {
							...session,
							async sendUserMessage(content, options) {
								watcherMessages.push(typeof content === "string" ? content : "");
								await session.sendUserMessage?.(content, options);
							},
						};
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(watcherMessages, ['Report from event child "late#1/l1" (event l1):\n\nl1 matters']);
});

test("a replayed subscriber whose reopened session refuses a report fails that report, and the event stays unprocessed (#4311)", async () => {
	const runId = "adadadad-adad-4dad-8dad-000000004311";
	const { resumed, deliveries, failures } = await runReplayedSubscriber({
		runId,
		retainedIn: "host",
		reopenedRefuses: true,
	});
	assert.equal(resumed.status, "completed", resumed.error);
	assert.deepEqual(
		deliveries.map((delivery) => delivery.session),
		["reopened"],
	);
	assert.equal(failures.length, 1);
	assert.equal(isSubscriptionHandlerError(failures[0]), true);
	assert.equal(((failures[0] as Error).cause as Error).message, "missing credentials");
});

test("an inline event the body has not read yet is not processed by reading it or by closing the stream (#4311)", async () => {
	const backend = await createMemoryTestBackend();
	const runId = "a1a1a1a1-a1a1-4a1a-8a1a-000000004311";
	const processedWhileHeld: boolean[] = [];
	const definition = workflow({
		name: "buffered-inline",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const reading = ctx.events(listSource("buffered", [{ id: "b1" }, { id: "b2" }]));
			for (let turn = 0; turn < 20; turn++) await nextTurn();
			const first = await reading.next();
			for (let turn = 0; turn < 20; turn++) await nextTurn();
			processedWhileHeld.push(subscriptionEventProcessed(backend, runId, "buffered#1", "b1"));
			assert.equal(first.done, false);
			const unread = ctx.events(listSource("unread", [{ id: "u1" }]));
			for (let turn = 0; turn < 20; turn++) await nextTurn();
			await unread.close();
			await reading.close();
			return {};
		},
	}) as WorkflowDefinition;
	const result = await run(
		definition,
		{},
		{
			runId,
			store: createStore(),
			durableBackend: backend,
			adapters: { agentSession: { create: async () => subscriberSession() } },
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(processedWhileHeld, [false]);
	assert.equal(subscriptionEventProcessed(backend, runId, "buffered#1", "b1"), true);
	assert.equal(subscriptionEventProcessed(backend, runId, "buffered#1", "b2"), false);
	assert.equal(subscriptionEventProcessed(backend, runId, "unread#1", "u1"), false);
});

test("a continuation run parents event children under the subscriber, not the frontier (#4311)", async () => {
	const backend = await createMemoryTestBackend();
	let failAfter = true;
	const definition = workflow({
		name: "continued-subscriber",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const watcher = ctx.stage("watcher");
			await watcher.prompt("watch");
			await ctx.stage("between").prompt("unrelated");
			await ctx.subscribe(
				listSource("continued", [{ id: "c1" }]),
				async (_event, child) => {
					await child.task({ prompt: "look" });
				},
				{ subscriber: watcher },
			).done;
			await ctx.stage("after").prompt("after");
			return {};
		},
	}) as WorkflowDefinition;
	const adapters: RunOpts["adapters"] = {
		agentSession: {
			create: async (_options, meta) => {
				if (meta?.stageName === "after" && failAfter) {
					failAfter = false;
					throw new Error("after failed once");
				}
				return subscriberSession();
			},
		},
	};
	const sourceStore = createStore();
	const first = await run(definition, {}, { store: sourceStore, durableBackend: backend, adapters });
	assert.equal(first.status, "failed");
	const source = sourceStore.runs().find((candidate) => candidate.id === first.runId);
	assert.ok(source !== undefined);
	const continued = await run(
		definition,
		{},
		{
			store: createStore(),
			durableBackend: backend,
			continuation: { source, resumeFromStageId: source.failedStageId },
			adapters,
		},
	);
	assert.equal(continued.status, "completed", continued.error);
	const watcher = continued.stages.find((stage) => stage.name === "watcher")!;
	const child = continued.stages.find((stage) => stage.name === "continued#1/c1");
	assert.ok(child !== undefined);
	assert.deepEqual(child.parentIds, [watcher.id]);
});

test("overlapping reads of an inline stream get successive events (#4311)", async () => {
	const seen: string[] = [];
	const { result } = await runWorkflow(
		async (ctx) => {
			const stream = ctx.events(listSource("overlap", [{ id: "o1" }, { id: "o2" }]));
			const [first, second] = await Promise.all([stream.next(), stream.next()]);
			for (const read of [first, second]) if (read.done !== true) seen.push(read.value.id);
			await stream.close();
		},
		undefined,
		"a2a2a2a2-a2a2-4a2a-8a2a-000000004311",
	);
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(seen, ["o1", "o2"]);
});
