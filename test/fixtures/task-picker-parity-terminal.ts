import assert from "node:assert/strict";
import { ChatSessionHost, SessionManager } from "@bastani/atomic";
import { Key, matchesKey, setKeybindings } from "@earendil-works/pi-tui";
import { FooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { createFullscreenTui } from "../../packages/coding-agent/src/modes/interactive/interactive-tui.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { editorTheme, plainStyle } from "../unit/chat-session-host-working-lifecycle-fixture.js";
import { createStageSkillFixture } from "./stage-chat-skill-session.js";

// Deterministic, credential-free terminal fixture. Main uses the shared in-process
// host; workflow uses a real attached StageChatView. Isolated main mounting is
// covered by main-task-inspector-overlay.test.ts, not simulated by this fixture.
// F2 switches owner, F3 admits two tasks, F4 appends child output, F5 settles tasks.
// Type /tasks, use Enter/Escape for drilldown/back, Ctrl+C to dispose this fixture.
const workflow = await createStageSkillFixture();
const keys = new KeybindingsManager();
setKeybindings(keys);
const tui = createFullscreenTui({
	showHardwareCursor: false,
	logDirectory: "/tmp",
	shouldHandleViewportInput: () => false,
});
const mainTasks = taskFixture();
const stageTasks = taskFixture({
	kind: "workflow-stage",
	sessionId: workflow.stage.session.sessionId,
	runId: workflow.runId,
	stageId: workflow.stageId,
	stageAttemptId: "terminal-fixture",
});
bindOwnerTaskStore(workflow.main.session, mainTasks.store);
bindOwnerTaskStore(workflow.stage.session, stageTasks.store);
const footer = new FooterDataProvider(workflow.main.session.sessionManager.getCwd());
footer.setAvailableProviderCount(2);
footer.setExtensionStatus("mcp", "MCP: 0/1 servers");
footer.startGitWatcher();
const main = new ChatSessionHost({
	taskRowsInChat: false,
	style: plainStyle,
	editorTheme,
	tui,
	keybindings: keys,
	getAgentSession: () => workflow.main.session,
	footerData: footer,
	requestRender: () => tui.requestRender(),
	commands: {
		handleSlashCommand: (text): boolean => {
			if (text !== "/tasks") return false;
			return main.openTasks();
		},
	},
});
const stage = workflow.mount({
	piTui: tui,
	piKeybindings: keys,
	footerData: footer,
	requestRender: () => tui.requestRender(),
});
const transcripts = new Map<string, SessionManager>();
let active: "main" | "workflow" = "main";
let sequence = 0;
let stopping = false;
async function seed() {
	const tasks = active === "main" ? mainTasks : stageTasks;
	if (tasks.store.tasks.length > 0) return;
	for (const name of ["Review", "Verify"]) {
		await tasks.start(`${active} ${name}`);
		const runner = tasks.runners.at(-1)!;
		taskValue(runner.context.reportActivity({
			reportId: "fixture-model",
			change: { kind: "model", model: "fixture/local", thinking: "medium" },
		}));
		const session = SessionManager.inMemory();
		for (let row = 0; row < 40; row++) {
			(await session.appendMessage({ role: "user", content: `${active} ${name} transcript row ${row}`, timestamp: row }));
		}
		runner.context.bindTranscript(session);
		transcripts.set(runner.context.ref.taskId, session);
	}
	tasks.store.drain();
	tui.requestRender();
}
async function update(settle: boolean) {
	const tasks = active === "main" ? mainTasks : stageTasks;
	for (let index = 0; index < tasks.runners.length; index++) {
		const runner = tasks.runners[index];
		if (settle) await tasks.settle(index);
		else {
			await transcripts.get(runner.context.ref.taskId)?.appendMessage({
				role: "user", content: `${active} LIVE UPDATE ${++sequence}`, timestamp: Date.now(),
			});
			taskValue(runner.context.reportActivity({
				reportId: `activity-${sequence}`,
				change: { kind: "action", tool: "read", text: `${active} LIVE UPDATE ${sequence}` },
			}));
		}
	}
	tasks.store.drain();
	tui.requestRender();
}
async function stop() {
	if (stopping) return;
	stopping = true;
	main.dispose();
	stage.dispose();
	footer.dispose();
	tui.stop();
	await mainTasks.dispose();
	await stageTasks.dispose();
	await workflow.cleanup();
	console.log("task-picker-parity fixture disposed");
}
const component = {
	focused: true,
	invalidate() { main.invalidate(); stage.invalidate(); },
	render(width: number) {
		if (active === "workflow") return stage.render(width);
		const rows = tui.terminal.rows;
		if (main.taskInspectorFullscreen) return main.renderBody(width, rows);
		const footerLines = main.renderFooter(width).slice(0, Math.max(0, rows - 1));
		const editor = main.hasTaskInspector ? [] : main.renderEditor(width);
		return [...main.renderBody(width, Math.max(1, rows - footerLines.length - editor.length)), ...editor, ...footerLines];
	},
	handleInput(data: string) {
		if (matchesKey(data, Key.ctrl("c"))) { void stop(); return true; }
		if (matchesKey(data, "f2")) { active = active === "main" ? "workflow" : "main"; }
		else if (matchesKey(data, "f3")) void seed();
		else if (matchesKey(data, "f4")) void update(false);
		else if (matchesKey(data, "f5")) void update(true);
		else if (active === "workflow") stage.handleInput(data);
		else if (!main.handleTaskInput(data)) main.handleInput(data);
		tui.requestRender();
		return true;
	},
};
assert.ok(workflow.stage.session.state.model, "fixture must use its actual resolved model");
tui.showOverlay(component, { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 });
tui.start();
process.once("SIGTERM", () => void stop());
