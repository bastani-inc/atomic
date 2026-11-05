import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DetachedToolCall, JsonlSessionStore, SessionManager } from "@bastani/atomic";
import { afterEach, describe, test, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import type { StageWaitKind, StageWaitSnapshot } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { STAGE_WAIT_RETRY_ATTEMPTS } from "../../packages/workflows/src/shared/stage-wait.js";
import {
	deserializeStageWaitError,
	isStageReleasedError,
	isStageReleaseError,
	isStageWaitError,
	StageRehydrationError,
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => assert.fail("expected a rejection"),
		(reason: unknown) => reason,
	);
}

/** A stage whose prompt detached `c1` and released its session, then the call's result; reopening fails as `failCreation` says. */
async function toolWaitThatCannotReopen(config: Pick<RigConfig, "failCreation" | "signal">) {
	const rig = makeRig({ ...config, customize: storedTranscripts(true) });
	const turn = rig.ctx.prompt("go");
	await until(() => rig.ctx.__isReleased?.() === true);
	return { rig, turn, sessionId: rig.ctx.sessionId };
}

describe("a stage whose tool wait ended without reopening its session (#4309)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("throws StageReleasedError for agent and messages with the failure as cause, keeps model and thinkingLevel, reads the store, and its next prompt reopens the same session (#4309)", async () => {
		const failure = new Error("No API key found for provider faux");
		const { rig, turn, sessionId } = await toolWaitThatCannotReopen({
			failCreation: (number) => (number === 2 ? failure : undefined),
		});
		rig.ci.finish("c1");
		assert.equal(await rejection(turn), failure);
		assert.equal(rig.ctx.__isReleased?.(), false, "the wait has ended");

		for (const property of ["agent", "messages"] as const) {
			const error = releasedReadOf(() => rig.ctx[property]);
			assert.deepEqual(error.fields, {
				runId: RUN_ID,
				stageId: STAGE_ID,
				stageName: STAGE_NAME,
				sessionId,
				property,
				reopenFailed: true,
			});
			assert.equal(error.cause, failure);
		}
		assert.equal(
			releasedReadOf(() => rig.ctx.messages).message,
			`Cannot read stage.messages of stage "${STAGE_NAME}": its session ${sessionId} is released and could not be reopened (stage-released). Reopening the session failed; the error's cause says why. Call await stage.readMessages() to read the transcript from the session store, or reopen the session with await stage.rehydrate() or the stage's next prompt. ${KEEP_RESIDENT}`,
		);
		assert.equal(rig.ctx.model, MODEL);
		assert.equal(rig.ctx.thinkingLevel, "high");
		const load = vi.spyOn(rig.store, "load");
		assert.deepEqual(roleAndContent(await rig.ctx.readMessages()), [["user", "go"]]);
		assert.deepEqual(load.mock.calls, [[sessionId]]);

		await rig.ctx.prompt("again");
		assert.equal(rig.created(), 3);
		assert.equal(rig.createOptions[1]?.sessionManager?.getSessionId(), sessionId);
		assert.deepEqual(rig.ctx.agent, { session: 3 });
		assert.deepEqual(roleAndContent(rig.ctx.messages), [
			["user", "go"],
			["user", "again"],
		]);
	});

	test("rehydrate() reopens it without a prompt, after which every member reads the reopened session (#4309)", async () => {
		const { rig, turn, sessionId } = await toolWaitThatCannotReopen({
			failCreation: (number) => (number === 2 ? new Error("the adapter refused the session") : undefined),
		});
		rig.ci.finish("c1");
		await rejection(turn);

		await rig.ctx.rehydrate();
		assert.equal(rig.created(), 3);
		assert.equal(rig.createOptions[1]?.sessionManager?.getSessionId(), sessionId);
		assert.deepEqual(rig.ctx.agent, { session: 3 });
		assert.deepEqual(roleAndContent(rig.ctx.messages), [["user", "go"]]);
		await rig.ctx.rehydrate();
		assert.equal(rig.created(), 3, "a stage with its session reopens nothing");
	});

	test("after the store failed on every attempt, the cause is the StageRehydrationError that ended the attempts (#4309)", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const unavailable = () =>
			new StorageUnavailableError(
				{ adapter: "libsql", location: "the shared session store" },
				Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
			);
		const { rig, turn } = await toolWaitThatCannotReopen({
			failCreation: (number) => (number === 1 ? undefined : unavailable()),
		});
		const settled = rejection(turn);
		rig.ci.finish("c1");
		await vi.advanceTimersByTimeAsync(60_000);

		const failure = await settled;
		assert.ok(failure instanceof StageRehydrationError);
		assert.equal(failure.fields.attempts, STAGE_WAIT_RETRY_ATTEMPTS);
		const error = releasedReadOf(() => rig.ctx.messages);
		assert.equal(error.fields.reopenFailed, true);
		assert.equal(error.cause, failure);
	});

	test("an abort during the wait leaves it released with no wait and no failure: the reads still throw, and readMessages() reads the store (#4309)", async () => {
		const controller = new AbortController();
		const reason = new Error("run killed");
		const { rig, turn, sessionId } = await toolWaitThatCannotReopen({ signal: controller.signal });
		controller.abort(reason);
		assert.equal(await rejection(turn), reason);

		const error = releasedReadOf(() => rig.ctx.agent);
		assert.deepEqual(error.fields, {
			runId: RUN_ID,
			stageId: STAGE_ID,
			stageName: STAGE_NAME,
			sessionId,
			property: "agent",
		});
		assert.equal(error.cause, undefined);
		assert.equal(rig.ctx.model, MODEL);
		assert.deepEqual(roleAndContent(await rig.ctx.readMessages()), [["user", "go"]]);
		assert.equal(rig.created(), 1);
	});
});

