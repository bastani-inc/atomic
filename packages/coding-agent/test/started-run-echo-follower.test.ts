import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import type { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { followStartedRunEcho } from "../src/modes/interactive/interactive-render-chat.ts";

/**
 * The host-side follower of a sent message's echo, fed the session's events in the order the host handles them. The
 * engine's answer can be handled after events that followed it on the wire (one read), and events of a run that was
 * still going when the message was sent come before the answer.
 */

function chat(options: { earlierRunGoing: boolean; echoes?: string[] }) {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const discarded: string[] = [];
	let loaderStops = 0;
	const mode = {
		session: {
			turnStartedAt: options.earlierRunGoing ? 1_000 : undefined,
			isStreaming: false,
			subscribe(listener: (event: AgentSessionEvent) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		deferredRenderedUserInputs: options.echoes ?? ["hello"],
		discardDeferredRenderedUserInput(text: string) {
			discarded.push(text);
			const index = mode.deferredRenderedUserInputs.indexOf(text);
			if (index !== -1) mode.deferredRenderedUserInputs.splice(index, 1);
		},
		workingRunMeter: { snapshot: () => undefined, stop() {} },
		stopWorkingLoader() {
			loaderStops += 1;
		},
		runtimeHost: undefined,
	};
	return {
		mode: mode as unknown as InteractiveModeBase,
		/** The host saw a run start, which has not settled yet. */
		seeRunGoing: () => {
			mode.session.turnStartedAt = 2_000;
		},
		emit: (...events: object[]) => {
			for (const event of events) for (const listener of [...listeners]) listener(event as AgentSessionEvent);
		},
		discarded,
		loaderStops: () => loaderStops,
		listening: () => listeners.size,
	};
}

const user = { type: "message_start", message: { role: "user", content: "hello" } };
const assistant = { type: "message_start", message: { role: "assistant", content: [] } };

test("a run that ended before starting, answered in the same read, drops the echo and the send's working row", () => {
	const host = chat({ earlierRunGoing: false });
	const follower = followStartedRunEcho(host.mode, "hello", { sendShowsWorkingRow: true });
	host.emit({ type: "agent_settled", aborted: false });
	follower.answer(true);
	assert.deepEqual(host.discarded, ["hello"]);
	assert.equal(host.loaderStops(), 1);
	assert.equal(host.listening(), 0, "it stops listening once decided");
});

test("the end of a run still going at the send decides nothing for the message's own run", () => {
	for (const ownRun of ["shows", "skips"] as const) {
		const host = chat({ earlierRunGoing: true });
		const follower = followStartedRunEcho(host.mode, "hello", { sendShowsWorkingRow: true });
		host.emit(assistant, { type: "turn_end" }, { type: "agent_end", messages: [] }, { type: "agent_settled" });
		follower.answer(true);
		assert.deepEqual(host.discarded, [], `${ownRun}: nothing decided by the earlier run`);
		assert.equal(host.listening(), 1, `${ownRun}: still waiting for its own run`);
		host.emit({ type: "agent_start" }, ...(ownRun === "shows" ? [user] : []), assistant);
		assert.deepEqual(host.discarded, ownRun === "shows" ? [] : ["hello"], ownRun);
		assert.equal(host.loaderStops(), 0, `${ownRun}: its run's start took the working row over`);
		assert.equal(host.listening(), 0, ownRun);
	}
});

test("the earlier run's end and this run's start, handled before the answer, are told apart", () => {
	const host = chat({ earlierRunGoing: true });
	const follower = followStartedRunEcho(host.mode, "hello", { sendShowsWorkingRow: true });
	host.emit({ type: "agent_end", messages: [] }, { type: "agent_settled" }, { type: "agent_start" }, assistant);
	follower.answer(true);
	assert.deepEqual(host.discarded, ["hello"], "this run skipped its message (#5135)");
	assert.equal(host.loaderStops(), 0);
});

test("a send whose answer never comes stops listening when closed", () => {
	const host = chat({ earlierRunGoing: false });
	const follower = followStartedRunEcho(host.mode, "hello", { sendShowsWorkingRow: true });
	follower.close();
	assert.equal(host.listening(), 0);
	assert.deepEqual(host.discarded, []);
});

test("a run's message is taken by one sent message, though the same text was sent again before the host saw it (#6126)", () => {
	const host = chat({ earlierRunGoing: false, echoes: ["hello", "hello"] });
	const first = followStartedRunEcho(host.mode, "hello", { sendShowsWorkingRow: true });
	first.answer(true);
	// The same text is sent again before the host sees the first one's run, whose start the host sees before the second
	// send's turn begins.
	host.emit({ type: "agent_start" });
	host.seeRunGoing();
	const second = followStartedRunEcho(host.mode, "hello", { sendShowsWorkingRow: true });
	host.emit(
		{ type: "turn_start" },
		{ type: "message_start", message: { role: "user", content: "hello" } },
		{ type: "agent_end", messages: [] },
		{ type: "agent_settled" },
	);
	assert.deepEqual(host.discarded, [], "the first echo stays as the first run's message");
	second.answer(true);
	// The second run repeats input the chat already shows, so it shows no message of its own (#5135).
	host.emit({ type: "agent_start" }, { type: "turn_start" }, { type: "agent_end", messages: [] });
	assert.deepEqual(host.discarded, ["hello"], "the second echo goes");
	assert.deepEqual(host.mode.deferredRenderedUserInputs, ["hello"], "the first run's message is shown once");
	assert.equal(host.listening(), 0);
});

test("a run getting past its prompt reaches every sent message still waiting for its own run (#6126)", () => {
	const host = chat({ earlierRunGoing: false, echoes: ["hello", "again"] });
	const first = followStartedRunEcho(host.mode, "hello", { sendShowsWorkingRow: true });
	const second = followStartedRunEcho(host.mode, "again", { sendShowsWorkingRow: true });
	first.answer(true);
	second.answer(true);
	host.emit({ type: "agent_start" }, { type: "message_start", message: { role: "assistant", content: [] } });
	assert.deepEqual(host.discarded, ["hello", "again"]);
	assert.equal(host.listening(), 0);
});
