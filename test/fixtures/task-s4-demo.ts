import assert from "node:assert/strict";
import { bindOwnerTaskStore, ChatSessionHost, type ChatSessionHostStyle } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { type EditorTheme, setKeybindings, TuiMainScreen, ProcessTerminal } from "@bastani/atomic-tui";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { createStageSkillFixture } from "./stage-chat-skill-session.js";

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const style: ChatSessionHostStyle = {
	dim: String, text: String, textMuted: String, accent: String, accentBold: String,
	rule: (_hex, text) => text, cursor: () => "▌", blank: (width) => " ".repeat(width), editorRuleColor: () => "#ffffff",
};
const editorTheme: EditorTheme = { borderColor: String, selectList: { selectedPrefix: String, selectedText: String, description: String, scrollInfo: String, noMatch: String } };

// RFC #2884: real native owner, real AgentSessions/provider, ChatSessionHost and StageChatView.
const sessionFixture = await createStageSkillFixture();
const tasks = taskFixture();
setKeybindings(new KeybindingsManager());
bindOwnerTaskStore(sessionFixture.main.session, tasks.store);
bindOwnerTaskStore(sessionFixture.stage.session, tasks.store);
const main = new ChatSessionHost({ style, editorTheme, getAgentSession: () => sessionFixture.main.session });
const terminalUi = new TuiMainScreen(new ProcessTerminal());
const stage = sessionFixture.mount({ piTui: terminalUi });
const events: string[] = [];
const unsubscribe = sessionFixture.stage.session.subscribe((event) => { events.push(event.type); main.applyAgentEvent(event); });
const width = process.stdout.columns ?? 80;
const taskLines = (text: string) => {
	const lines = text.split("\n").map((line) => line.trim());
	const start = lines.findIndex((line) => line.includes("worker: S4 shared projection"));
	const end = lines.findIndex((line, index) => index >= start && line.includes("ctrl+o"));
	return start >= 0 && end >= start ? lines.slice(start, end + 1) : [];
};
const bodyRows = Math.max(1, (process.stdout.rows ?? 24) - 2);
const renderMain = () => plain(main.renderBody(width, bodyRows));
const renderStage = () => plain(stage.render(width));
function show(phase: string) {
	stage.handleInput("\x1b[F");
	for (let steps = 0; steps < 200; steps++) {
		const text = renderStage();
		if (text.includes("worker: S4 shared projection") && taskLines(text).length === taskLines(renderMain()).length) break;
		stage.handleInput("\x1b[<64;1;10M");
	}
	const mainText = renderMain();
	const stageText = renderStage();
	assert.deepEqual(taskLines(mainText), taskLines(stageText));
	assert.equal(taskLines(mainText).length, 3, "complete collapsed title/status/hint");
	assert.equal(stage.render(width).length, terminalUi.terminal.rows);
	assert.equal((mainText.match(/worker: S4 shared projection/g) ?? []).length, 1);
	assert.equal((stageText.match(/worker: S4 shared projection/g) ?? []).length, 1);
	console.log(`PHASE ${phase} MAIN`);
	console.log(mainText);
	console.log(plain(main.renderFooter(width)));
	console.log(`PHASE ${phase} STAGE`);
	console.log(stageText);
	console.log(`PASS ${phase}: identical task content; MAIN anchors=1 STAGE anchors=1`);
}
try {
	await tasks.start("S4 shared projection");
	sessionFixture.stage.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user_question", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("Launch turn complete."),
	]);
	await sessionFixture.stage.session.prompt("Run the deterministic launch tool.");
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
	const beforeStage = stage.render(width);
	const beforeStageEntries = stage._transcript;
	const isUsage = (line: string) => line.includes("↑") && line.includes("↓");
	const canonicalUsage = (lines: string[]) => lines.map((line) => isUsage(line) ? "USAGE" : line);
	const count = main.entries().length;
	await sessionFixture.stage.session.sendCustomMessage({ customType: "task-completion", display: false, content: JSON.stringify(envelope), details: envelope });
	assert.deepEqual(main.renderBody(width, bodyRows), beforeMain);
	assert.equal(main.entries().length, count);
	assert.deepEqual(stage._transcript, beforeStageEntries);
	// Nonvisual model admission legitimately changes context usage, not transcript allocation.
	const afterStage = stage.render(width);
	assert.equal(afterStage.length, beforeStage.length);
	assert.deepEqual(canonicalUsage(afterStage), canonicalUsage(beforeStage));
	assert.notEqual(afterStage.find(isUsage), beforeStage.find(isUsage), "nonvisual admission still updates model context usage");
	console.log("PASS hidden completion: no component, Spacer or Box; HIDDEN delta=0");
	await sessionFixture.stage.session.sendCustomMessage({ customType: "intercom", display: true, content: "Genuine peer message", details: {} });
	assert.equal((renderMain().match(/Genuine peer message/g) ?? []).length, 1);
	stage.handleInput("\x1b[F");
	assert.equal((renderStage().match(/Genuine peer message/g) ?? []).length, 1);
	show("SETTLED");
	assert.doesNotMatch(plain(main.renderFooter(width)), /Tasks /);
	console.log("PASS tool_execution_end → agent_end → live background output → settlement");
	console.log(`PASS viewport ${width}x${terminalUi.terminal.rows}: bounded host allocation`);
} finally {
	unsubscribe(); main.dispose(); stage.dispose(); await tasks.dispose(); await sessionFixture.cleanup();
}
console.log("DEMO COMPLETE");
