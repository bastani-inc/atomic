import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import { describe, test } from "vitest";
import {
	createCompletedStageAnswerer,
	registerCompletedStageIntercomAskRouter,
} from "../../packages/workflows/src/extension/completed-stage-intercom-ask.js";
import type {
	AgentSessionEventListener,
	StageControlHandle,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";

interface FakeStage {
	readonly handle: StageControlHandle;
	readonly calls: string[];
	/** Subscriptions open right now: the hold an ask keeps on the reopened stage. */
	subscribers(): number;
}

function fakeStage(
	stageId: string,
	options: { streaming?: boolean; reply?: string; onPrompt?: (text: string) => Promise<void> } = {},
): FakeStage {
	const listeners = new Set<AgentSessionEventListener>();
	const calls: string[] = [];
	const handle: StageControlHandle = {
		runId: "run-4642",
		stageId,
		stageName: stageId,
		status: "completed",
		sessionId: `session-${stageId}`,
		sessionFile: undefined,
		isStreaming: options.streaming === true,
		messages: [],
		async ensureAttached() {
			calls.push(`attach (${listeners.size} subscribed)`);
		},
		async prompt(text) {
			calls.push(`prompt ${text}`);
			await options.onPrompt?.(text);
			if (options.reply === undefined) return;
			const message = { role: "assistant", content: [{ type: "text", text: options.reply }] };
			for (const listener of [...listeners]) listener({ type: "message_end", message } as AgentSessionEvent);
		},
		async steer() {},
		async followUp(text) {
			calls.push(`followUp ${text}`);
		},
		async pause() {},
		async resume() {
			return undefined;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return { handle, calls, subscribers: () => listeners.size };
}

function resolverFor(...stages: FakeStage[]) {
	return (_runId: string, stageId: string) => {
		const stage = stages.find((candidate) => candidate.handle.stageId === stageId);
		return stage === undefined ? undefined : { ok: true as const, handle: stage.handle };
	};
}

describe("an Intercom ask holds the stage it reopened until its answer (#4642)", () => {
	test("the ask subscribes before it attaches and lets go once it answered", async () => {
		const stage = fakeStage("a", { reply: "the answer" });
		const answer = createCompletedStageAnswerer(resolverFor(stage));

		assert.equal(await answer("run-4642", "a", "question"), "the answer");
		assert.deepEqual(stage.calls, ["attach (1 subscribed)", "prompt question"]);
		assert.equal(stage.subscribers(), 0);
	});

	test("asks to different stages run side by side, asks to one stage in turn", async () => {
		const release = Promise.withResolvers<void>();
		const slow = fakeStage("slow", { reply: "slow", onPrompt: () => release.promise });
		const fast = fakeStage("fast", { reply: "fast" });
		const answer = createCompletedStageAnswerer(resolverFor(slow, fast));

		const slowAnswer = answer("run-4642", "slow", "first");
		assert.equal(await answer("run-4642", "fast", "second"), "fast", "the other stage answers while the first waits");
		release.resolve();
		assert.equal(await slowAnswer, "slow");
	});

	test("a stage busy with another turn refuses the ask and is let go", async () => {
		const stage = fakeStage("a", { streaming: true, reply: "never" });
		const answer = createCompletedStageAnswerer(resolverFor(stage));

		await assert.rejects(answer("run-4642", "a", "question"), /is busy with another turn/);
		assert.equal(stage.subscribers(), 0);
		assert.ok(!stage.calls.some((call) => call.startsWith("prompt")));
	});

	test("a turn that says nothing is answered as such", async () => {
		const stage = fakeStage("a");
		const answer = createCompletedStageAnswerer(resolverFor(stage));

		assert.match(await answer("run-4642", "a", "question"), /reopened but produced no text answer/);
	});

	test("an ask whose owning session closed during the turn fails instead of answering", async () => {
		let open = true;
		const stage = fakeStage("a", {
			reply: "late",
			onPrompt: async () => {
				open = false;
			},
		});
		const answer = createCompletedStageAnswerer(resolverFor(stage), () => {
			if (!open) throw new Error("owning session closed");
		});

		await assert.rejects(answer("run-4642", "a", "question"), /owning session closed/);
		assert.equal(stage.subscribers(), 0);
	});

	test("a late message to a stage still in a turn is queued as a follow-up", async () => {
		const stage = fakeStage("a", { streaming: true });
		let listener: ((event: object) => void) | undefined;
		registerCompletedStageIntercomAskRouter(
			{
				events: {
					on: (_name: string, callback: (event: object) => void) => {
						listener = callback;
						return () => {};
					},
				},
			} as never,
			resolverFor(stage),
		);
		const event = {
			handled: false,
			batch: false,
			workflowRunId: "run-4642",
			workflowStageId: "a",
			messages: [{ customType: "intercom_message", content: "late", details: { message: { expectsReply: true } } }],
		} as { handled: boolean; completion?: Promise<void> };
		listener?.(event);
		await event.completion;

		assert.deepEqual(stage.calls, ["attach (1 subscribed)", "followUp late"]);
		assert.equal(stage.subscribers(), 0);
	});
});
