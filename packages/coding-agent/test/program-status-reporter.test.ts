import assert from "node:assert/strict";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { APP_NAME } from "../src/config.js";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import type { WorkflowActivityFrame, WorkflowRootActivity } from "../src/core/extensions/workflow-events.js";
import { ProgramStatusReporter } from "../src/modes/interactive/program-status-reporter.js";

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

const cursor = { epoch: "e", revision: 0 };
function root(rootRunId: string, overrides: Partial<WorkflowRootActivity> = {}): WorkflowRootActivity {
	return {
		rootRunId,
		ownerSessionId: "owner",
		state: "idle",
		reason: "quiescent",
		activeExecutionCount: 0,
		actionableBlockCount: 0,
		needsAttention: false,
		...overrides,
	};
}
const working = (id = "run") => root(id, { state: "working", reason: "executing", activeExecutionCount: 1 });
const awaitingInput = (id = "run") =>
	root(id, { state: "blocked", reason: "awaiting_input", actionableBlockCount: 1, needsAttention: true });
const failed = (id = "run") => root(id, { needsAttention: true });
const completed = (id = "run") => root(id);
const snapshot = (...roots: WorkflowRootActivity[]): WorkflowActivityFrame => ({
	kind: "snapshot",
	cursor,
	availability: "ready",
	roots,
});
const changed = (value: WorkflowRootActivity): WorkflowActivityFrame => ({ kind: "changed", cursor, root: value });

test("reports working while a workflow run executes after the main agent settles (#3556)", () => {
	const { reporter, send, last } = setup();
	reporter.handleWorkflowActivity(snapshot());
	send({ type: "agent_start" }, assistantEnd("stop"), settled);
	assert.deepEqual(last(), { state: "done", message: "Session", app: APP_NAME });
	reporter.handleWorkflowActivity(changed(working()));
	assert.deepEqual(last(), { state: "working", message: "Session", app: APP_NAME });
	send({ type: "agent_start" }, assistantEnd("stop"), settled);
	assert.equal(last()?.state, "working", "a settling main turn must not report done while a run executes");
	reporter.handleWorkflowActivity(changed(completed()));
	assert.equal(last()?.state, "done");
});

test("reports a workflow run executing while the main agent is idle (#3556)", () => {
	const { reporter, last } = setup();
	reporter.report();
	reporter.handleWorkflowActivity(snapshot());
	reporter.handleWorkflowActivity(changed(working()));
	assert.equal(last()?.state, "working");
	reporter.handleWorkflowActivity(changed(completed()));
	assert.deepEqual(last(), { state: "done", message: "Session", app: APP_NAME });
});

test("reports blocked while a workflow run or stage waits for input without exposing prompt text (#3556)", () => {
	const { reporter, reports, send, last } = setup();
	reporter.handleWorkflowActivity(snapshot(working()));
	reporter.handleWorkflowActivity(changed(awaitingInput()));
	assert.deepEqual(last(), {
		state: "blocked",
		kind: "question",
		message: "Workflow waiting for input",
		app: APP_NAME,
	});
	send({ type: "agent_start" });
	assert.equal(last()?.state, "blocked", "a main turn does not hide a workflow waiting for input");
	send(assistantEnd("stop"), settled);
	reporter.handleWorkflowActivity(
		changed(root("run", { state: "blocked", reason: "manual_intervention", actionableBlockCount: 1 })),
	);
	assert.equal(last()?.message, "Workflow needs attention");
	reporter.handleWorkflowActivity(changed(working()));
	assert.equal(last()?.state, "working");
	assert.ok(!JSON.stringify(reports).includes("approve"));
});

test("keeps extension dialogs ahead of workflow state (#3556)", () => {
	const { reporter, last } = setup();
	reporter.handleWorkflowActivity(snapshot(awaitingInput()));
	reporter.setBlocked("extension-dialog", { kind: "permission", message: "Allow bash?" });
	assert.equal(last()?.kind, "permission");
	reporter.setBlocked("extension-dialog", undefined);
	assert.equal(last()?.message, "Workflow waiting for input");
});

