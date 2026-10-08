import assert from "node:assert/strict";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { APP_NAME } from "../src/config.js";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { ProgramStatusReporter } from "../src/modes/interactive/program-status-reporter.ts";

function setup() {
	const reports: ProgramStatus[] = [];
	const terminal = {
		setProgramStatus: (status: ProgramStatus) => {
			reports.push(status);
		},
	} as Terminal;
	const session = { name: "Session" };
	const reporter = new ProgramStatusReporter(
		() => terminal,
		() => session.name,
	);
	const send = (...events: AgentSessionEvent[]) => {
		for (const event of events) reporter.handleEvent(event);
	};
	const last = () => reports.at(-1);
	return { reports, session, reporter, send, last };
}

function assistantEnd(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AgentSessionEvent {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "secret output" }],
		stopReason,
		errorMessage,
	} as AssistantMessage;
	return { type: "message_end", message };
}
const settled: AgentSessionEvent = { type: "agent_settled", aborted: false };
function compactionEnd(
	reason: "manual" | "threshold" | "overflow",
	errorMessage?: string,
	aborted = false,
): AgentSessionEvent {
	return { type: "compaction_end", reason, result: undefined, aborted, willRetry: false, errorMessage };
}

test("reports working until settled, preserving only the final outcome (#10607)", () => {
	const { reporter, send, last, reports } = setup();
	reporter.report();
	assert.deepEqual(last(), { state: "idle", app: APP_NAME });
	send({ type: "agent_start" }, assistantEnd("error", "retry"), assistantEnd("stop"));
	assert.deepEqual(last(), { state: "working", message: "Session", app: APP_NAME });
	send(settled);
	assert.deepEqual(last(), { state: "done", message: "Session", app: APP_NAME });
	send({ type: "agent_start" }, assistantEnd("error", "Invalid key\nstack"), settled);
	assert.deepEqual(last(), { state: "error", message: "Invalid key", app: APP_NAME });
	send({ type: "agent_start" }, assistantEnd("stop"), { type: "agent_settled", aborted: true });
	assert.deepEqual(last(), { state: "idle", app: APP_NAME });
	assert.ok(!JSON.stringify(reports).includes("secret output"));
});

test("reports recovery and manual compaction outcomes (#10607)", () => {
	const { send, last } = setup();
	send({ type: "agent_start" }, { type: "compaction_start", reason: "overflow" });
	assert.deepEqual(last(), { state: "working", message: "Compacting context", app: APP_NAME });
	send(compactionEnd("overflow", "Failed\nstack"), settled);
	assert.deepEqual(last(), { state: "error", message: "Failed", app: APP_NAME });
	send({ type: "agent_start" }, compactionEnd("threshold", "Failed"), assistantEnd("stop"), settled);
	assert.equal(last()?.state, "done");
	send({ type: "compaction_start", reason: "manual" }, compactionEnd("manual"));
	assert.equal(last()?.state, "done");
	send({ type: "compaction_start", reason: "manual" }, compactionEnd("manual", "No model"));
	assert.equal(last()?.state, "error");
	send({ type: "compaction_start", reason: "manual" }, compactionEnd("manual", undefined, true));
	assert.equal(last()?.state, "idle");
});

test("reports the newest dialog and restores the underlying settled state (#10607)", () => {
	const { reporter, send, last } = setup();
	send({ type: "agent_start" });
	reporter.setBlocked("extension-dialog", { kind: "permission", message: "Allow bash?" });
	reporter.setBlocked("login", { kind: "auth", message: "Log in" });
	assert.equal(last()?.kind, "auth");
	reporter.setBlocked("login", undefined);
	send(assistantEnd("stop"), settled);
	assert.equal(last()?.kind, "permission");
	reporter.setBlocked("extension-dialog", { kind: "question", message: "Choose" });
	assert.equal(last()?.kind, "question");
	reporter.setBlocked("extension-dialog", undefined);
	assert.equal(last()?.state, "done");
});

test("deduplicates reports and follows session rename and replacement (#10607)", () => {
	const { reporter, reports, session, send, last } = setup();
	send({ type: "agent_start" }, assistantEnd("toolUse"));
	reporter.report();
	assert.equal(reports.length, 1);
	session.name = "Renamed";
	send({ type: "session_info_changed", name: "Renamed" });
	assert.equal(last()?.message, "Renamed");
	reporter.reset();
	assert.equal(last()?.state, "idle");
});
