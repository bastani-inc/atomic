import assert from "node:assert/strict";
import { type DetachedToolCall, SessionManager } from "@bastani/atomic";
import { afterEach, describe, test, vi } from "vitest";
import type { StageWaitSnapshot } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import {
	deserializeStageWaitError,
	isStageReleasedError,
	isStageReleaseError,
	isStageWaitError,
	StageReleasedError,
	StageReleaseError,
	StageWaitError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import {
	makeRig,
	type RigConfig,
	RUN_ID,
	STAGE_ID,
	STAGE_NAME,
	until,
	waitHooks,
} from "./waiting-stage-controller-rig.js";

const MODEL = { provider: "faux", id: "faux-model" };
const KEEP_RESIDENT =
	"Set releaseWhenWaiting: false only on a stage the workflow must read synchronously while it holds it.";

/**
 * Sessions that keep their transcript in the store, as an `AgentSession` does, and start from what it holds; each has
 * an agent of its own, the faux model and `high` thinking. With `detach`, session 1's prompt detaches the call `c1`.
 */
function storedTranscripts(detach = false): RigConfig["customize"] {
	return (number, _log, ci, manager) => {
		const messages = manager?.buildSessionProjection().messages ?? [];
		let detached: DetachedToolCall[] = [];
		return {
			agent: { session: number } as never,
			model: MODEL as never,
			thinkingLevel: "high",
			messages,
			async prompt(text: string) {
				const message = { role: "user" as const, content: text, timestamp: 1 };
				await manager?.appendMessage(message);
				messages.push(message);
				if (detach && number === 1) detached = [ci.call("c1")];
			},
			takeDetachedToolCalls() {
				const taken = detached;
				detached = [];
				return taken;
			},
		};
	};
}

/** The `StageReleasedError` a read throws; fails when it throws nothing or something else. */
function releasedReadOf(read: () => object): StageReleasedError {
	try {
		read();
	} catch (error) {
		assert.ok(isStageReleasedError(error), String(error));
		return error;
	}
	return assert.fail("the read did not throw");
}

function roleAndContent(messages: readonly object[]): [string, string][] {
	return messages.map((message) => {
		const { role, content } = message as { readonly role: string; readonly content: string };
		return [role, content];
	});
}

describe("reading a stage whose session is released (#4309)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("after stage.release(), agent and messages throw StageReleasedError naming the stage, its session and the member read (#4309)", async () => {
		const rig = makeRig({ customize: storedTranscripts() });
		await rig.ctx.prompt("go");
		const sessionId = rig.ctx.sessionId;
		await rig.ctx.release();

		for (const property of ["agent", "messages"] as const) {
			const error = releasedReadOf(() => rig.ctx[property]);
			assert.ok(error instanceof StageReleasedError && error instanceof StageWaitError, property);
			assert.equal(error.code, "stage-released");
			assert.equal(error.retryable, false);
			assert.deepEqual(error.fields, {
				runId: RUN_ID,
				stageId: STAGE_ID,
				stageName: STAGE_NAME,
				sessionId,
				property,
				waitKind: "release",
			});
		}
		assert.equal(rig.created(), 1, "a read reopens nothing");
		assert.equal(rig.ctx.__isReleased?.(), true);
	});

	test("after stage.release(), model and thinkingLevel are the session's last ones, a level set since wins, and isStreaming is false (#4309)", async () => {
		const rig = makeRig({ customize: storedTranscripts() });
		await rig.ctx.prompt("go");
		await rig.ctx.release();

		assert.equal(rig.ctx.model, MODEL);
		assert.equal(rig.ctx.thinkingLevel, "high");
		assert.equal(rig.ctx.isStreaming, false);
		await rig.ctx.setThinkingLevel("low");
		assert.equal(rig.ctx.thinkingLevel, "low");
		assert.equal(rig.created(), 1);
		assert.deepEqual(waitHooks(rig.log), ["enter:release"]);
	});

	test("the message of a released read names the member, the stage, its session and its wait, then both ways to read it (#4309)", async () => {
		const rig = makeRig({ customize: storedTranscripts() });
		await rig.ctx.prompt("go");
		const sessionId = rig.ctx.sessionId;
		await rig.ctx.release();

		const messages = releasedReadOf(() => rig.ctx.messages);
		assert.equal(
			messages.message,
			`Cannot read stage.messages of stage "${STAGE_NAME}": its session ${sessionId} is released by stage.release() (stage-released). Call await stage.readMessages(), which reads the transcript from the session store and leaves the session released, or call await stage.rehydrate() before reading stage.messages. ${KEEP_RESIDENT}`,
		);
		const agent = releasedReadOf(() => rig.ctx.agent);
		assert.equal(
			agent.message,
			`Cannot read stage.agent of stage "${STAGE_NAME}": its session ${sessionId} is released by stage.release() (stage-released). Call await stage.rehydrate() before reading stage.agent, or await stage.readMessages() to read only the transcript without reopening the session. ${KEEP_RESIDENT}`,
		);
		assert.ok(agent.message.endsWith(agent.hint));
	});

	test("readMessages() on a released stage reads the transcript from the session store once and leaves the session released (#4309)", async () => {
		const rig = makeRig({ customize: storedTranscripts() });
		await rig.ctx.prompt("go");
		const sessionId = rig.ctx.sessionId;
		await rig.ctx.release();
		const load = vi.spyOn(rig.store, "load");

		assert.deepEqual(roleAndContent(await rig.ctx.readMessages()), [["user", "go"]]);
		assert.deepEqual(load.mock.calls, [[sessionId]]);
		assert.equal(rig.created(), 1, "the session was not reopened");
		assert.equal(rig.ctx.__isReleased?.(), true);
		assert.deepEqual(waitHooks(rig.log), ["enter:release"]);
	});

	test("readMessages() on a live stage returns its session's messages without reading the store (#4309)", async () => {
		const rig = makeRig({ customize: storedTranscripts() });
		await rig.ctx.prompt("go");
		const load = vi.spyOn(rig.store, "load");

		assert.equal(await rig.ctx.readMessages(), rig.ctx.messages);
		assert.deepEqual(roleAndContent(rig.ctx.messages), [["user", "go"]]);
		assert.equal(load.mock.calls.length, 0);
	});

	test("after rehydrate(), every member reads the reopened session again (#4309)", async () => {
		const rig = makeRig({ customize: storedTranscripts() });
		await rig.ctx.prompt("go");
		await rig.ctx.release();
		await rig.ctx.rehydrate();

		assert.deepEqual(rig.ctx.agent, { session: 2 });
		assert.deepEqual(roleAndContent(rig.ctx.messages), [["user", "go"]]);
		assert.equal(rig.ctx.model, MODEL);
		assert.equal(rig.ctx.thinkingLevel, "high");
		assert.equal(rig.created(), 2);
	});

	test("a stage released while its tool call runs throws for agent and messages with its wait on the tool, and reads again once woken (#4309)", async () => {
		const rig = makeRig({ customize: storedTranscripts(true) });
		const turn = rig.ctx.prompt("go");
		await until(() => rig.ctx.__isReleased?.() === true);

		const messages = releasedReadOf(() => rig.ctx.messages);
		assert.equal(messages.fields.property, "messages");
		assert.equal(messages.fields.waitKind, "tool");
		assert.equal(releasedReadOf(() => rig.ctx.agent).fields.waitKind, "tool");
		assert.equal(rig.ctx.model, MODEL);
		assert.deepEqual(roleAndContent(await rig.ctx.readMessages()), [["user", "go"]]);

		rig.ci.finish("c1");
		await turn;
		assert.deepEqual(rig.ctx.agent, { session: 2 });
		assert.deepEqual(roleAndContent(rig.ctx.messages), [["user", "go"]]);
	});

	test("a stage reopening its session throws for agent and messages until the reopened session is there, and its sessionId is the session it reopens (#4309)", async () => {
		const reached = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const rehydratedGate = Promise.withResolvers<void>();
		const rig = makeRig({
			customize: storedTranscripts(),
			rehydratedGate: rehydratedGate.promise,
			onCreate: async (number) => {
				if (number !== 2) return;
				reached.resolve();
				await gate.promise;
			},
		});
		await rig.ctx.prompt("go");
		const sessionId = rig.ctx.sessionId;
		await rig.ctx.release();

		const reopening = rig.ctx.rehydrate();
		await reached.promise;
		assert.equal(rig.ctx.__isReleased?.(), false, "the wait has ended, and the session is not back yet");
		const error = releasedReadOf(() => rig.ctx.messages);
		assert.deepEqual(error.fields, {
			runId: RUN_ID,
			stageId: STAGE_ID,
			stageName: STAGE_NAME,
			sessionId,
			property: "messages",
		});
		assert.equal(releasedReadOf(() => rig.ctx.agent).fields.property, "agent");
		assert.equal(rig.ctx.sessionId, sessionId);
		assert.equal(rig.ctx.model, MODEL);

		gate.resolve();
		// The reopened session is attached; the reopening still records the end of the wait.
		await until(() => rig.log.includes("rehydrated:release"));
		assert.deepEqual(rig.ctx.agent, { session: 2 });
		assert.deepEqual(roleAndContent(rig.ctx.messages), [["user", "go"]]);
		rehydratedGate.resolve();
		await reopening;
	});

	test("a stage that never opened a session reads as before: no messages, no model, agent and thinkingLevel not available yet (#4309)", async () => {
		const rig = makeRig({ customize: storedTranscripts() });
		const load = vi.spyOn(rig.store, "load");

		assert.deepEqual(rig.ctx.messages, []);
		assert.equal(rig.ctx.model, undefined);
		assert.equal(rig.ctx.isStreaming, false);
		for (const read of [() => rig.ctx.agent, () => rig.ctx.thinkingLevel]) {
			assert.throws(read, (error: Error) => {
				assert.equal(isStageWaitError(error), false);
				assert.match(error.message, /unavailable until the SDK session has been created/);
				return true;
			});
		}
		assert.deepEqual(await rig.ctx.readMessages(), []);
		assert.equal(load.mock.calls.length, 0);
		assert.equal(rig.created(), 0);
	});

	test("a stage a resumed run starts released throws for every member its stored session holds, since it never saw that session, and readMessages() reads it (#4309)", async () => {
		const rig = makeRig({ customize: storedTranscripts() });
		const stored = await SessionManager.create(rig.store, process.cwd());
		await stored.appendMessage({ role: "user", content: "plan", timestamp: 1 });
		const sessionId = stored.getSessionId();
		const wait: StageWaitSnapshot = { kind: "release", since: 1, promptsCompleted: 1 };
		rig.ctx.__startReleased?.(wait, sessionId);

		for (const property of ["agent", "messages", "model", "thinkingLevel"] as const) {
			assert.deepEqual(
				releasedReadOf(() => rig.ctx[property] as object).fields,
				{ runId: RUN_ID, stageId: STAGE_ID, stageName: STAGE_NAME, sessionId, property, waitKind: "release" },
				property,
			);
		}
		assert.equal(rig.ctx.isStreaming, false);
		assert.deepEqual(roleAndContent(await rig.ctx.readMessages()), [["user", "plan"]]);
		await rig.ctx.setThinkingLevel("low");
		assert.equal(rig.ctx.thinkingLevel, "low");
		assert.equal(rig.created(), 0, "no read reopened the session");
		assert.equal(rig.ctx.__isReleased?.(), true);

		await rig.ctx.rehydrate();
		assert.deepEqual(rig.ctx.agent, { session: 1 });
		assert.equal(rig.ctx.model, MODEL);
		assert.deepEqual(roleAndContent(rig.ctx.messages), [["user", "plan"]]);
	});
});