describe("the message of a StageReleasedError (#4309)", () => {
	const base = { runId: RUN_ID, stageId: STAGE_ID, stageName: STAGE_NAME, sessionId: "s-1" } as const;
	const READ_OR_REHYDRATE = `Call await stage.rehydrate() before reading stage.agent, or await stage.readMessages() to read only the transcript without reopening the session. ${KEEP_RESIDENT}`;

	test("names what the stage waits on for each wait kind, and nothing when it waits on nothing (#4309)", () => {
		const cases: [StageWaitKind | undefined, string][] = [
			["tool", " while the stage waits on a tool call"],
			["release", " by stage.release()"],
			["prompt", " while the stage waits for an answer"],
			["idle", " while the workflow holds the stage idle"],
			[undefined, ""],
		];
		for (const [waitKind, reason] of cases) {
			const error = new StageReleasedError({
				...base,
				property: "agent",
				...(waitKind === undefined ? {} : { waitKind }),
			});
			assert.ok(
				error.message.startsWith(
					`Cannot read stage.agent of stage "${STAGE_NAME}": its session s-1 is released${reason} (stage-released). `,
				),
				error.message,
			);
		}
	});

	test("while it waits on a tool call, the hint says the result reopens it and points at readMessages() (#4309)", () => {
		const error = new StageReleasedError({ ...base, property: "messages", waitKind: "tool" });
		assert.equal(
			error.hint,
			`The stage reopens its session when the tool call's result arrives; call await stage.readMessages() to read the transcript from the session store meanwhile. ${KEEP_RESIDENT}`,
		);
		assert.ok(error.message.endsWith(error.hint));
	});

	test("without a member or a session id, it reads stage.agent of its session (#4309)", () => {
		const error = new StageWaitError("stage-released", { stageName: STAGE_NAME });
		assert.equal(
			error.message,
			`Cannot read stage.agent of stage "${STAGE_NAME}": its session is released (stage-released). ${READ_OR_REHYDRATE}`,
		);
	});

	test("a reopen failure crosses a process boundary with its cause (#4309)", () => {
		const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
		const original = new StageReleasedError({ ...base, property: "messages", reopenFailed: true }, { cause });
		const back = deserializeStageWaitError(JSON.parse(JSON.stringify(original)));

		assert.ok(back instanceof StageReleasedError);
		assert.equal(back.message, original.message);
		assert.deepEqual(back.fields, original.fields);
		assert.ok(back.cause instanceof Error);
		assert.equal(back.cause.message, "connect ECONNREFUSED");
		assert.equal((back.cause as { readonly code?: string }).code, "ECONNREFUSED");
	});
});

describe("the session store readMessages() reads a released stage from (#4309)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("a store opened from the stage's sessionDir is closed after each read, and a caller's sessionStore never is (#4309)", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "atomic-released-reads-"));
		try {
			const rig = makeRig({ withStore: false, stageOptions: { sessionDir }, customize: storedTranscripts() });
			await rig.ctx.prompt("go");
			await rig.ctx.release();
			const open = vi.spyOn(JsonlSessionStore, "open");
			const close = vi.spyOn(JsonlSessionStore.prototype, "close");

			for (let read = 0; read < 3; read++)
				assert.deepEqual(roleAndContent(await rig.ctx.readMessages()), [["user", "go"]]);
			assert.equal(open.mock.calls.length, 3);
			assert.equal(close.mock.calls.length, 3);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}

		const shared = makeRig({ customize: storedTranscripts() });
		await shared.ctx.prompt("go");
		await shared.ctx.release();
		const closeShared = vi.spyOn(shared.store, "close");
		for (let read = 0; read < 3; read++) await shared.ctx.readMessages();
		assert.equal(closeShared.mock.calls.length, 0);
	});

	test("the store is read in the stage's cwd, or the run's when the stage sets none (#4309)", async () => {
		const reads: (string | undefined)[] = [];
		for (const stageOptions of [{}, { cwd: "/stage/tree" }]) {
			const rig = makeRig({ defaultCwd: "/run/tree", stageOptions, customize: storedTranscripts() });
			await rig.ctx.prompt("go");
			await rig.ctx.release();
			const open = vi.spyOn(SessionManager, "open");
			await rig.ctx.readMessages();
			reads.push(...open.mock.calls.map((call) => call[2]));
			open.mockRestore();
		}
		assert.deepEqual(reads, ["/run/tree", "/stage/tree"]);
	});
});
