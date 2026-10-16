import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as poll } from "node:timers/promises";
import { parseArgs } from "node:util";
import { ChatSessionHost, CustomEditor, SessionManager, initTheme } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Key, matchesKey, ProcessTerminal, setKeybindings, TuiAltScreen } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { NativeEvent, OperationId, Result, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import type { FakeRunnerContext, TaskLease } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { plainStyle, editorTheme } from "../unit/chat-session-host-working-lifecycle-fixture.js";
import { createStageSkillFixture, submitStageSkillText } from "./stage-chat-skill-session.js";

// RFC #2884: real host input, native lifecycle and persisted SessionManager evidence.
const { values } = parseArgs({ options: { chat: { type: "string" }, "evidence-dir": { type: "string" }, "run-id": { type: "string" } }, strict: true });
const directory = values["evidence-dir"];
const runId = values["run-id"];
const chat = values.chat;
if (!directory || !runId || (chat !== "main" && chat !== "workflow")) throw new Error("Provide --chat main|workflow --evidence-dir <fresh-dir> --run-id <nonce>");
mkdirSync(directory, { recursive: false });
function processBirth(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}
writeFileSync(
	join(directory, "fixture-process.json"),
	JSON.stringify({ pid: process.pid, ...(processBirth(process.pid) === undefined ? {} : { birth: processBirth(process.pid) }) }),
);
initTheme("dark", false);
const keys = new KeybindingsManager(); setKeybindings(keys);
const workflow = chat === "workflow" ? await createStageSkillFixture() : undefined;
const main = workflow ? undefined : await createHarness({ sessionManager: await SessionManager.create(process.cwd(), join(directory, "sessions")) });
const harness = workflow?.stage ?? main;
assert.ok(harness);
harness.appendResponses(Array.from({ length: 24 }, () => fauxAssistantMessage("Acknowledged.")));
const session = harness.session;
const host = session.getAgentTaskHost();
const { supervisor, owner } = host.ownerBinding;
const store = getOwnerTaskStore(session); assert.ok(store);
const nativeEvents: NativeEvent[] = [];
const watched = value(supervisor.watchOwnerTasks(owner));
void (async () => { for await (const event of watched.events) { nativeEvents.push(event); appendFileSync(join(directory, "events.jsonl"), `${JSON.stringify({ runId, event })}\n`); } })();
let commandId = "boot";
let revision = 0;
let mounted = false;
let commandBusy = false;
let stopping = false;
let expanded = false;
let inspecting = false;
let renderedLines: string[] = [];
let genuineMessages = 0;
let task: TaskLease | undefined;
let taskId: TaskId | undefined;
let context: FakeRunnerContext | undefined;
let completion = Promise.withResolvers<void>();
let afterYield = Promise.withResolvers<void>();
let activity = Promise.withResolvers<void>();
let child: Awaited<ReturnType<typeof createHarness>> | undefined;
let shell: TaskLease | undefined;
let identities: { parent: { pid: number; birth?: string }; grandchild: { pid: number; birth?: string } } | undefined;
function value<T, E>(result: Result<T, E>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; }
function barrier(name: string, evidence: object) { appendFileSync(join(directory!, "barriers.jsonl"), `${JSON.stringify({ runId, barrier: name, commandId, revision: String(revision), cursor: store?.cursor, ...(taskId ? { taskId } : {}), evidence })}\n`); }
async function until(predicate: () => boolean, label: string): Promise<void> { const deadline = Date.now() + 30_000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`Deadline: ${label}`); store?.drain(); watched.drain(); await poll(10); } }
function alive(identity: { pid: number; birth?: string }): boolean {
	try {
		process.kill(identity.pid, 0);
		if (identity.birth === undefined) return true;
		return processBirth(identity.pid) === identity.birth;
	} catch {
		return false;
	}
}
class EvidenceTui extends TuiAltScreen {
	protected override doRender(): void {
		super.doRender(); if (!mounted || stopping || commandBusy) return; revision++;
		const current = revision; const id = commandId; const cursor = store?.cursor;
		const diagnostics = stage?._taskDiagnostics ?? { taskIds: mainHost.entries().flatMap((entry) => entry.kind === "task" ? [entry.task.ref.taskId] : []), emptyCompletionComponents: mainHost.entries().filter((entry) => entry.kind === "custom" && entry.message.customType === "task-completion").length };
		// The legacy diagnostic names count chat rows, not owner tasks or empty renders.
		const evidence = { taskIds: store!.backgroundTasks.map((task) => task.ref.taskId), completionCount: diagnostics.emptyCompletionComponents, toolsExpanded: expanded, anchorCount: diagnostics.taskIds.filter((id) => id === taskId).length, columns: this.terminal.columns, rows: this.terminal.rows, renderedLines: [...renderedLines] };
		process.stdout.write("", () => { appendFileSync(join(directory!, "barriers.jsonl"), `${JSON.stringify({ runId, barrier: "rendered", commandId: id, revision: String(current), cursor, taskId, evidence })}\n`); });
	}
}
const tui = new EvidenceTui(new ProcessTerminal());
const mainHost = new ChatSessionHost({ taskRowsInChat: false, style: plainStyle, editorTheme, tui, keybindings: keys, getAgentSession: () => session, requestRender: () => tui.requestRender(), getChatRenderSettings: () => ({ toolOutputExpanded: expanded }), commands: { handleSlashCommand: async (text) => { if (text.startsWith("/fixture ")) { await command(text); return true; } return false; } } });
const unsubscribeSession = session.subscribe((event) => mainHost.applyAgentEvent(event));
const stage = workflow?.mount({ piTui: tui, piKeybindings: keys, piEditorFactory: (ui, theme, bindings) => new CustomEditor(ui, theme, bindings as KeybindingsManager), requestRender: () => tui.requestRender(), getToolsExpanded: () => expanded, setToolsExpanded: (value) => { expanded = value; } });
const composer = new CustomEditor(tui, editorTheme, keys);
composer.onSubmit = (text) => { composer.setText(""); void command(text).catch(fail); };
const component = {
	focused: true, invalidate() { mainHost.invalidate(); stage?.invalidate(); },
	render(width: number) {
		// StageChatView owns the full frame, including its below-prompt task footer.
		if (stage) renderedLines = stage.render(width);
		else { const body = [...mainHost.renderBody(width, Math.max(1, tui.terminal.rows - 5)), ...mainHost.renderFooter(width)]; renderedLines = [...body.slice(0, Math.max(1, tui.terminal.rows - 4)), ...composer.render(width)]; }
		return renderedLines;
	},
	handleInput(data: string) {
		if (matchesKey(data, Key.ctrl("c"))) { void stop().catch(fail); return; }
		if (inspecting) {
			if (stage) stage.handleInput(data); else mainHost.handleTaskInput(data);
			if (matchesKey(data, Key.escape)) { inspecting = false; commandId = "inspection-closed"; }
			tui.requestRender(); return;
		}
		if (keys.matches(data, "app.tools.expand")) { commandId = "expand"; expanded = !expanded; mainHost.invalidate(); stage?.invalidate(); }
		else if (!mainHost.handleTaskInput(data)) composer.handleInput(data);
		tui.requestRender();
	}
};
async function startAgent(kind: string): Promise<void> {
	completion = Promise.withResolvers<void>(); afterYield = Promise.withResolvers<void>(); activity = Promise.withResolvers<void>();
	child = await createHarness({ sessionManager: (await SessionManager.create(process.cwd(), join(directory!, "child"))), tools: [{ name: "bash", label: "bash", description: "Deterministic task activity", parameters: Type.Object({}), async execute() { await afterYield.promise; assert.ok(context); value(context.reportActivity({ reportId: "after-yield", change: { kind: "action", tool: "bash", text: "Inspect deterministic fixture" } })); activity.resolve(); await completion.promise; return { content: [{ type: "text", text: "fixture output" }], details: {} }; } }] });
	child.setResponses([fauxAssistantMessage(fauxToolCall("bash", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Fixture complete.")]);
	const started = value(await host.startAgentTask({ kind: "agent", agent: "worker", task: "Inspect deterministic fixture", description: "t17 Inspect deterministic fixture" }, `${runId}:${commandId}` as OperationId, (runner) => { context = runner; assert.ok(child); runner.bindTranscript(child.session.sessionManager); const result = child.session.prompt("Inspect deterministic fixture").then(() => ({ kind: "completed" as const, output: store!.tasks.find((item) => item.ref.taskId === runner.ref.taskId)!.output })); runner.signal.addEventListener("abort", () => { completion.resolve(); afterYield.resolve(); void child?.session.abort(); }, { once: true }); return { result, cleanup: result.then(() => ({ kind: "reaped" as const })) }; }));
	task = started.lease; taskId = started.taskId;
	const observed = await host.observeAgentLaunch(taskId, kind === "explicit" ? { kind: "background" } : { kind: "foreground", budgetMs: kind === "timed" ? 0 : 30_000 }, (yieldWait) => { if (kind === "intercom") value(yieldWait("intercom-coordination")); }); value(observed);
	store!.drain(); watched.drain(); const yieldCursor = store!.cursor!;
	if (kind === "intercom") await session.sendCustomMessage({ customType: "intercom", content: "Peer coordination message", display: true }, { triggerTurn: false });
	genuineMessages = session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "intercom").length;
	afterYield.resolve(); await activity.promise; store!.drain(); watched.drain();
	await until(() => nativeEvents.some((event) => event.payload.kind === "task-started" && event.taskId === taskId), "task start");
	barrier("intercom-live", { alias: "t17", attemptId: context?.ref.attemptId, startCount: nativeEvents.filter((event) => event.payload.kind === "task-started" && event.taskId === taskId).length, genuineMessageCount: genuineMessages, observation: value(observed), transport: "deterministic local message admission adapter", execution: store!.tasks.find((item) => item.ref.taskId === taskId)?.execution.kind, yieldCursor, activityCursor: store!.cursor });
}
async function command(text: string): Promise<void> {
	if (text === "/tasks" || text.startsWith("/tasks ")) { commandId = "inspect"; inspecting = true; if (stage) submitStageSkillText(stage, text); else mainHost.openTasks(text.slice(6).trim() || undefined); tui.requestRender(); return; }
	const parts = text.split(/\s+/); const idIndex = parts.indexOf("--command-id"); commandId = idIndex >= 0 ? parts[idIndex + 1] : `manual-${revision}`; const action = parts[1];
	commandBusy = true;
	if (["intercom", "foreground", "explicit", "timed"].includes(action)) await startAgent(action);
	else if (action === "complete") {
		assert.ok(task); completion.resolve(); value(await supervisor.waitForTask(task));
		await until(() => nativeEvents.some((event) => event.payload.kind === "task-settled" && event.taskId === taskId), "terminal");
		const event = nativeEvents.find((item) => item.payload.kind === "task-settled" && item.taskId === taskId)!; assert.equal(event.payload.kind, "task-settled");
		barrier("terminal", { completionId: event.payload.completionId, terminalSequence: event.cursor.sequence });
		await until(() => session.sessionManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "task-completion"), "model persistence");
		const file = session.sessionManager.getSessionFile(); assert.ok(file);
		const entries = (await SessionManager.open(file)).getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "task-completion"); assert.equal(entries.length, 1);
		assert.equal(entries[0].type, "custom_message");
		const persisted = entries[0].details as { completionId: string; taskId: string };
		assert.equal(persisted.completionId, event.payload.completionId); assert.equal(persisted.taskId, taskId);
		barrier("model-persisted", { count: entries.length, display: entries[0].display, completionId: persisted.completionId });
	}
	else if (action === "shell") {
		const path = join(directory!, "identities.json");
		shell = value(await supervisor.startCommandTask(owner, { kind: "command", command: `exec node ${JSON.stringify(resolve("test/fixtures/task-process-tree.mjs"))} ${JSON.stringify(path)}`, terminal: { kind: "pipe" } }, `${runId}:shell` as OperationId));
		const before = value(await supervisor.readTaskOutput(shell, { start: "0", maximumBytes: 8192 }));
		const offset = before.chunks.at(-1)?.offsets.end ?? "0";
		value(await supervisor.waitForTask(shell, 0)); await until(() => existsSync(path), "shell identities");
		identities = JSON.parse(readFileSync(path, "utf8")); assert.ok(identities && alive(identities.parent) && alive(identities.grandchild));
		const deadline = Date.now() + 30_000; let output = "";
		while (!output.includes("output")) {
			assert.ok(Date.now() < deadline, "Post-yield shell output deadline");
			const page = value(await supervisor.readTaskOutput(shell, { start: offset, maximumBytes: 8192 }));
			output = page.chunks.map((chunk) => Buffer.from(chunk.bytes).toString("utf8")).join("");
			if (!output.includes("output")) await poll(10);
		}
		barrier("shell-ready", { identities, output, afterOffset: offset });
	}
	else if (action === "close-owner") { const receipt = value(await host.close(chat === "workflow" ? "stage-close" : "session-close")); assert.ok(receipt.tasks.every((item) => item.cleanup.kind === "reaped")); if (identities) assert.ok(!alive(identities.parent) && !alive(identities.grandchild)); barrier("cleanup", { receipt, identities, retainedIdentitiesExited: true }); }
	else if (action === "quit") { await stop(); return; }
	else throw new Error(`Unsupported fixture command: ${text}`);
	store!.drain(); watched.drain(); mainHost.refreshTaskStore(); commandBusy = false; tui.requestRender();
}
async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	completion.resolve(); afterYield.resolve();
	const receipt = value(await host.close(chat === "workflow" ? "stage-close" : "session-close"));
	// Owner-close completion delivery may still be reconciling a model turn.
	session.pauseQueuedMessages();
	await session.abort();
	unsubscribeSession(); watched.dispose(); mainHost.dispose(); stage?.dispose(); tui.stop(); child?.cleanup();
	if (workflow) await workflow.cleanup(); else main?.cleanup();
	barrier("stopped", { disposed: true, identities, receipt });
}
function fail(error: Error) { appendFileSync(join(directory!, "failure.log"), `${error.stack}\n`); void stop().finally(() => { process.exitCode = 1; }); }
tui.addChild(component); tui.setFocus(component); mounted = true; tui.start(); barrier("ready", { host: chat, ownerId: store.snapshot?.ownerId });
process.stdout.on("resize", () => { commandId = "resize"; tui.requestRender(); });
process.once("SIGTERM", () => { void stop().catch(fail); });
process.once("SIGINT", () => { void stop().catch(fail); });
