import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import { test } from "vitest";
import {
	type AgentSessionEventListener,
	createStageControlRegistry,
	type StageControlHandle,
	type StageControlStatus,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { WorkerRequest } from "../../packages/workflows/src/workers/protocol.js";
import { WorkerStageWatches } from "../../packages/workflows/src/workers/stage-watch.js";
import { appendCoalesced } from "../../packages/workflows/src/workers/stage-watch-coalesce.js";
import type { DeliveryOpId, SeqEvent, WatchId } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { sleep } from "../helpers/runtime.js";

type Sent = Extract<WorkerRequest, { kind: "stage-command-result" | "stage-events" | "stage-watch-ended" }>;

/** A worker-side stage handle whose session events the test emits. */
function streamingStage(stageId: string) {
	const listeners = new Set<AgentSessionEventListener>();
	let status: StageControlStatus = "running";
	const handle: StageControlHandle = {
		runId: "child",
		stageId,
		stageName: stageId,
		get status() {
			return status;
		},
		sessionId: `session-${stageId}`,
		sessionFile: undefined,
		isStreaming: true,
		messages: [],
		ensureAttached: async () => {},
		prompt: async () => {},
		steer: async () => {},
		followUp: async () => {},
		pause: async () => {},
		resume: async () => undefined,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		handle,
		subscribers: () => listeners.size,
		emit(event: AgentSessionEvent) {
			for (const listener of listeners) listener(event);
		},
		finish() {
			status = "completed";
		},
	};
}

function delta(text: string, contentIndex = 0): AgentSessionEvent {
	return {
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", contentIndex, delta: text, partial: { role: "assistant", text } },
	} as never as AgentSessionEvent;
}

function airlock() {
	const registry = createStageControlRegistry();
	const sent: Sent[] = [];
	let attempt: { workId: string; generation: number } | undefined = { workId: "work", generation: 1 };
	const watches = new WorkerStageWatches(
		registry,
		() => attempt,
		(message) => sent.push({ ...message, id: 0 } as Sent),
	);
	return {
		registry,
		sent,
		watches,
		changeAttempt(next: typeof attempt) {
			attempt = next;
		},
		events: () => sent.flatMap((message) => (message.kind === "stage-events" ? message.events : [])),
	};
}

async function untilSent(sent: readonly Sent[], kind: Sent["kind"]): Promise<void> {
	while (!sent.some((message) => message.kind === kind)) await sleep(5);
}

test("a streaming stage nobody watches sends no session events from its worker (#3996)", async () => {
	const { registry, sent, watches } = airlock();
	const stage = streamingStage("agent");
	registry.register(stage.handle);
	for (let index = 0; index < 50; index++) stage.emit(delta(`token-${index} `));
	watches.sweep();
	assert.equal(stage.subscribers(), 0, "the worker does not subscribe to an unwatched stage");
	assert.deepEqual(sent, []);

	watches.serve({
		kind: "stage-command",
		commandId: 1,
		attempt: { workId: "work", generation: 1 },
		op: "watch",
		watch: "watch-1" as WatchId,
		runId: "child",
		stageId: "agent",
	});
	stage.emit(delta("seen"));
	await untilSent(sent, "stage-events");
	assert.equal(stage.subscribers(), 1);

	watches.serve({
		kind: "stage-command",
		commandId: 2,
		attempt: { workId: "work", generation: 1 },
		op: "unwatch",
		watch: "watch-1" as WatchId,
	});
	const sentBefore = sent.length;
	for (let index = 0; index < 50; index++) stage.emit(delta(`after-${index} `));
	assert.equal(stage.subscribers(), 0, "unwatching unsubscribes");
	assert.equal(sent.length, sentBefore);
});

test("the worker airlock refuses a watch for another attempt or a finished stage (#3996)", () => {
	const { registry, sent, watches, changeAttempt } = airlock();
	const stage = streamingStage("agent");
	registry.register(stage.handle);
	const watch = (commandId: number, generation: number) =>
		watches.serve({
			kind: "stage-command",
			commandId,
			attempt: { workId: "work", generation },
			op: "watch",
			watch: `watch-${commandId}` as WatchId,
			runId: "child",
			stageId: "agent",
		});
	watch(1, 2);
	changeAttempt(undefined);
	watch(2, 1);
	changeAttempt({ workId: "work", generation: 1 });
	stage.finish();
	watch(3, 1);
	assert.deepEqual(
		sent.map((message) => (message.kind === "stage-command-result" ? message.refusal : message.kind)),
		["AttemptChanging", "AttemptChanging", "StageNotOnWorker"],
	);
	assert.equal(stage.subscribers(), 0);
});

test("a watch opens with a snapshot and ends when its stage finishes (#3996)", async () => {
	const { registry, sent, watches, events } = airlock();
	const stage = streamingStage("agent");
	registry.register(stage.handle);
	watches.serve({
		kind: "stage-command",
		commandId: 1,
		attempt: { workId: "work", generation: 1 },
		op: "watch",
		watch: "watch-1" as WatchId,
		runId: "child",
		stageId: "agent",
	});
	const opened = sent[0];
	assert.equal(opened?.kind, "stage-command-result");
	assert.equal(opened.snapshot?.sessionId, "session-agent");
	assert.equal(opened.snapshot?.seq, 0);
	stage.emit(delta("one "));
	stage.emit({ type: "agent_end", messages: [] } as never as AgentSessionEvent);
	stage.finish();
	watches.sweep();
	assert.deepEqual(
		events().map(({ seq, event }) => [seq, event.type]),
		[
			[1, "message_update"],
			[2, "agent_end"],
		],
	);
	assert.deepEqual(sent.at(-1), { kind: "stage-watch-ended", watch: "watch-1", reason: "stage_finished", id: 0 });
	assert.equal(stage.subscribers(), 0);
});

test("coalescing merges deltas of one block without losing text, and keeps every other event (#3996)", () => {
	const batch: SeqEvent[] = [];
	const events: AgentSessionEvent[] = [
		{ type: "message_start", message: { role: "assistant" } } as never as AgentSessionEvent,
		delta("Hel"),
		delta("lo"),
		delta(", wor"),
		{
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_end", contentIndex: 0 },
		} as never as AgentSessionEvent,
		delta("ld", 1),
		delta("!", 1),
	];
	for (const [index, event] of events.entries()) appendCoalesced(batch, { seq: index + 1, event });
	const deltas = batch.flatMap(({ event }) =>
		event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"
			? [event.assistantMessageEvent.delta]
			: [],
	);
	assert.equal(deltas.join(""), "Hello, world!");
	assert.deepEqual(
		batch.map(({ seq }) => seq),
		[1, 4, 5, 7],
		"merged deltas take the newest seq; the block end separates blocks",
	);
});

/** A worker-side stage whose idle-aware delivery records what it admitted. */
function deliverableStage(streaming: boolean) {
	const stage = streamingStage("agent");
	const admitted: { readonly text: string; readonly deliverAs: string | undefined }[] = [];
	const handle: StageControlHandle = {
		...stage.handle,
		get status() {
			return stage.handle.status;
		},
		isStreaming: streaming,
		async sendUserMessage(text, options) {
			admitted.push({ text, deliverAs: options?.deliverAs });
			return streaming ? (options?.deliverAs ?? "followUp") : "prompt";
		},
		// A turn under way takes text straight into its queues.
		async steer(text) {
			admitted.push({ text, deliverAs: "steer" });
		},
		async followUp(text) {
			admitted.push({ text, deliverAs: "followUp" });
		},
	};
	return { ...stage, handle, admitted };
}

function openWatch(watches: WorkerStageWatches): void {
	watches.serve({
		kind: "stage-command",
		commandId: 1,
		attempt: { workId: "work", generation: 1 },
		op: "watch",
		watch: "watch-1" as WatchId,
		runId: "child",
		stageId: "agent",
	});
}

async function deliver(
	sent: Sent[],
	watches: WorkerStageWatches,
	commandId: number,
	deliveryOp: string,
	intent: "steer" | "followUp" | "auto",
	generation = 1,
) {
	watches.serve({
		kind: "stage-command",
		commandId,
		attempt: { workId: "work", generation },
		op: "deliver",
		watch: "watch-1" as WatchId,
		deliveryOp: deliveryOp as DeliveryOpId,
		text: `text-${deliveryOp}`,
		intent,
	});
	for (;;) {
		const result = sent.find((message) => message.kind === "stage-command-result" && message.commandId === commandId);
		if (result?.kind === "stage-command-result") return { action: result.action, refusal: result.refusal };
		await sleep(1);
	}
}

test("a delivery admits the stage's own idle-aware action for each intent, as an in-process stage reports (#3996)", async () => {
	for (const streaming of [true, false]) {
		const { registry, sent, watches } = airlock();
		const stage = deliverableStage(streaming);
		registry.register(stage.handle);
		openWatch(watches);
		const steer = await deliver(sent, watches, 2, "steer", "steer");
		const followUp = await deliver(sent, watches, 3, "follow", "followUp");
		const auto = await deliver(sent, watches, 4, "auto", "auto");
		assert.deepEqual(
			[steer.action, followUp.action, auto.action],
			streaming ? ["steer", "followUp", "followUp"] : ["prompt", "prompt", "prompt"],
		);
		// A turn under way queues each text in its mode (auto follows up); an idle stage gets the
		// stage's own idle-aware delivery.
		assert.deepEqual(
			stage.admitted.map(({ deliverAs }) => deliverAs),
			streaming ? ["steer", "followUp", "followUp"] : ["steer", "followUp", undefined],
		);
	}
});

test("a steer to a turn under way lands in the turn, not behind it, even when the stage's admission is held (#3996)", async () => {
	const { registry, sent, watches } = airlock();
	const stage = streamingStage("agent");
	const calls: string[] = [];
	registry.register({
		...stage.handle,
		get status() {
			return stage.handle.status;
		},
		// A replayed turn: the session streams, the stage handle has not caught up, and its message
		// admission is held until the turn ends.
		isStreaming: false,
		agentSession: { isStreaming: true } as never,
		sendUserMessage: () => {
			calls.push("sendUserMessage");
			return new Promise(() => {});
		},
		async steer() {
			calls.push("steer");
		},
		async followUp() {
			calls.push("followUp");
		},
	});
	openWatch(watches);
	assert.deepEqual(await deliver(sent, watches, 2, "op-steer", "steer"), { action: "steer", refusal: undefined });
	assert.deepEqual(await deliver(sent, watches, 3, "op-follow", "followUp"), {
		action: "followUp",
		refusal: undefined,
	});
	assert.deepEqual(calls, ["steer", "followUp"]);
});

test("a retried delivery op is admitted at most once (#3996)", async () => {
	const { registry, sent, watches } = airlock();
	const stage = deliverableStage(true);
	registry.register(stage.handle);
	openWatch(watches);
	const first = await deliver(sent, watches, 2, "op-1", "steer");
	// The reply was lost on the way to the root; the root retries with the same op.
	const retried = await deliver(sent, watches, 3, "op-1", "steer");
	assert.deepEqual(first, { action: "steer", refusal: undefined });
	assert.deepEqual(retried, first);
	assert.deepEqual(stage.admitted, [{ text: "text-op-1", deliverAs: "steer" }]);
});

test("a delivery for another attempt or a finished stage is refused and not admitted (#3996)", async () => {
	const { registry, sent, watches } = airlock();
	const stage = deliverableStage(true);
	registry.register(stage.handle);
	openWatch(watches);
	assert.equal((await deliver(sent, watches, 2, "stale", "steer", 2)).refusal, "StaleAttempt");
	stage.finish();
	assert.equal((await deliver(sent, watches, 3, "late", "steer")).refusal, "StageNotLive");
	assert.deepEqual(stage.admitted, []);
});

test("per-stage pause and resume go through the airlock, and wait while the pool itself is paused (#3996)", async () => {
	const registry = createStageControlRegistry();
	const sent: Sent[] = [];
	let control = "running";
	const watches = new WorkerStageWatches(
		registry,
		() => ({ workId: "work", generation: 1 }),
		(message) => sent.push({ ...message, id: 0 } as Sent),
		() => control,
	);
	const stage = deliverableStage(true);
	const calls: string[] = [];
	registry.register({
		...stage.handle,
		get status() {
			return stage.handle.status;
		},
		async pause() {
			calls.push("pause");
		},
		async resume(message?: string) {
			calls.push(`resume:${message ?? ""}`);
			return message === undefined ? undefined : "prompt";
		},
	});
	openWatch(watches);
	const command = async (
		commandId: number,
		op: "pause" | "resume",
		message?: { deliveryOp: string; text: string },
	) => {
		watches.serve({
			kind: "stage-command",
			commandId,
			attempt: { workId: "work", generation: 1 },
			op,
			watch: "watch-1" as WatchId,
			...(message === undefined
				? {}
				: { message: { deliveryOp: message.deliveryOp as DeliveryOpId, text: message.text } }),
		} as Parameters<WorkerStageWatches["serve"]>[0]);
		for (;;) {
			const result = sent.find((entry) => entry.kind === "stage-command-result" && entry.commandId === commandId);
			if (result?.kind === "stage-command-result") return { action: result.action, refusal: result.refusal };
			await sleep(1);
		}
	};
	assert.deepEqual(await command(2, "pause"), { action: undefined, refusal: undefined });
	assert.deepEqual(await command(3, "resume", { deliveryOp: "op-r", text: "carry on" }), {
		action: "prompt",
		refusal: undefined,
	});
	// The resume message's op is in the delivery ledger: a retry releases the stage without sending it again.
	assert.deepEqual(await command(4, "resume", { deliveryOp: "op-r", text: "carry on" }), {
		action: "prompt",
		refusal: undefined,
	});
	control = "paused";
	assert.equal((await command(5, "pause")).refusal, "PoolPausedOrQuitting");
	assert.deepEqual(calls, ["pause", "resume:carry on"]);
});

/**
 * A worker-side stage whose session queues steers and follow-ups and publishes each queue
 * change, as a real session does, and whose test consumes queued items on demand.
 */
function queuingStage(streaming: boolean) {
	const stage = streamingStage("agent");
	const queues = { steering: [] as string[], followUp: [] as string[] };
	const entries: { type: string; customType?: string; data?: { op: string } }[] = [];
	const publish = () =>
		stage.emit({ type: "queue_update", steering: [...queues.steering], followUp: [...queues.followUp] } as never);
	const userMessage = (type: "message_start" | "message_end", text: string) =>
		stage.emit({ type, message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } } as never);
	const handle: StageControlHandle = {
		...stage.handle,
		get status() {
			return stage.handle.status;
		},
		isStreaming: streaming,
		queuedUserMessages: () => ({ steering: [...queues.steering], followUp: [...queues.followUp] }),
		async sendUserMessage(text, options) {
			if (!streaming) {
				// An idle prompt starts the turn with its user message: here a template expansion that drops the sent text.
				userMessage("message_start", "Please review the staged change");
				return "prompt";
			}
			const queue = options?.deliverAs === "steer" ? "steering" : "followUp";
			queues[queue].push(text);
			publish();
			return options?.deliverAs ?? "followUp";
		},
		async steer(text) {
			queues.steering.push(text);
			publish();
		},
		async followUp(text) {
			queues.followUp.push(text);
			publish();
		},
		agentSession: {
			sessionManager: {
				getEntries: () => entries,
				async appendCustomEntry(customType: string, data: { op: string }) {
					entries.push({ type: "custom", customType, data });
					return "entry";
				},
			},
		} as never,
	};
	return {
		stage,
		handle,
		receipts: () => entries.map((entry) => entry.data?.op),
		/** The session takes the next item of one queue into its transcript. */
		consume(queue: "steering" | "followUp") {
			const text = queues[queue].shift()!;
			publish();
			userMessage("message_start", text);
			userMessage("message_end", text);
		},
		endPrompt() {
			userMessage("message_end", "Please review the staged change");
		},
	};
}

