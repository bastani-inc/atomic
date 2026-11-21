import assert from "node:assert/strict";
import type { AgentTool } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, it } from "vitest";
import { queuedMessagesUnderWay } from "../../src/core/queued-message-delivery.ts";
import { createHarness, getMessageText, getUserTexts, type Harness, type HarnessOptions } from "./harness.ts";

/**
 * What the chat lists as queued is what the session will deliver: a message is taken back by clearing the queue or
 * delivered, once, never both and never lost; and only the queued message itself leaves the queue.
 */

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

async function harness(tools: AgentTool[] = [], options: HarnessOptions = {}): Promise<Harness> {
	const created = await createHarness({ ...options, tools });
	harnesses.push(created);
	return created;
}

/** A tool that runs until released, so a message can be queued while the turn works. */
function waitingTool(): { tool: AgentTool; started: Promise<void>; release: () => void } {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		tool: {
			name: "wait",
			label: "Wait",
			description: "Waits until released",
			parameters: Type.Object({}),
			execute: async () => {
				started.resolve();
				await released.promise;
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		},
		started: started.promise,
		release: () => released.resolve(),
	};
}

/** Hold the session's preparation of the next turn, which runs after the turn took its queued messages. */
function holdNextTurnPreparation(h: Harness, fail = false) {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const agent = h.session.agent;
	const prepare = agent.prepareNextTurnWithContext;
	let held = false;
	agent.prepareNextTurnWithContext = async (context, signal) => {
		if (!held) {
			held = true;
			entered.resolve();
			await released.promise;
			if (fail) throw new Error("turn preparation failed");
		}
		return prepare?.(context, signal);
	};
	return { entered: entered.promise, release: () => released.resolve() };
}

