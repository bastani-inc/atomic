import assert from "node:assert/strict";
import { ChatSessionHost, SessionManager } from "@bastani/atomic";
import { Key, matchesKey, setKeybindings } from "@bastani/atomic-tui";
import { FooterDataProvider } from "../../packages/coding-agent/src/core/footer-data-provider.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { createFullscreenTui } from "../../packages/coding-agent/src/modes/interactive/interactive-tui.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { editorTheme, plainStyle } from "../unit/chat-session-host-working-lifecycle-fixture.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";

// F3 admits two tasks, F4 appends child output, F5 settles tasks.

// Type /tasks, use Enter/Escape for drilldown/back, Ctrl+C to dispose this fixture.
const harness = await createHarness();
const keys = new KeybindingsManager();
setKeybindings(keys);
const tui = createFullscreenTui({
	showHardwareCursor: false,
	logDirectory: "/tmp",
	shouldHandleViewportInput: () => false,
});
const mainTasks = taskFixture();
bindOwnerTaskStore(harness.session, mainTasks.store);
const footer = new FooterDataProvider(harness.session.sessionManager.getCwd());
footer.setAvailableProviderCount(2);
footer.setExtensionStatus("mcp", "MCP: 0/1 servers");
footer.startGitWatcher();
const main = new ChatSessionHost({
	taskRowsInChat: false,
	style: plainStyle,
	editorTheme,
	tui,
	keybindings: keys,
	getAgentSession: () => harness.session,
	footerData: footer,
	requestRender: () => tui.requestRender(),
	commands: {
		handleSlashCommand: (text): boolean => {
			if (text !== "/tasks") return false;
			return main.openTasks();
		},
	},
});
const transcripts = new Map<string, SessionManager>();
let sequence = 0;
let stopping = false;
async function seed() {
	const tasks = mainTasks;
	if (tasks.store.tasks.length > 0) return;
	for (const name of ["Review", "Verify"]) {
		await tasks.start(`main ${name}`);
		const runner = tasks.runners.at(-1)!;
		taskValue(runner.context.reportActivity({
			reportId: "fixture-model",
			change: { kind: "model", model: "fixture/local", thinking: "medium" },
		}));
		const session = SessionManager.inMemory();
		for (let row = 0; row < 40; row++) {
			(await session.appendMessage({ role: "user", content: `main ${name} transcript row ${row}`, timestamp: row }));
		}
		runner.context.bindTranscript(session);
		transcripts.set(runner.context.ref.taskId, session);
	}
	tasks.store.drain();
	tui.requestRender();
}
async function update(settle: boolean) {
	const tasks = mainTasks;
	for (let index = 0; index < tasks.runners.length; index++) {
		const runner = tasks.runners[index];
		if (settle) await tasks.settle(index);
		else {
			await transcripts.get(runner.context.ref.taskId)?.appendMessage({
				role: "user", content: `main LIVE UPDATE ${++sequence}`, timestamp: Date.now(),
			});
			taskValue(runner.context.reportActivity({
				reportId: `activity-${sequence}`,
				change: { kind: "action", tool: "read", text: `main LIVE UPDATE ${sequence}` },
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
	footer.dispose();
	tui.stop();
	await mainTasks.dispose();
	await harness.cleanup();
	console.log("task-picker-parity fixture disposed");
}
const component = {
	focused: true,
	invalidate() { main.invalidate(); },
	render(width: number) {
		const rows = tui.terminal.rows;
		if (main.taskInspectorFullscreen) return main.renderBody(width, rows);
		const footerLines = main.renderFooter(width).slice(0, Math.max(0, rows - 1));
		const editor = main.hasTaskInspector ? [] : main.renderEditor(width);
		return [...main.renderBody(width, Math.max(1, rows - footerLines.length - editor.length)), ...editor, ...footerLines];
	},
	handleInput(data: string) {
		if (matchesKey(data, Key.ctrl("c"))) { void stop(); return true; }
		if (matchesKey(data, "f3")) void seed();
		else if (matchesKey(data, "f4")) void update(false);
		else if (matchesKey(data, "f5")) void update(true);
		else if (!main.handleTaskInput(data)) main.handleInput(data);
		tui.requestRender();
		return true;
	},
};
assert.ok(harness.session.state.model, "fixture must use its actual resolved model");
tui.showOverlay(component, { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 });
tui.start();
process.once("SIGTERM", () => void stop());