test("a delivery is receipted by where it went, not by its text: only the consumed one of two similar texts (#3996)", async () => {
	const { registry, sent, watches } = airlock();
	const stage = queuingStage(true);
	registry.register(stage.handle);
	openWatch(watches);
	await deliver(sent, watches, 2, "fix", "followUp");
	await deliver(sent, watches, 3, "fix-the-bug", "steer");
	assert.deepEqual(stage.receipts(), [], "nothing is receipted while it is only queued");
	// The steer's text `text-fix-the-bug` contains the follow-up's `text-fix`; only the steer is consumed.
	stage.consume("steering");
	assert.deepEqual(stage.receipts(), ["fix-the-bug"], "the follow-up still waits and must be redelivered");
	stage.consume("followUp");
	assert.deepEqual(stage.receipts(), ["fix-the-bug", "fix"]);
	watches.serve({
		kind: "stage-command",
		commandId: 9,
		attempt: { workId: "work", generation: 1 },
		op: "watch",
		watch: "watch-2" as WatchId,
		runId: "child",
		stageId: "agent",
	});
	const reopened = sent.find((message) => message.kind === "stage-command-result" && message.commandId === 9);
	assert.ok(reopened?.kind === "stage-command-result");
	assert.deepEqual(reopened.snapshot?.deliveredOps, ["fix-the-bug", "fix"]);
});