describe("queued messages", () => {
	for (const lane of ["steer", "followUp"] as const) {
		it(`a ${lane} message a queue listener takes back as it is queued is never sent`, async () => {
			const h = await harness();
			h.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
			let cleared: { steering: readonly string[]; followUp: readonly string[] } | undefined;
			const unsubscribe = h.session.subscribe((event) => {
				if (event.type !== "queue_update" || cleared !== undefined) return;
				if ([...event.steering, ...event.followUp].includes("edit me")) cleared = h.session.clearQueue();
			});

			await h.session[lane]("edit me");
			await h.session.prompt("first");
			unsubscribe();

			assert.deepEqual(
				lane === "steer" ? cleared?.steering : cleared?.followUp,
				["edit me"],
				"the listener took it back",
			);
			assert.deepEqual(getUserTexts(h), ["first"], "what was taken back is not sent");
		});
	}

	for (const lane of ["steer", "followUp"] as const) {
		it(`a ${lane} message whose queue listener fails is refused, and then neither listed nor sent`, async () => {
			const h = await harness();
			h.setResponses([fauxAssistantMessage("reply"), fauxAssistantMessage("another reply")]);
			let failed = false;
			const unsubscribe = h.session.subscribe((event) => {
				if (event.type !== "queue_update" || failed) return;
				if ([...event.steering, ...event.followUp].includes("draft")) {
					failed = true;
					throw new Error("observer stopped");
				}
			});

			await assert.rejects(h.session[lane]("draft"), /observer stopped/);
			unsubscribe();
			assert.deepEqual([...h.session.getSteeringMessages(), ...h.session.getFollowUpMessages()], []);
			await h.session.prompt("another");

			assert.deepEqual(getUserTexts(h), ["another"], "what was refused is never sent");
		});
	}

	it("a message a failing queue listener hands to a run first is queued: it is sent once and leaves no row behind", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("reply")]);
		let run: Promise<boolean> | undefined;
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type !== "queue_update" || run !== undefined || !event.followUp.includes("one")) return;
			run = h.session.agent.promptQueuedMessages();
			throw new Error("observer stopped");
		});

		await h.session.followUp("one");
		unsubscribe();
		await run;
		await h.session.agent.waitForIdle();

		assert.deepEqual(getUserTexts(h), ["one"]);
		assert.deepEqual(queuedMessagesUnderWay(h.session).followUp, [], "no row is left as being delivered");
		assert.deepEqual(h.session.getFollowUpMessages(), []);
	});

	it("a message a turn already took is shown as being delivered, is not taken back by clearing the queue, and is sent once", async () => {
		const waiting = waitingTool();
		const h = await harness([waiting.tool]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("answered"),
		]);
		const held = holdNextTurnPreparation(h);
		const run = h.session.prompt("first");
		await waiting.started;
		await h.session.steer("taken");
		waiting.release();
		await held.entered;

		// The turn took it; its message_start waits for the preparation.
		assert.deepEqual(h.session.getSteeringMessages(), [], "it is no longer queued");
		assert.deepEqual(queuedMessagesUnderWay(h.session).steering, ["taken"], "it is drawn as being delivered");
		const cleared = h.session.clearQueue();
		held.release();
		await run;

		assert.deepEqual(cleared.steering, [], "clearing the queue cannot take back what the turn already took");
		assert.deepEqual(getUserTexts(h), ["first", "taken"], "sent once");
	});

	it("a message a turn took is queued again, first, when the run ends before it starts, and the queue goes on", async () => {
		const waiting = waitingTool();
		const h = await harness([waiting.tool]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("answered the steer"),
			fauxAssistantMessage("answered the follow-up"),
		]);
		const held = holdNextTurnPreparation(h, true);
		const run = h.session.prompt("first");
		await waiting.started;
		await h.session.steer("taken");
		await h.session.followUp("later");
		waiting.release();
		await held.entered;
		const queueUpdates: string[][] = [];
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type === "queue_update") queueUpdates.push([...event.steering]);
		});
		held.release();
		await run.catch(() => {});
		await h.session.agent.waitForIdle();
		unsubscribe();

		// Never lost: listed again, first, and sent once as the queue goes on after the failed run, as it does for the
		// messages the run had not taken.
		assert.ok(
			queueUpdates.some((steering) => steering.includes("taken")),
			"listed again",
		);
		assert.deepEqual(getUserTexts(h), ["first", "taken", "later"]);
		assert.deepEqual(h.session.getSteeringMessages(), []);
		assert.deepEqual(h.session.getFollowUpMessages(), []);
		assert.deepEqual(queuedMessagesUnderWay(h.session).steering, []);
	});

	it("a queued message whose run fails before it starts a second time is dropped, not tried again", async () => {
		const waiting = waitingTool();
		const h = await harness([waiting.tool]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("never asked"),
		]);
		const held = holdNextTurnPreparation(h, true);
		// From the failed preparation on, every run fails as it starts, before its messages do.
		let refusing = false;
		let refusals = 0;
		h.session.agent.subscribe((event) => {
			if (event.type === "agent_start" && refusing) {
				refusals++;
				throw new Error("refused at start");
			}
		});
		const run = h.session.prompt("first");
		await waiting.started;
		await h.session.followUp("again");
		waiting.release();
		await held.entered;
		refusing = true;
		held.release();
		await run.catch(() => {});
		await h.session.agent.waitForIdle();

		// The run after the failed one takes it and fails before starting it: queued again. The next takes it and fails
		// the same way: dropped. No run takes it a third time.
		assert.equal(refusals, 2, "taken twice, then dropped: no run repeats it");
		assert.deepEqual(h.session.getFollowUpMessages(), [], "not left listed");
		assert.deepEqual(getUserTexts(h), ["first"]);
	});

	it("a prompt with the text of a queued message leaves that message queued: both are sent, each once", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("to the prompt"), fauxAssistantMessage("to the follow-up")]);
		await h.session.followUp("same");
		let atPromptStart: readonly string[] | undefined;
		const unsubscribe = h.session.subscribe((event) => {
			if (
				atPromptStart === undefined &&
				event.type === "message_start" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "same"
			)
				atPromptStart = [...h.session.getFollowUpMessages()];
		});

		await h.session.prompt("same");
		unsubscribe();

		assert.deepEqual(atPromptStart, ["same"], "the queued one is still listed while the prompt starts");
		assert.deepEqual(getUserTexts(h), ["same", "same"]);
	});

	it("a queued message whose text a prompt repeats can still be taken back while the prompt starts", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("to the prompt"), fauxAssistantMessage("to the follow-up")]);
		await h.session.followUp("same");
		let cleared: { steering: readonly string[]; followUp: readonly string[] } | undefined;
		const unsubscribe = h.session.subscribe((event) => {
			if (cleared === undefined && event.type === "message_start" && event.message.role === "user")
				cleared = h.session.clearQueue();
		});

		await h.session.prompt("same");
		unsubscribe();

		assert.deepEqual(cleared?.followUp, ["same"], "taken back");
		assert.deepEqual(getUserTexts(h), ["same"], "only the prompt is sent");
	});

	for (const other of ["still runs", "has finished"] as const) {
		it(`a prompt that only starts a turn sends and queues nothing when another turn started while it was prepared and ${other}`, async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const h = await harness([], {
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							if (event.text === "only if idle") {
								entered.resolve();
								await release.promise;
							}
							return { action: "continue" };
						});
					},
				],
			});
			const answered = Promise.withResolvers<void>();
			h.setResponses([
				async () => {
					await answered.promise;
					return fauxAssistantMessage("answered");
				},
				fauxAssistantMessage("never asked"),
			]);
			const onlyIfIdle = h.session.prompt("only if idle", { startTurnOnly: true, expandPromptTemplates: false });
			await entered.promise;
			const another = h.session.prompt("another message first");
			while (!h.session.isStreaming) await new Promise((resolve) => setTimeout(resolve, 5));
			if (other === "has finished") {
				answered.resolve();
				await another;
			}
			release.resolve();
			await onlyIfIdle;

			assert.deepEqual(
				[...h.session.getSteeringMessages(), ...h.session.getFollowUpMessages()],
				[],
				"nothing queued",
			);
			answered.resolve();
			await another;
			await h.session.agent.waitForIdle();
			assert.deepEqual(getUserTexts(h), ["another message first"], "nothing else sent");
			assert.equal(h.getPendingResponseCount(), 1, "one request");
		});
	}

	it("the queue is announced once as a message is queued and once as a turn takes it", async () => {
		const waiting = waitingTool();
		const h = await harness([waiting.tool]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("answered"),
		]);
		const listings: string[] = [];
		h.session.subscribe((event) => {
			if (event.type === "queue_update") listings.push(`${event.steering.join(",")}/${event.followUp.join(",")}`);
		});
		const run = h.session.prompt("first");
		await waiting.started;
		await h.session.steer("taken");
		waiting.release();
		await run;

		assert.deepEqual(listings, ["taken/", "/"]);
	});
});
