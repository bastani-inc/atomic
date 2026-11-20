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

function chat(options: { earlierRunGoing: boolean }) {
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
		deferredRenderedUserInputs: ["hello"],
		discardDeferredRenderedUserInput(text: string) {
			discarded.push(text);
			mode.deferredRenderedUserInputs = mode.deferredRenderedUserInputs.filter((shown) => shown !== text);
		},
		workingRunMeter: { snapshot: () => undefined, stop() {} },
		stopWorkingLoader() {
			loaderStops += 1;
		},
		runtimeHost: undefined,
	};
	return {
		mode: mode as unknown as InteractiveModeBase,
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
