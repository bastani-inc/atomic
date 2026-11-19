import assert from "node:assert/strict";
import { bindOwnerTaskStore, ChatSessionHost, type ChatSessionHostStyle, initTheme } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { type EditorTheme, setKeybindings } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const style: ChatSessionHostStyle = {
	dim: String, text: String, textMuted: String, accent: String, accentBold: String,
	rule: (_hex, text) => text, cursor: () => "▌", blank: (width) => " ".repeat(width), editorRuleColor: () => "#ffffff",
};
const editorTheme: EditorTheme = { borderColor: String, selectList: { selectedPrefix: String, selectedText: String, description: String, scrollInfo: String, noMatch: String } };

// RFC #2884: real native owner, deterministic session and terminal chat host.
initTheme("dark", false);
const sessionFixture = await createHarness({ tools: [{ name: "launch_probe", label: "Launch probe", description: "Run the demo's deterministic tool.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "Admitted" }], details: {} }) }] });
const tasks = taskFixture();
setKeybindings(new KeybindingsManager());
bindOwnerTaskStore(sessionFixture.session, tasks.store);
const main = new ChatSessionHost({ style, editorTheme, getAgentSession: () => sessionFixture.session });
const events: string[] = [];
const unsubscribe = sessionFixture.session.subscribe((event) => { events.push(event.type); main.applyAgentEvent(event); });
const width = process.stdout.columns ?? 80;
const taskLines = (text: string) => {
	const lines = text.split("\n").map((line) => line.trim());
	const start = lines.findIndex((line) => line.includes("worker: S4 shared projection"));
	const end = lines.findIndex((line, index) => index >= start && line.includes("ctrl+o"));
	return start >= 0 && end >= start ? lines.slice(start, end + 1) : [];
};
const bodyRows = Math.max(1, (process.stdout.rows ?? 24) - 2);
const renderMain = () => plain(main.renderBody(width, bodyRows));
function show(phase: string) {
	const mainText = renderMain();
	const lines = taskLines(mainText);
	assert.ok(lines.length > 0, `task row in ${phase}: ${mainText}`);
	assert.match(lines[0]!, /worker: S4 shared projection/);
	assert.match(lines[1]!, /fixture\/local/);
	assert.match(lines[2]!, phase === "LIVE" ? /running/ : /completed|failed|stopped/);
	assert.match(lines[3]!, /ctrl\+o/);
	assert.equal(lines.length, 4, "collapsed title, model, status and hint");
	assert.equal((mainText.match(/worker: S4 shared projection/g) ?? []).length, 1);
	console.log(`PHASE ${phase} MAIN`);
	console.log(mainText);
	console.log(plain(main.renderFooter(width)));
	console.log(`PASS ${phase}: MAIN anchors=1`);
}
try {
	await tasks.start("S4 shared projection");
	taskValue(tasks.runners[0].context.reportActivity({ reportId: "model", change: { kind: "model", model: "fixture/local" } }));
	sessionFixture.setResponses([
		fauxAssistantMessage(fauxToolCall("launch_probe", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("Launch turn complete."),
	]);
	await sessionFixture.session.prompt("Run the deterministic launch tool.");
	assert.ok(events.includes("tool_execution_end"));
	assert.ok(events.includes("agent_end"));
	taskValue(tasks.runners[0].context.reportActivity({ reportId: "live", change: { kind: "action", tool: "read", text: "background activity after agent end" } }));
	tasks.store.drain();
	show("LIVE");
	await tasks.settle();
	const task = tasks.store.tasks[0];
	assert.equal(task.execution.kind, "settled");
	const envelope = { completionId: `demo-completion-${"x".repeat(4096)}`, ownerId: task.ref.ownerId, taskId: task.ref.taskId, terminalSequence: tasks.store.cursor?.sequence, result: task.execution.kind === "settled" ? task.execution.result : undefined, display: false };
	const beforeMain = main.renderBody(width, bodyRows);
	const count = main.entries().length;
	await sessionFixture.session.sendCustomMessage({ customType: "task-completion", display: false, content: JSON.stringify(envelope), details: envelope });
	assert.deepEqual(main.renderBody(width, bodyRows), beforeMain);
	assert.equal(main.entries().length, count);
	console.log("PASS hidden completion: no component, Spacer or Box; HIDDEN delta=0");
	await sessionFixture.session.sendCustomMessage({ customType: "intercom", display: true, content: "Genuine peer message", details: {} });
	assert.equal((renderMain().match(/Genuine peer message/g) ?? []).length, 1);
	show("SETTLED");
	assert.doesNotMatch(plain(main.renderFooter(width)), /Tasks /);
	console.log("PASS tool_execution_end → agent_end → live background output → settlement");
	console.log(`PASS viewport ${width}x${process.stdout.rows ?? 24}: bounded host allocation`);
} finally {
	unsubscribe(); main.dispose(); await tasks.dispose(); await sessionFixture.cleanup();
}
console.log("DEMO COMPLETE");
