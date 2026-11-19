import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as native from "@bastani/atomic-natives";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";

function value<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
	if (!result.ok) throw new Error("refused");
	return result.value;
}
function refused<T>(result: C.Result<T, { code: string }>, code: string): void {
	assert.equal(!result.ok && result.error.code, code);
}
function changes(raw: string): C.ActivityReport["change"][] {
	return [
		{ kind: "action", tool: raw, text: raw },
		{ kind: "output", offset: raw, bytesBase64: raw },
		{ kind: "attention-set", attention: { kind: "input-needed", requestId: raw, prompt: raw, route: { sessionId: raw, promptId: raw } } },
		{ kind: "attention-set", attention: { kind: "no-recent-activity", lastActivityAt: raw } },
		{ kind: "attention-clear", requestId: raw },
		{ kind: "model", model: raw, thinking: raw },
	];
}
function mutations(change: C.ActivityReport["change"], raw: string): C.ActivityReport["change"][] {
	switch (change.kind) {
		case "action": return [{ ...change, tool: raw }, { ...change, text: raw }];
		case "model": return [{ ...change, model: raw }, { ...change, thinking: raw }];
		case "output": return [{ ...change, offset: raw }, { ...change, bytesBase64: raw }];
		case "attention-clear": return [{ ...change, requestId: raw }];
		case "attention-set": {
			const attention = change.attention;
			if (attention.kind === "no-recent-activity") return [{ ...change, attention: { ...attention, lastActivityAt: raw } }, { ...change, attention: { kind: "no-recent-activity" } }];
			return [
				{ ...change, attention: { ...attention, requestId: raw } },
				{ ...change, attention: { ...attention, prompt: raw } },
				...(["sessionId", "promptId"] as const).map((field) => ({ ...change, attention: { ...attention, route: { ...attention.route, [field]: raw } } })),
				{ ...change, attention: { ...attention, route: { sessionId: attention.route.sessionId, promptId: attention.route.promptId } } },
			];
		}
		case "metrics": throw new Error("numeric reports have their own exhaustive fixture");
	}
}
function output(raw: string): C.OutputRef {
	return { ownerId: raw as C.OwnerId, taskId: raw as C.TaskId, artifactId: raw, byteCount: raw, omittedRanges: [{ start: raw, end: raw }, { start: raw, end: raw }] };
}
function outputMutations(original: C.OutputRef, raw: string): C.OutputRef[] {
	return [
		...(["ownerId", "taskId", "artifactId", "byteCount"] as const).map((field) => ({ ...original, [field]: raw })),
		...(["start", "end"] as const).map((field) => ({ ...original, omittedRanges: [{ ...original.omittedRanges[0], [field]: raw }, original.omittedRanges[1]] })),
		{ ...original, omittedRanges: [] },
	];
}
const actor = new native.TaskSupervisor();
const supervisor = new TaskSupervisor();
const strings = ["\ud800", "\udfff", "\ufffd", "\ud800\udfff", "😀", "a\0b", "", " \r\n", "\u2003"];
let cases = 0;
let conflicts = 0;
let reports = 0;
// RFC #2884: every caller-owned S1 string stays an ordinary string, not UTF-8 replacement data.
for (const raw of strings) {
	const changed = raw === "\ufffd" ? "\ud800" : "\ufffd";
	const scope: C.OwnerScope = { kind: "session", sessionId: `${randomUUID()}${raw}` };
	const host = supervisor.bindHostSession({ scope, authorizeLaunch() {}, createRunner() {
		throw new Error("this owner uses the native runner seam");
	} });
	const owner = value(supervisor.openTaskOwner(host, scope));
	const nativeHost = actor.bindHostSession(scope);
	const nativeOwner = value(actor.openTaskOwner(nativeHost, scope));
	refused(actor.openTaskOwner(nativeHost, { ...scope, sessionId: changed }), "ScopeMismatch");
	const sessionScope: native.OwnerScope = { kind: "workflow-stage", sessionId: scope.sessionId, runId: raw, stageId: raw, stageAttemptId: raw };
	const sessionHost = actor.bindHostSession(sessionScope);
	const sessionOwner = value(actor.openTaskOwner(sessionHost, sessionScope));
	for (const field of ["sessionId", "runId", "stageId", "stageAttemptId"] as const) {
		refused(actor.openTaskOwner(sessionHost, { ...sessionScope, [field]: changed }), "ScopeMismatch");
	}
	const sessionWatch = value(actor.watchOwnerTasks(sessionOwner, () => {}));
	assert.deepEqual(sessionWatch.snapshot.scope, sessionScope);
	actor.disposeSubscription(sessionWatch.lease);
	value(await actor.closeTaskOwner(sessionOwner, "session-close"));
	const intent: C.AgentIntent = { kind: "agent", agent: raw, task: raw, description: raw, cwd: raw };
	const task = value(actor.startAgentTask(nativeOwner, intent, raw));
	const runner = value(actor.claimTaskRunner(task));
	const reference = value(actor.taskReference(task));
	const watch = value(supervisor.watchOwnerTasks(owner));
	const journal = value(actor.watchOwnerTasks(nativeOwner, () => {}));
	const snapshot = () => {
		watch.drain();
		const fresh = value(actor.watchOwnerTasks(nativeOwner, () => {}));
		try { assert.deepEqual(watch.snapshot, fresh.snapshot); } finally { actor.disposeSubscription(fresh.lease); }
		return watch.snapshot.tasks[0];
	};
	try {
		assert.deepEqual(watch.snapshot.scope, scope);
		assert.equal(snapshot().agentName, raw);
		assert.equal(snapshot().title, raw);
		assert.equal(snapshot().launchOperationId, raw);
		assert.deepEqual(value(actor.taskReference(value(actor.startAgentTask(nativeOwner, { ...intent }, raw)))), reference);
		for (const field of ["agent", "task", "description", "cwd"] as const) {
			refused(actor.startAgentTask(nativeOwner, { ...intent, [field]: changed }, raw), "OperationConflict");
			conflicts++;
		}
		for (const field of ["description", "cwd"] as const) {
			const omitted = { ...intent }; delete omitted[field];
			refused(actor.startAgentTask(nativeOwner, omitted, raw), "OperationConflict");
			conflicts++;
		}
		const fresh = value(actor.startAgentTask(nativeOwner, intent, changed));
		assert.notEqual(value(actor.taskReference(fresh)).taskId, reference.taskId, "changed operation IDs are distinct");
		const childIntent = { ...intent, parentTaskId: reference.taskId as C.TaskId };
		const child = value(actor.startAgentTask(nativeOwner, childIntent, `child${raw}`));
		assert.equal(snapshot().parentTaskId, undefined);
		assert.equal(watch.snapshot.tasks.find((entry) => entry.ref.taskId === value(actor.taskReference(child)).taskId)?.parentTaskId, reference.taskId);
		refused(actor.startAgentTask(nativeOwner, { ...childIntent, parentTaskId: raw as C.TaskId }, `child${raw}`), "OperationConflict");
		refused(actor.startAgentTask(nativeOwner, { ...childIntent, parentTaskId: `${reference.taskId}\ud800` as C.TaskId }, `invalid${raw}`), "OwnerClosing");
		assert.deepEqual(value(actor.taskReference(value(actor.lookupTask(nativeOwner, reference.taskId)))), reference);
		refused(actor.lookupTask(nativeOwner, `${reference.taskId}${changed}`), "UnknownTask");
		for (const field of ["generation", "sequence"] as const) refused(actor.watchOwnerTasks(nativeOwner, () => {}, { ...watch.cursor, [field]: `\ud800${watch.cursor[field]}` }), "StaleGeneration");
		value(actor.drainOwnerTasks(journal.lease));
		for (const [index, change] of changes(raw).entries()) {
			const report: C.ActivityReport = { reportId: `${index}/${raw}`, change };
			const receipt = value(actor.reportTaskActivity(runner, report));
			reports++;
			assert.equal(receipt.reportId, report.reportId);
			assert.equal(receipt.disposition, "accepted");
			assert.deepEqual(value(actor.reportTaskActivity(runner, { ...report })), { ...receipt, disposition: "duplicate" });
			for (const mutation of mutations(change, changed)) {
				refused(actor.reportTaskActivity(runner, { ...report, change: mutation }), "ReportConflict");
				conflicts++;
			}
			const events = value(actor.drainOwnerTasks(journal.lease));
			assert.equal(events.events.length, 1);
			assert.deepEqual(events.cursor, receipt.cursor);
			const event = events.events[0].payload;
			assert.equal(event.kind, "task-activity");
			if (event.kind === "task-activity") assert.deepEqual(event.activity, report);
			const record = snapshot();
			if (change.kind === "action") assert.deepEqual(record.currentAction, { tool: raw, text: raw });
			if (change.kind === "model") { assert.equal(record.model, raw); assert.equal(record.thinking, raw); }
			if (change.kind === "attention-set") assert.deepEqual(record.attention, change.attention);
		}
		// Different code-unit report IDs neither collide nor become terminal identity.
		const report: C.ActivityReport = { reportId: raw, change: { kind: "action", tool: raw, text: raw } };
		const receipt = value(actor.reportTaskActivity(runner, report));
		assert.equal(value(actor.reportTaskActivity(runner, { ...report, reportId: changed })).disposition, "accepted");
		refused(actor.reportTaskOutcome(runner, { reportId: raw, result: { kind: "failed", code: raw, message: raw } }), "ReportConflict");
		// Clearing replacement characters cannot clear a surrogate request (and vice versa).
		value(actor.reportTaskActivity(runner, { reportId: `set${raw}`, change: changes(raw)[2] }));
		value(actor.reportTaskActivity(runner, { reportId: `stale${raw}`, change: { kind: "attention-clear", requestId: changed } }));
		assert.equal(snapshot().attention.kind, "input-needed");
		value(actor.reportTaskActivity(runner, { reportId: `clear${raw}`, change: { kind: "attention-clear", requestId: raw } }));
		assert.deepEqual(snapshot().attention, { kind: "none" });
		value(actor.drainOwnerTasks(journal.lease));
		const result: C.TaskResult = { kind: "failed", code: raw, message: raw, output: output(raw) };
		const terminal = { reportId: `terminal${raw}`, result };
		const settled = value(actor.reportTaskOutcome(runner, terminal));
		assert.deepEqual(settled.result, result);
		assert.deepEqual(value(actor.reportTaskOutcome(runner, terminal)), settled);
		for (const changedResult of [{ ...result, code: changed }, { ...result, message: changed }, ...outputMutations(output(raw), changed).map((output) => ({ ...result, output })), { kind: "failed" as const, code: raw, message: raw }]) {
			refused(actor.reportTaskOutcome(runner, { ...terminal, result: changedResult }), "ReportConflict");
			conflicts++;
		}
		refused(actor.reportTaskOutcome(runner, { ...terminal, reportId: `terminal${changed}` }), "ReportConflict");
		const terminalEvents = value(actor.drainOwnerTasks(journal.lease)).events.filter((event) => event.payload.kind === "task-settled");
		assert.equal(terminalEvents.length, 1);
		if (terminalEvents[0].payload.kind === "task-settled") assert.deepEqual(terminalEvents[0].payload.result, result);
		assert.deepEqual(snapshot().execution, { kind: "settled", result });
		assert.deepEqual(snapshot().output, result.output);
		const cleanup: C.Cleanup = { kind: "failed", resources: [{ resource: raw, code: raw, message: raw }, { resource: raw, code: raw, message: raw }] };
		assert.deepEqual(value(actor.acknowledgeTaskCleanup(runner, cleanup)), cleanup);
		assert.deepEqual(value(actor.acknowledgeTaskCleanup(runner, cleanup)), cleanup);
		for (const field of ["resource", "code", "message"] as const) {
			const updated: C.Cleanup = { ...cleanup, resources: [{ ...cleanup.resources[0], [field]: changed }, cleanup.resources[1]] };
			assert.deepEqual(value(actor.acknowledgeTaskCleanup(runner, updated)), updated);
			assert.deepEqual(snapshot().cleanup, updated);
		}
		value(actor.acknowledgeTaskCleanup(runner, cleanup));
		const diagnostic = actor.cancelTask(task, "user");
		refused(diagnostic, "CleanupFailed");
		assert.deepEqual(snapshot().cleanup, cleanup, "diagnostic formatting must not mutate raw resources");
		const cleanupEvents = value(actor.drainOwnerTasks(journal.lease)).events.filter((event) => event.payload.kind === "cleanup-changed");
		assert.equal(cleanupEvents.length, 5, "identical cleanup earns no event; each field change is distinct");
		if (cleanupEvents[0].payload.kind === "cleanup-changed") assert.deepEqual(cleanupEvents[0].payload.cleanup, cleanup);
		value(actor.acknowledgeTaskCleanup(runner, { kind: "reaped" }));
		value(await supervisor.closeTaskOwner(owner, "session-close"));
		assert.deepEqual(value(actor.reportTaskActivity(runner, report)), { ...receipt, disposition: "duplicate" });
		assert.deepEqual(value(actor.reportTaskOutcome(runner, terminal)), settled);
		watch.drain();
		assert.equal(watch.snapshot.state, "closed");
		assert.deepEqual(watch.snapshot.tasks[0].execution, { kind: "settled", result });
		cases++;
	} finally {
		watch.dispose();
		actor.cancelTask(task, "user");
		actor.disposeSubscription(journal.lease);
		value(actor.acknowledgeTaskCleanup(runner, { kind: "reaped" }));
		value(await supervisor.closeTaskOwner(owner, "session-close"));
	}
}
// Completed/cancelled nested output reports share the same exact boundary and replay rules.
for (const kind of ["completed", "cancelled"] as const) for (const raw of strings) {
	const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const owner = value(actor.openTaskOwner(actor.bindHostSession(scope), scope));
	const task = value(actor.startAgentTask(owner, { kind: "agent", agent: raw, task: raw }, raw));
	const runner = value(actor.claimTaskRunner(task));
	const result: C.TaskResult = kind === "completed" ? { kind, output: output(raw) } : { kind, cause: "user", output: output(raw) };
	const report = { reportId: raw, result };
	const receipt = value(actor.reportTaskOutcome(runner, report));
	assert.deepEqual(receipt.result, result);
	assert.deepEqual(value(actor.reportTaskOutcome(runner, report)), receipt);
	for (const changedOutput of outputMutations(output(raw), `${raw}\ufffd`)) {
		refused(actor.reportTaskOutcome(runner, { ...report, result: { ...result, output: changedOutput } }), "ReportConflict");
		conflicts++;
	}
	refused(actor.reportTaskOutcome(runner, { ...report, reportId: `${raw}\ufffd` }), "ReportConflict");
	value(actor.acknowledgeTaskCleanup(runner, { kind: "reaped" }));
	value(await actor.closeTaskOwner(owner, "session-close"));
}
// The real facade forwards raw intent to its single runner; native title fallback copies raw lines.
for (const raw of strings) for (const description of [undefined, "", raw]) {
	const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const line = ` ${raw} end `;
	const intent: C.AgentIntent = { kind: "agent", agent: raw, task: `\u2003\r\n${line}\r\nignored`, cwd: raw, ...(description === undefined ? {} : { description }) };
	let runs = 0;
	let finish = (_result: C.TaskResult) => {};
	const host = supervisor.bindHostSession({ scope, authorizeLaunch(actual) { assert.deepEqual(actual, intent); }, createRunner(_context, actual) {
		assert.deepEqual(actual, intent); runs++;
		return { result: new Promise<C.TaskResult>((resolve) => { finish = resolve; }), cleanup: Promise.resolve<C.Cleanup>({ kind: "reaped" }) };
	} });
	const owner = value(supervisor.openTaskOwner(host, scope));
	const task = value(await supervisor.startAgentTask(owner, intent, raw as C.OperationId));
	assert.equal(value(await supervisor.startAgentTask(owner, intent, raw as C.OperationId)), task);
	const watch = value(supervisor.watchOwnerTasks(owner));
	// str::lines splits embedded LF in raw as before; nonempty description bypasses fallback.
	assert.equal(watch.snapshot.tasks[0].title, description || (raw === " \r\n" ? " end " : line));
	assert.equal(runs, 1);
	finish({ kind: "failed", code: raw, message: raw });
	const outcome = value(await supervisor.waitForTask(task));
	assert.deepEqual(outcome.kind === "settled" && outcome.result, { kind: "failed", code: raw, message: raw });
	value(await supervisor.closeTaskOwner(owner, "session-close"));
	watch.dispose();
}
console.log(`UTF16 PRESERVED ${cases} strings ${reports} variant reports ${conflicts} conflicts 27 facade launches`);