describe("StageReleasedError across a process boundary (#4309)", () => {
	test("toJSON and deserializeStageWaitError rebuild it as itself, and only its own guard and the family's match it (#4309)", () => {
		const original = new StageReleasedError({
			runId: RUN_ID,
			stageId: STAGE_ID,
			stageName: STAGE_NAME,
			sessionId: "s-1",
			property: "messages",
			waitKind: "idle",
		});
		const back = deserializeStageWaitError(JSON.parse(JSON.stringify(original)));

		assert.equal(back.constructor, StageReleasedError);
		assert.ok(isStageReleasedError(back));
		assert.equal(back.name, "StageReleasedError");
		assert.equal(back.code, "stage-released");
		assert.equal(back.retryable, false);
		assert.equal(back.hint, original.hint);
		assert.equal(back.message, original.message);
		assert.deepEqual(back.fields, original.fields);

		const copy = { name: "StageReleasedError", code: "stage-released" };
		assert.ok(isStageReleasedError(copy));
		assert.ok(isStageWaitError(copy));
		assert.equal(isStageReleaseError(original), false);
		assert.equal(isStageReleaseError(copy), false);
		assert.equal(isStageReleasedError(new StageReleaseError("stage-busy", { stageName: STAGE_NAME })), false);
		assert.equal(isStageReleasedError({ name: "StageReleasedError", code: "not-a-code" }), false);
	});
});
