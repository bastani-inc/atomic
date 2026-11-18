import assert from "node:assert/strict";
import type { AgentToolResult } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import {
	harnessPool,
	persistedManager,
	untilStarted,
	waitForCiTurn,
	waitTool,
} from "../../packages/coding-agent/test/helpers/detached-tools.ts";
import {
	isReleasedReplyHandoffResult,
	releasedReplyHandoffResult,
} from "../../packages/intercom/released-reply-wait.ts";
import { recordStageWaitToolResults } from "../../packages/workflows/src/shared/stage-wait.ts";

const pool = harnessPool();
afterEach(() => pool.cleanup());

async function detached(redispatch: boolean) {
	const tool = waitTool();
	const { manager, store } = await persistedManager();
	const first = await pool.harnessWith([tool.definition], manager);
	first.session.setToolDetachment({ afterMs: 0 });
	first.setResponses([waitForCiTurn("ci-1")]);
	await first.session.prompt("watch CI");
	const [original] = first.session.takeDetachedToolCalls();
	assert.ok(original);
	const owner = redispatch
		? await pool.harnessWith([tool.definition], await SessionManager.open(store, manager.getSessionId()))
		: first;
	const call = redispatch ? owner.session.redispatchDetachedToolCalls()[0]! : original;
	await untilStarted(tool, redispatch ? 2 : 1);
	if (redispatch) {
		tool.finish(0, "old call");
		await original.result;
	}
	return {
		owner,
		finish: (result: AgentToolResult) => {
			tool.finishWith(redispatch ? 1 : 0, result);
			return call.result;
		},
	};
}

for (const redispatch of [false, true]) {
	for (const consumer of ["resume", "stage record"] as const) {
		test(`unreadable detached content becomes one error for ${consumer} (redispatched=${redispatch}, #5486)`, async () => {
			const { owner, finish } = await detached(redispatch);
			const result = await finish({
				get content(): never {
					throw new Error("cannot read tool output");
				},
				details: undefined,
			});
			assert.equal(result.isError, true, "the handle itself offers a readable error");
			if (consumer === "stage record") {
				assert.deepEqual(
					recordStageWaitToolResults([result]).map((x) => [x.toolCallId, x.isError]),
					[["ci-1", true]],
				);
			} else {
				owner.setResponses([fauxAssistantMessage("done")]);
				await owner.session.resumeDetachedTurn([result]);
				const saved = owner.sessionManager.buildSessionProjection().messages.filter((m) => m.role === "toolResult");
				assert.deepEqual(
					saved.map((x) => [x.toolCallId, x.isError]),
					[["ci-1", true]],
				);
			}
		});
	}
}

for (const consumer of ["resume", "stage record"] as const) {
	test(`unserializable nested details become one error at ${consumer} (#5486)`, async () => {
		const { owner, finish } = await detached(false);
		const handed = await finish({
			content: [{ type: "text", text: "ok" }],
			details: {
				get missing(): never {
					throw new Error("details unavailable");
				},
			},
		});
		if (consumer === "stage record") {
			assert.deepEqual(
				recordStageWaitToolResults([handed]).map((x) => [x.toolCallId, x.isError]),
				[["ci-1", true]],
			);
		} else {
			owner.setResponses([fauxAssistantMessage("done")]);
			await owner.session.resumeDetachedTurn([handed]);
			await owner.session.resumeDetachedTurn([handed]);
			const saved = owner.sessionManager.buildSessionProjection().messages.filter((m) => m.role === "toolResult");
			assert.deepEqual(
				saved.map((x) => [x.toolCallId, x.isError]),
				[["ci-1", true]],
			);
		}
	});
}

test("detachment reads stateful content and its text only once before handing it to the host (#5486)", async () => {
	const { owner, finish } = await detached(false);
	let contentReads = 0,
		textReads = 0;
	const result = await finish({
		get content() {
			assert.equal(++contentReads, 1);
			return [
				{
					type: "text" as const,
					get text() {
						assert.equal(++textReads, 1);
						return "safe";
					},
				},
			];
		},
		details: undefined,
	});
	assert.equal(result.isError, false);
	assert.deepEqual(recordStageWaitToolResults([result])[0]?.content, [{ type: "text", text: "safe" }]);
	owner.setResponses([fauxAssistantMessage("done")]);
	await owner.session.resumeDetachedTurn([result]);
	assert.deepEqual([contentReads, textReads], [1, 1]);
});

test("an SDK host can resume an unreadable result from across a process boundary (#5486)", async () => {
	const { owner, finish } = await detached(false);
	const handed = await finish({ content: [], details: undefined });
	const raw = {
		...handed,
		get result(): never {
			throw new Error("external payload unavailable");
		},
	};
	owner.setResponses([fauxAssistantMessage("done")]);
	await owner.session.resumeDetachedTurn([raw]);
	const saved = owner.sessionManager.buildSessionProjection().messages.filter((m) => m.role === "toolResult");
	assert.deepEqual(
		saved.map((x) => [x.toolCallId, x.isError]),
		[["ci-1", true]],
	);
});

test("a plain host result keeps its identity and the Intercom release marker (#5486)", async () => {
	const { finish } = await detached(false);
	const original = releasedReplyHandoffResult();
	const handed = await finish(original);
	assert.equal(handed.result, original);
	assert.ok(isReleasedReplyHandoffResult(handed.result.details));
});
