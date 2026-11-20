import assert from "node:assert/strict";
import { test } from "vitest";
import type { PromptDisposition } from "../src/core/agent-session-types.js";
import {
	type SteeringPromptOptions,
	SteeringQueueController,
	type SteeringQueueLists,
} from "../src/modes/interactive/steering-queue-controller.js";
import { rpcTransportError } from "../src/modes/rpc/rpc-transport-error.js";

/** A prompt the agent has not answered yet; the test answers it. */
interface Pending {
	readonly text: string;
	accept(disposition?: PromptDisposition): void;
	refuse(error: Error): void;
}

/**
 * An agent in another process: its queue as it last listed it, and prompts the test answers. With `canBeLost: false`
 * the chat never gives back what it queued, as a subagent chat's agent.
 */
function agentInAnotherProcess(options: { canBeLost?: boolean } = {}) {
	let listed: SteeringQueueLists = { steering: [], followUp: [] };
	const pending: Pending[] = [];
	const controller = new SteeringQueueController(
		{
			busy: true,
			paused: false,
			canBeLost: options.canBeLost ?? true,
			queued: () => listed,
			prompt: (text: string, options?: SteeringPromptOptions) =>
				new Promise<void>((resolve, reject) => {
					pending.push({
						text,
						accept: (disposition = "queued") => {
							options?.preflightResult?.(true, disposition);
							resolve();
						},
						refuse: (error) => {
							options?.preflightResult?.(false);
							reject(error);
						},
					});
				}),
			clearQueue: () => ({ steering: [], followUp: [] }),
		},
		{
			held: () => [],
			takeHeld: () => ({ messages: [], putBack() {} }),
			changed() {},
			requestRender() {},
		},
	);
	return {
		controller,
		pending,
		/** The agent lists its queue, as a `queue_update` does, and the chat hears it. */
		list(queue: SteeringQueueLists) {
			listed = queue;
			controller.reconcile(queue);
		},
	};
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a lost agent's queue comes back in Alt+Up order: listed, accepted but unlisted, then answered from its last breath", async () => {
	const agent = agentInAnotherProcess();
	const listedSteer = agent.controller.submit("listed steer", "steer", { route: "queue" });
	const listedFollowUp = agent.controller.submit("listed follow-up", "followUp", { route: "queue" });
	agent.list({ steering: ["listed steer"], followUp: ["listed follow-up"] });
	agent.pending[0]!.accept();
	agent.pending[1]!.accept();
	await Promise.all([listedSteer, listedFollowUp]);
	// Accepted, but no listing showed it before the agent was lost.
	const unlisted = agent.controller.submit("unlisted steer", "steer", { route: "queue" });
	agent.pending[2]!.accept();
	await unlisted;
	// Still on its way when the agent was lost.
	const lateAnswer = agent.controller.submit("late steer", "steer", { route: "queue" });
	const refusedLate = agent.controller.submit("refused late", "steer", { route: "queue" });
	await flush();

	agent.controller.loseTarget();
	// The host forgets the lost agent's listing; what is on its way stays shown until it is answered.
	agent.list({ steering: [], followUp: [] });
	assert.deepEqual(agent.controller.allQueued(), { steering: ["late steer", "refused late"], followUp: [] });
	agent.pending[3]!.accept();
	assert.deepEqual(await lateAnswer, { kind: "queued" });
	agent.pending[4]!.refuse(rpcTransportError("Agent process exited"));
	const refused = await refusedLate;
	assert.equal(
		refused.kind,
		"refused",
		"a submission the lost agent never took goes back to the editor by its caller",
	);

	assert.deepEqual(agent.controller.recoverTarget([]), [
		"listed steer",
		"unlisted steer",
		"late steer",
		"listed follow-up",
	]);
	assert.deepEqual(agent.controller.allQueued(), { steering: [], followUp: [] });
	assert.equal(agent.controller.recoverTarget([]), undefined, "a recovery gives back once");
});

test("a message the agent started its next turn with is not given back by a later loss: it was delivered", async () => {
	const agent = agentInAnotherProcess();
	const started = agent.controller.submit("started a turn", "steer", { route: "queue" });
	agent.pending[0]!.accept("started");
	assert.deepEqual(await started, { kind: "started" });
	agent.controller.loseTarget();
	assert.equal(agent.controller.recoverTarget([]), undefined);
});

test("a chat whose agent cannot be lost keeps no copy of a message the agent accepted unlisted", async () => {
	const agent = agentInAnotherProcess({ canBeLost: false });
	const sent = agent.controller.submit("accepted unlisted", "steer", { route: "queue" });
	agent.pending[0]!.accept();
	assert.deepEqual(await sent, { kind: "queued" });
	agent.controller.loseTarget();
	assert.equal(agent.controller.recoverTarget([]), undefined);
});

test("a message the replacement's history shows delivered is not given back; one copy per delivery, steering first", () => {
	const agent = agentInAnotherProcess();
	agent.list({ steering: ["same", "other"], followUp: ["same"] });
	agent.controller.loseTarget();
	assert.deepEqual(agent.controller.recoverTarget(["same"]), ["other", "same"]);
});

test("a submission still unanswered at recovery is given back then, and its late refusal gives back nothing more", async () => {
	const agent = agentInAnotherProcess();
	const inFlight = agent.controller.submit("in flight", "followUp", { route: "queue" });
	await flush();
	agent.controller.loseTarget();
	assert.deepEqual(agent.controller.recoverTarget([]), ["in flight"]);
	assert.deepEqual(agent.controller.allQueued(), { steering: [], followUp: [] });
	agent.pending[0]!.refuse(rpcTransportError("Agent process exited"));
	assert.deepEqual(await inFlight, { kind: "queued" }, "the caller does not put it back a second time");
});

test("without a loss, recovery gives back nothing and queued messages stay where they are", async () => {
	const agent = agentInAnotherProcess();
	const queued = agent.controller.submit("kept", "steer", { route: "queue" });
	agent.list({ steering: ["kept"], followUp: [] });
	agent.pending[0]!.accept();
	assert.deepEqual(await queued, { kind: "queued" });
	assert.equal(agent.controller.recoverTarget([]), undefined);
	assert.deepEqual(agent.controller.allQueued(), { steering: ["kept"], followUp: [] });
});
