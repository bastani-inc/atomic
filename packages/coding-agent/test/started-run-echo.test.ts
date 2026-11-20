import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	nextStartedRunEcho,
	STARTED_RUN_ECHO_SENT,
	type StartedRunEcho,
	type StartedRunEchoEvent,
} from "../src/modes/interactive/started-run-echo.ts";

/**
 * What becomes of a sent message's echo once its run starts, for every order in which the run's events and the
 * session's answer can arrive. The run's own events are the authority: a run that shows its user message keeps the
 * echo as that message; one that gets past its prompt without one drops it (#5135); one that never starts drops it.
 */

const RUN_START: StartedRunEchoEvent = { type: "run-start" };
const USER: StartedRunEchoEvent = { type: "user-message" };
const ASSISTANT: StartedRunEchoEvent = { type: "past-prompt" };
const SETTLED: StartedRunEchoEvent = { type: "run-settled" };
const STARTED: StartedRunEchoEvent = { type: "answer", started: true };

function run(events: readonly StartedRunEchoEvent[]): StartedRunEcho {
	return events.reduce(nextStartedRunEcho, STARTED_RUN_ECHO_SENT);
}

/** Every way to place `answer` among `events`, which keep their own order. */
function withAnswerAnywhere(events: readonly StartedRunEchoEvent[], answer: StartedRunEchoEvent) {
	return Array.from({ length: events.length + 1 }, (_, at) => ({
		at,
		events: [...events.slice(0, at), answer, ...events.slice(at)],
	}));
}

/** A started run as the session sends it: start, its prompt messages, its first answer, its end, settled. */
const showsItsMessage = [RUN_START, USER, ASSISTANT, { type: "past-prompt" }, SETTLED] as const;
const skipsItsMessage = [RUN_START, ASSISTANT, { type: "past-prompt" }, SETTLED] as const;

describe("a started run's echo, whatever the order of the answer and the run's events", () => {
	test("a run that shows its message leaves the echo to it, at every answer position", () => {
		for (const { at, events } of withAnswerAnywhere(showsItsMessage, STARTED)) {
			assert.deepEqual(run(events), { kind: "settled", echo: "left" }, `answer at ${at}`);
		}
	});

	test("a run that skips its message drops the echo, at every answer position (#5135)", () => {
		for (const { at, events } of withAnswerAnywhere(skipsItsMessage, STARTED)) {
			assert.deepEqual(run(events), { kind: "settled", echo: "dropped" }, `answer at ${at}`);
		}
	});

	test("the echo waits while the answer has arrived and the run's message has not", () => {
		assert.deepEqual(run([STARTED]), { kind: "awaiting-run-message", runStarted: false });
		assert.deepEqual(run([STARTED, RUN_START]), { kind: "awaiting-run-message", runStarted: true });
		assert.deepEqual(run([RUN_START, STARTED]), { kind: "awaiting-run-message", runStarted: true });
	});

	test("a run that settles or loses its engine before it starts never ran, in either order with its answer", () => {
		assert.deepEqual(run([STARTED, SETTLED]), { kind: "settled", echo: "never-ran" });
		assert.deepEqual(run([SETTLED, STARTED]), { kind: "settled", echo: "never-ran" });
		assert.deepEqual(run([STARTED, { type: "lost" }]), { kind: "settled", echo: "never-ran" });
		assert.deepEqual(run([STARTED, RUN_START, { type: "lost" }]), { kind: "settled", echo: "dropped" });
	});

	test("an answer other than started, or an engine lost before any answer, leaves the echo to the rest of the chat", () => {
		const other: StartedRunEchoEvent = { type: "answer", started: false };
		for (const { at, events } of withAnswerAnywhere(skipsItsMessage, other)) {
			assert.deepEqual(run(events), { kind: "settled", echo: "left" }, `answer at ${at}`);
		}
		assert.deepEqual(run([{ type: "lost" }, STARTED]), { kind: "settled", echo: "left" });
	});

	test("a user message shown before the answer keeps the echo, as it always did", () => {
		assert.deepEqual(run([USER, STARTED]), { kind: "settled", echo: "left" });
	});

	test("a settled echo stays settled", () => {
		for (const settled of [run([USER, STARTED]), run([STARTED, RUN_START, ASSISTANT]), run([STARTED, SETTLED])]) {
			for (const event of [RUN_START, USER, ASSISTANT, SETTLED, STARTED, { type: "lost" } as const]) {
				assert.deepEqual(nextStartedRunEcho(settled, event), settled);
			}
		}
	});
});
