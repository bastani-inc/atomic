import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { ClearedQueue, PromptDisposition } from "../src/core/agent-session-types.js";
import type { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import { mainSteering, reconcileQueuedSubmissions } from "../src/modes/interactive/interactive-queueing.js";
import {
	type SteeringLane,
	type SteeringPromptOptions,
	SteeringQueueController,
	type SteeringQueuedMessage,
	type SteeringQueueLists,
} from "../src/modes/interactive/steering-queue-controller.js";
import { asAcceptedRequestFailure, rpcTransportError } from "../src/modes/rpc/rpc-transport-error.js";

/** A prompt the agent has not answered yet. The test answers it as the agent would. */
interface PendingPrompt {
	text: string;
	options: SteeringPromptOptions | undefined;
	accept(disposition?: PromptDisposition): void;
	/** Answer a prompt the agent already queued and listed. */
	answer(disposition: PromptDisposition): void;
	refuse(error: Error): void;
	failAfterAccepting(error: Error): void;
	loseAnswer(error: Error): void;
}

/** An agent session as a chat sees it: a queue per lane, prompts it answers when told to, `queue_update` listings. */
class FakeAgent {
	busy = true;
	paused = false;
	steering: string[] = [];
	followUp: string[] = [];
	/** What each removed message looked like when it was typed, by queued text. */
	typedAs = new Map<string, string>();
	prompts: PendingPrompt[] = [];
	resumed: Array<{ text: string; lane: string }> = [];
	clearFails: Error | undefined;
	private listeners = new Set<(queue: SteeringQueueLists) => void>();

	prompt(text: string, options?: SteeringPromptOptions): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.prompts.push({
			text,
			options,
			accept: (disposition = options?.streamingBehavior ? "queued" : "started") => {
				if (disposition === "queued" && options?.streamingBehavior) this.lane(options.streamingBehavior).push(text);
				options?.preflightResult?.(true, disposition);
				resolve();
			},
			answer: (disposition) => {
				options?.preflightResult?.(true, disposition);
				resolve();
			},
			refuse: (error) => {
				options?.preflightResult?.(false);
				reject(error);
			},
			failAfterAccepting: (error) => {
				options?.preflightResult?.(true, "queued");
				reject(error);
			},
			loseAnswer: (error) => reject(asAcceptedRequestFailure(error)),
		});
		return promise;
	}

	clearQueue(): ClearedQueue {
		if (this.clearFails) throw this.clearFails;
		const removed = { steering: this.steering, followUp: this.followUp };
		this.steering = [];
		this.followUp = [];
		const typed = (texts: string[]) => texts.map((text) => this.typedAs.get(text) ?? text);
		return { ...removed, typed: { steering: typed(removed.steering), followUp: typed(removed.followUp) } };
	}

	/** Take the next steering message into the turn, as a turn boundary does. */
	deliverSteer(): string | undefined {
		return this.steering.shift();
	}

	subscribe(listener: (queue: SteeringQueueLists) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Report the queue, as a `queue_update` does. */
	list(): SteeringQueueLists {
		const queue = { steering: [...this.steering], followUp: [...this.followUp] };
		for (const listener of this.listeners) listener(queue);
		return queue;
	}

	private lane(lane: SteeringLane): string[] {
		return lane === "steer" ? this.steering : this.followUp;
	}
}

/** One chat on the shared controller: its agent, the messages its editor holds, and how it hears a listing. */
interface Chat {
	agent: FakeAgent;
	controller: SteeringQueueController;
	hold(message: SteeringQueuedMessage): void;
	held(): readonly SteeringQueuedMessage[];
	listQueue(): void;
	redraws(): number;
}

const chats: Array<{ name: string; open: () => Chat }> = [
	{
		name: "the main chat",
		open: () => {
			const agent = new FakeAgent();
			let redraws = 0;
			const mode = {
				session: {
					get isStreaming() {
						return agent.busy;
					},
					get queuedMessagesPaused() {
						return agent.paused;
					},
					getSteeringMessages: () => [...agent.steering],
					getFollowUpMessages: () => [...agent.followUp],
					prompt: (text: string, options?: SteeringPromptOptions) => agent.prompt(text, options),
					clearQueue: () => agent.clearQueue(),
				},
				promptTurn: undefined,
				runtimeHost: {},
				compactionQueuedMessages: [] as SteeringQueuedMessage[],
				compactionSendFailed: false,
				compactionActive: false,
				ui: { requestRender() {} },
				updatePendingMessagesDisplay() {
					redraws++;
				},
			};
			const chat = mode as unknown as InteractiveModeBase;
			return {
				agent,
				controller: mainSteering(chat),
				hold: (message) => mode.compactionQueuedMessages.push(message),
				held: () => mode.compactionQueuedMessages,
				// InteractiveMode's event handler hands each `queue_update` over.
				listQueue: () => reconcileQueuedSubmissions(chat, agent.list()),
				redraws: () => redraws,
			};
		},
	},
	{
		name: "a chat whose agent reports its own queue",
		open: () => {
			const agent = new FakeAgent();
			let held: SteeringQueuedMessage[] = [];
			let redraws = 0;
			const controller = new SteeringQueueController(
				{
					get busy() {
						return agent.busy;
					},
					get paused() {
						return agent.paused;
					},
					queued: () => ({ steering: [...agent.steering], followUp: [...agent.followUp] }),
					prompt: (text, options) => agent.prompt(text, options),
					clearQueue: () => agent.clearQueue(),
					resume: async (text, lane) => {
						agent.resumed.push({ text, lane });
					},
					subscribeQueue: (listener) => agent.subscribe(listener),
				},
				{
					held: () => held,
					takeHeld: () => {
						const messages = held;
						held = [];
						return { messages, putBack: () => (held = [...messages, ...held]) };
					},
					changed: () => redraws++,
					requestRender: () => {},
				},
			);
			return {
				agent,
				controller,
				hold: (message) => held.push(message),
				held: () => held,
				listQueue: () => agent.list(),
				redraws: () => redraws,
			};
		},
	},
];

describe.each(chats)("$name on the shared steering controller", ({ open }) => {
	test("a message sent while the agent works is listed as queued at once and once after the agent confirms it", async () => {
		const chat = open();
		const sent = chat.controller.submit("steer alpha", "steer", { route: "queue" });
		assert.deepEqual(chat.controller.allQueued(), { steering: ["steer alpha"], followUp: [] });

		chat.agent.prompts[0]?.accept();
		chat.listQueue();
		assert.deepEqual(await sent, { kind: "queued" });
		assert.deepEqual(chat.controller.allQueued(), { steering: ["steer alpha"], followUp: [] });
	});

	test("a listing that arrives before the agent's answer confirms the shown copy, so it is never listed twice", async () => {
		const chat = open();
		const sent = chat.controller.submit("same", "followUp", { route: "queue" });
		chat.agent.followUp.push("same");
		chat.listQueue();
		assert.deepEqual(chat.controller.allQueued(), { steering: [], followUp: ["same"] });
		chat.agent.prompts[0]?.answer("queued");
		assert.deepEqual(await sent, { kind: "queued" });
		assert.deepEqual(chat.controller.allQueued(), { steering: [], followUp: ["same"] });
	});

	test("only a message a listing adds confirms a copy: an identical one listed before does not", () => {
		const chat = open();
		chat.agent.steering.push("again");
		chat.listQueue();
		void chat.controller.submit("again", "steer", { route: "queue" });
		chat.listQueue();
		assert.deepEqual(chat.controller.allQueued(), { steering: ["again", "again"], followUp: [] });
	});

	test("rows list the agent's queue, then unconfirmed messages, then the editor's held ones, steering first", () => {
		const chat = open();
		chat.agent.steering.push("queued steer");
		chat.agent.followUp.push("queued follow");
		chat.listQueue();
		chat.hold({ text: "held steer", mode: "steer" });
		chat.hold({ text: "held follow", mode: "followUp" });
		void chat.controller.submit("sent steer", "steer", { route: "queue" });
		void chat.controller.submit("sent follow", "followUp", { route: "queue" });
		assert.deepEqual(chat.controller.allQueued(), {
			steering: ["queued steer", "sent steer", "held steer"],
			followUp: ["queued follow", "sent follow", "held follow"],
		});
	});

	test("a refused message stops being listed and comes back to the caller with the reason", async () => {
		const chat = open();
		const sent = chat.controller.submit("refused", "steer", { route: "queue" });
		const error = new Error("the agent refused it");
		chat.agent.prompts[0]?.refuse(error);
		assert.deepEqual(await sent, { kind: "refused", error });
		assert.deepEqual(chat.controller.allQueued(), { steering: [], followUp: [] });
	});

	test("a message whose answer was lost on the way is reported, not given back", async () => {
		const chat = open();
		const sent = chat.controller.submit("lost", "followUp", { route: "queue" });
		chat.agent.prompts[0]?.loseAnswer(rpcTransportError("the engine went away"));
		const outcome = await sent;
		assert.equal(outcome.kind, "lost");
		assert.deepEqual(chat.controller.allQueued(), { steering: [], followUp: [] });
	});

	test("a message the agent accepted is never given back, even when its turn fails afterwards", async () => {
		const chat = open();
		const sent = chat.controller.submit("accepted", "steer", { route: "queue" });
		const error = new Error("the turn failed");
		chat.agent.prompts[0]?.failAfterAccepting(error);
		assert.deepEqual(await sent, { kind: "failed", error });
	});

	test("input that runs at once is not shown as queued", async () => {
		const chat = open();
		const sent = chat.controller.submit("/command", "steer", { route: "queue", showAsQueued: false });
		assert.deepEqual(chat.controller.allQueued(), { steering: [], followUp: [] });
		chat.agent.prompts[0]?.accept("handled");
		assert.deepEqual(await sent, { kind: "handled" });
	});

	test("restore takes every queued message back from the agent's own answer, steering first, ahead of the draft", async () => {
		const chat = open();
		chat.agent.steering.push("s1", "/skill:expanded");
		chat.agent.typedAs.set("/skill:expanded", "/skill:typed");
		chat.agent.followUp.push("f1");
		// The listed copy trails the agent: it still shows a message the agent already took into its turn.
		chat.listQueue();
		chat.agent.deliverSteer();
		chat.hold({ text: "held", mode: "steer" });
		let read = 0;
		const restored = await chat.controller.restoreAll(() => {
			read++;
			return "draft";
		});
		assert.deepEqual(restored, {
			messages: ["/skill:typed", "held", "f1"],
			text: "/skill:typed\n\nheld\n\nf1\n\ndraft",
		});
		assert.equal(read, 1);
		assert.deepEqual(chat.held(), []);
		assert.deepEqual(chat.agent.steering, []);
	});

	test("restore with nothing queued gives nothing back and leaves the draft alone", async () => {
		const chat = open();
		let read = 0;
		const restored = await chat.controller.restoreAll(() => {
			read++;
			return "draft";
		});
		assert.equal(restored, undefined);
		assert.equal(read, 0);
	});

	test("a restore the agent cannot answer keeps every message queued and reports why", async () => {
		const chat = open();
		chat.agent.steering.push("queued");
		chat.hold({ text: "held", mode: "followUp" });
		chat.agent.clearFails = new Error("the agent cannot be reached");
		await assert.rejects(
			chat.controller.restoreAll(() => ""),
			/cannot be reached/,
		);
		assert.deepEqual(chat.controller.allQueued(), { steering: ["queued"], followUp: ["held"] });
	});

	test("a submission is queued while the agent works and starts a turn while it is idle", async () => {
		const chat = open();
		chat.agent.busy = true;
		assert.equal(chat.controller.route(), "queue");
		void chat.controller.submit("while busy", "auto");
		assert.equal(chat.agent.prompts[0]?.options?.streamingBehavior, "steer");

		chat.agent.busy = false;
		assert.equal(chat.controller.route(), "start");
		const started = chat.controller.submit("while idle", "followUp");
		assert.equal(chat.agent.prompts[1]?.options?.streamingBehavior, undefined);
		assert.deepEqual(chat.controller.allQueued(), { steering: ["while busy"], followUp: [] });
		chat.agent.prompts[1]?.accept();
		assert.deepEqual(await started, { kind: "started" });
	});

	test("showing a message as queued redraws the rows", () => {
		const chat = open();
		const before = chat.redraws();
		void chat.controller.submit("redrawn", "steer", { route: "queue" });
		assert.ok(chat.redraws() > before);
	});
});

test("a paused agent that can resume continues with the message instead of queueing it", async () => {
	const agent = new FakeAgent();
	agent.paused = true;
	const controller = new SteeringQueueController(
		{
			busy: true,
			paused: true,
			queued: () => ({ steering: [], followUp: [] }),
			prompt: (text, options) => agent.prompt(text, options),
			clearQueue: () => agent.clearQueue(),
			resume: async (text, lane) => {
				agent.resumed.push({ text, lane });
			},
		},
		{
			held: () => [],
			takeHeld: () => ({ messages: [], putBack() {} }),
			changed() {},
			requestRender() {},
		},
	);
	assert.equal(controller.route(), "resume");
	assert.deepEqual(await controller.submit("continue", "auto"), { kind: "started" });
	assert.deepEqual(agent.resumed, [{ text: "continue", lane: "auto" }]);
	assert.deepEqual(agent.prompts, []);
});
