import assert from "node:assert/strict";
import {
	type AgentSession,
	type EventSource,
	isSubscriptionConfigError,
	isSubscriptionHandlerError,
	publishEvent,
	SUBSCRIPTION_REPORT_TOOL_NAME,
	type SubscriptionEvent,
	type SubscriptionStats,
	type ToolDefinition,
} from "@bastani/atomic";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedWorkflowSnapshot,
	listOpenableCompletedWorkflows,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";
import { mockSession } from "./executor-shared.js";

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
							: meta?.stageName.startsWith(`${SUBSCRIPTION}/`) === true
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
						`Report from event child "${SUBSCRIPTION}/evt-${index}" (event evt-${index}):\n\ncheck ${index} failed`,
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
		const children = outcome.stages.filter((stage) => stage.name.startsWith(`${SUBSCRIPTION}/`));
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
		['Report from event child "alerts/p2" (event p2):\n\np2 needs attention'],
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
	const child = result.stages.find((stage) => stage.name === "graph/g1")!;
	assert.deepEqual(child.parentIds, [watcher.id]);
});

test("a subscriber declared while the run is paused still parents its event children (#4311)", async () => {
	const store = createStore();
	const backend = await createMemoryTestBackend();
	const runId = "77777777-7777-4777-8777-000000004311";
	const definition = workflow({
		name: "paused-subscriber",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("anchor").prompt("start");
			await pauseRun(runId, { store });
			const watcher = ctx.stage("watcher");
			await resumeRun(runId, { store });
			await watcher.prompt("watch");
			await ctx.stage("between").prompt("unrelated");
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
	assert.deepEqual(result.stages.find((stage) => stage.name === "paused/p1")!.parentIds, [watcher.id]);
});

test("a failing run stops its open subscriptions and drops their queued events (#4311)", async () => {
	const handled: string[] = [];
	const { result } = await runWorkflow(async (ctx) => {
		await ctx.stage("anchor").prompt("start");
		const subscription = ctx.subscribe(
			openSource("stopping"),
			async (event) => {
				handled.push(event.id);
				await new Promise((resolve) => setTimeout(resolve, 50));
			},
			{ maxConcurrent: 1 },
		);
		void subscription.done.catch(() => undefined);
		for (const id of ["s1", "s2", "s3"]) publishEvent(subscription.id, { id });
		await new Promise((resolve) => setTimeout(resolve, 10));
		throw new Error("body failed");
	});
	assert.equal(result.status, "failed");
	await new Promise((resolve) => setTimeout(resolve, 150));
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
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal((doneReason as Error | undefined)?.message, "operator cancelled");
	void handlerSignal;
});