test("reports error when a workflow run fails and keeps it across lifecycle notice turns (#3556)", () => {
	const { reporter, send, last } = setup();
	reporter.handleWorkflowActivity(snapshot(working()));
	reporter.handleWorkflowActivity(changed(failed()));
	assert.deepEqual(last(), { state: "error", message: "Workflow failed", app: APP_NAME });
	// The failure notice runs an ordinary main-chat turn that settles done.
	send({ type: "agent_start" });
	assert.equal(last()?.state, "working");
	send(assistantEnd("stop"), settled);
	assert.deepEqual(last(), { state: "error", message: "Workflow failed", app: APP_NAME });
	// A later changed frame that repeats the settled failure is not a new outcome.
	reporter.handleWorkflowActivity(changed({ ...failed(), graph: { nodes: [] } }));
	assert.equal(last()?.state, "error");
});

test("clears a workflow failure when the user next sends a message (#3556)", () => {
	const { reporter, send, last } = setup();
	reporter.handleWorkflowActivity(snapshot(working()));
	reporter.handleWorkflowActivity(changed(failed()));
	send(
		{ type: "agent_start" },
		{
			type: "message_start",
			message: { role: "custom", customType: "notice", content: "failed", display: true, timestamp: 0 },
		},
		assistantEnd("stop"),
		settled,
	);
	assert.equal(last()?.state, "error", "a lifecycle notice is not the user's input");
	send(
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "user", content: "retry", timestamp: 0 } },
		assistantEnd("stop"),
	);
	assert.equal(last()?.state, "working");
	send(settled);
	assert.deepEqual(last(), { state: "done", message: "Session", app: APP_NAME });
	reporter.handleWorkflowActivity(changed({ ...failed(), graph: { nodes: [] } }));
	assert.equal(last()?.state, "done", "an acknowledged failure is not reported again");
});

test("reports a failure that follows a recovered run and ignores one that was already settled (#3556)", () => {
	const { reporter, last } = setup();
	reporter.handleWorkflowActivity(snapshot(failed("old")));
	assert.equal(last()?.state, "idle", "a failure present at startup is history, not an outcome");
	reporter.handleWorkflowActivity(changed(working("old")));
	assert.equal(last()?.state, "working");
	reporter.handleWorkflowActivity(changed(failed("old")));
	assert.equal(last()?.state, "error");
});

test("keeps working until every workflow run settles and reports the failure afterwards (#3556)", () => {
	const { reporter, last } = setup();
	reporter.handleWorkflowActivity(snapshot(working("a"), working("b")));
	reporter.handleWorkflowActivity(changed(failed("a")));
	assert.equal(last()?.state, "working");
	reporter.handleWorkflowActivity(changed(completed("b")));
	assert.deepEqual(last(), { state: "error", message: "Workflow failed", app: APP_NAME });
});

test("does not report done for a paused or stopping workflow run (#3556)", () => {
	const { reporter, last } = setup();
	reporter.handleWorkflowActivity(snapshot(working("a"), root("b", { state: "working", reason: "stopping" })));
	reporter.handleWorkflowActivity(changed(root("a", { reason: "paused" })));
	reporter.handleWorkflowActivity(changed(root("b")));
	assert.equal(last()?.state, "idle");
});

test("drops a removed or unavailable workflow source (#3556)", () => {
	const { reporter, last } = setup();
	reporter.handleWorkflowActivity(snapshot(working("a")));
	reporter.handleWorkflowActivity({ kind: "removed", cursor, rootRunId: "a" });
	assert.equal(last()?.state, "idle");
	reporter.handleWorkflowActivity(snapshot(working("b")));
	reporter.handleWorkflowActivity({ kind: "snapshot", cursor, availability: "unavailable" });
	assert.equal(last()?.state, "idle");
	reporter.handleWorkflowActivity(snapshot(working("b")));
	reporter.handleWorkflowActivity(changed(failed("b")));
	reporter.handleWorkflowActivity({ kind: "removed", cursor, rootRunId: "b" });
	assert.equal(last()?.state, "idle");
});

test("ignores workflow outcomes that arrive before a ready snapshot (#3556)", () => {
	const { reporter, last } = setup();
	reporter.handleWorkflowActivity({ kind: "snapshot", cursor, availability: "unavailable" });
	reporter.handleWorkflowActivity(changed(failed()));
	assert.equal(last()?.state, "idle");
});
