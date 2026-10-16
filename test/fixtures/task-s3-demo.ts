import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as poll } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { SessionInfo, Message } from "../../packages/intercom/types.js";
import type { TaskExecutionHooks } from "../../packages/subagents/src/shared/types.js";

// RFC PR #2884. Deterministic model, real foreground runner and local Intercom broker.
const root = mkdtempSync(join(tmpdir(), "atomic-s3-demo-"));
process.env.ATOMIC_CODING_AGENT_DIR = root;
delete process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(root, "intercom"));
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { AgentTaskHost } = await import("../../packages/coding-agent/src/core/tasks/agent-adapter.js");
const { TaskCompletionOutbox } = await import("../../packages/coding-agent/src/core/tasks/completion.js");
const { SessionManager } = await import("../../packages/coding-agent/src/core/session-manager.js");
const { WorkflowStageAdmissionBoundary } = await import("../../packages/coding-agent/src/core/workflow-stage-admission.js");
const { runAgentTask } = await import("../../packages/subagents/src/runs/foreground/task-execution.js");
const { runSync } = await import("../../packages/subagents/src/runs/foreground/execution.js");
const { ForegroundDetachHandoff } = await import("../../packages/intercom/foreground-detach-handoff.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const BROKER_READY_MS = 10000;
const socket = getBrokerSocketPath(process.platform, root);
const broker = spawn(process.execPath, [join(cwd, "packages/intercom/broker/broker.ts")], {env: process.env, stdio: "ignore"});
const sender = new IntercomClient();
const receiver = new IntercomClient();
sender.on("error", () => {}); receiver.on("error", () => {});
const gate = Promise.withResolvers<void>();
const started = Promise.withResolvers<TaskExecutionHooks>();
const boundary = new WorkflowStageAdmissionBoundary();
const session = SessionManager.inMemory(cwd);
const outbox = new TaskCompletionOutbox(session, () => boundary.isOpen(), async (envelope) => {
	await boundary.admit(envelope.completionId, async () => {
		(await session.appendCustomMessageEntry("task-completion", JSON.stringify(envelope), false, envelope));

		console.log(`COMPLETION ${JSON.stringify(envelope)}`);
	}, () => { throw new Error("stage closed"); }).completion;
});
const host = new AgentTaskHost({scope: {kind: "session", sessionId: session.getSessionId()}, authorizeLaunch() {}, onTaskSettled: (ref, receipt) => outbox.record(ref.ownerId, receipt)});
const emitter = new EventEmitter();
const events = {on: (name: string, listener: (data: object) => void) => {emitter.on(name, listener); return () => emitter.off(name, listener);}, emit: (name: string, data: object) => {emitter.emit(name, data);}};
const handoff = new ForegroundDetachHandoff({events} as ConstructorParameters<typeof ForegroundDetachHandoff>[0]);
let starts = 0;
try {
	const deadline = Date.now() + BROKER_READY_MS;
	for (;;) {
		const ready = await new Promise<boolean>((done) => {const probe = net.createConnection(socket); probe.once("connect", () => {probe.destroy(); done(true);}); probe.once("error", () => done(false));});
		if (ready) break;
		assert.ok(Date.now() < deadline, "local broker readiness deadline"); await poll(10);
	}
	const registration = {cwd, model: "deterministic", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now()};
	await sender.connect({...registration, name: "s3-child"});
	await receiver.connect({...registration, name: "s3-parent"});
	const delivered = Promise.withResolvers<void>();
	receiver.on("message", (from: SessionInfo, message: Message) => {
		void handoff.deliver({from, message, generation: 1, isCurrent: () => boundary.isOpen(), surface: () => {console.log(`PEER MESSAGE ${message.content.text}`); delivered.resolve();}}).then((value) => assert.equal(value, "delivered"), delivered.reject);
	});
	let taskId = "";
	let bashSeen = false;
	const pending = runAgentTask({host, cwd, agent: "fake-worker", task: "read, coordinate, bash, complete", agents: [{name: "fake-worker", description: "Deterministic child", source: "project", filePath: "fake-worker.md", systemPrompt: "Intercom orchestration channel:\nCoordinate.", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false}], wait: {kind: "foreground"}, options: {cwd, runId: randomUUID(), index: 0, allowIntercomDetach: true, intercomSessionName: "s3-child", intercomEvents: events as Parameters<typeof runSync>[4]["intercomEvents"]}, runtime: {runSync: async (...args) => {
		starts++;
		const options = args[4];
		assert.ok(options.taskExecution);
		const running = runSync(args[0], args[1], args[2], args[3], {...options, onUpdate: (update) => { if (!bashSeen && update.details?.progress?.[0]?.currentTool === "bash") {bashSeen = true; console.log(`ACTIVITY ${taskId} bash`);} }, testSession: {output: "child completed", promptGate: gate.promise, beforeGateEvents: [{type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {path: "fixture.txt"}}], events: [{type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: {command: "printf done"}}]}});
		started.resolve(options.taskExecution);
		return running;
	}}});
	await started.promise;
	// The real foreground route registers onUpdate before awaiting the fake model gate.
	const readDeadline = Date.now() + BROKER_READY_MS;
	for (;;) {
		const watch = host.watchOwnerTasks(); assert.ok(watch.ok);
		const record = watch.value.snapshot.tasks[0]; watch.value.dispose();
		if (record?.currentAction?.tool === "read") {taskId = record.ref.taskId; break;}
		assert.ok(Date.now() < readDeadline, "child read activity deadline"); await poll(5);
	}
	console.log(`ACTIVITY ${taskId} read`);
	const receipt = await sender.send("s3-parent", {text: "genuine peer message"});
	assert.equal(receipt.delivered, true);
	const response = await pending;
	assert.ok(response.kind === "admitted" && response.observation.kind === "yielded");
	assert.equal(response.observation.reason, "intercom-coordination");
	assert.equal(response.observation.taskId, taskId);
	console.log(`TOOL RETURN ${JSON.stringify(response)}`);
	await delivered.promise;
	assert.equal(outbox.pending.length, 0);
	gate.resolve();
	await host.waitForTask(response.observation.taskId);
	await outbox.flush();
	assert.equal(bashSeen, true);
	assert.equal(outbox.pending.length, 0);
	assert.equal(starts, 1);
	console.log(`STARTS ${starts}`);
} finally {
	gate.resolve(); await host.close("session-close"); await boundary.close();
	await sender.disconnect(); await receiver.disconnect();
	if (broker.exitCode === null) {const exited = once(broker, "exit"); broker.kill("SIGTERM"); await exited;}
	rmSync(root, {recursive: true, force: true});
}
console.log("DEMO COMPLETE");