test("an idle prompt is receipted once, even when template expansion changes its text (#3996)", async () => {
	const { registry, sent, watches } = airlock();
	const stage = queuingStage(false);
	registry.register(stage.handle);
	openWatch(watches);
	assert.equal((await deliver(sent, watches, 2, "op-prompt", "auto")).action, "prompt");
	assert.deepEqual(stage.receipts(), [], "receipted only when its user message ends");
	stage.endPrompt();
	assert.deepEqual(stage.receipts(), ["op-prompt"]);
});

test("a replacement whose replayed session already holds an op reports it and admits it at most once (#3996)", async () => {
	const registry = createStageControlRegistry();
	const sent: Sent[] = [];
	const watches = new WorkerStageWatches(
		registry,
		() => ({ workId: "work", generation: 2 }),
		(message) => sent.push({ ...message, id: 0 } as Sent),
		() => "running",
		{
			// The committed session of the replaced attempt, before this attempt attached its own.
			entries: async () => [
				{ type: "custom", customType: "atomic-pooled-delivery-op", data: { op: "op-before-kill" } } as never,
			],
		},
	);
	const stage = deliverableStage(true);
	registry.register({
		...stage.handle,
		get status() {
			return stage.handle.status;
		},
		sessionId: "replayed-session",
	});
	watches.serve({
		kind: "stage-command",
		commandId: 1,
		attempt: { workId: "work", generation: 2 },
		op: "watch",
		watch: "watch-1" as WatchId,
		runId: "child",
		stageId: "agent",
	});
	await untilSent(sent, "stage-command-result");
	const opened = sent[0];
	assert.ok(opened?.kind === "stage-command-result");
	assert.deepEqual(opened.snapshot?.deliveredOps, ["op-before-kill"]);
	const again = await deliver(sent, watches, 2, "op-before-kill", "steer", 2);
	assert.deepEqual(again, { action: "handled", refusal: undefined }, "the op is not admitted a second time");
	assert.deepEqual(stage.admitted, []);
});

test.each([
	["steer", "steer", "steer"],
	["followUp", "followUp", "followUp"],
	["auto", "followUp", "followUp"],
] as const)(
	"a %s delivery to a replacement that is busy but not reported streaming is queued in its mode, never prompted (#3996)",
	async (intent, expectedCall, expectedAction) => {
		const { registry, sent, watches } = airlock();
		const stage = streamingStage("agent");
		const calls: string[] = [];
		registry.register({
			...stage.handle,
			get status() {
				return stage.handle.status;
			},
			// The replayed turn runs, but the stage handle does not report it yet.
			isStreaming: false,
			async sendUserMessage() {
				calls.push("sendUserMessage");
				throw new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages.");
			},
			async prompt() {
				calls.push("prompt");
				throw new Error("Agent is already processing a prompt.");
			},
			async steer() {
				calls.push("steer");
			},
			async followUp() {
				calls.push("followUp");
			},
		});
		openWatch(watches);
		assert.deepEqual(await deliver(sent, watches, 2, `op-${intent}`, intent), {
			action: expectedAction,
			refusal: undefined,
		});
		assert.deepEqual(calls, ["sendUserMessage", expectedCall]);
	},
);
