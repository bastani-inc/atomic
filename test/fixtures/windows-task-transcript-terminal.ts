import { appendFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { Key, matchesKey, setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { createFullscreenTui } from "../../packages/coding-agent/src/modes/interactive/interactive-tui.js";
import { taskFixture } from "../helpers/task-projection.js";
import { editorTheme, plainStyle } from "../unit/chat-session-host-working-lifecycle-fixture.js";
import { createStageSkillFixture } from "./stage-chat-skill-session.js";

// Real local host and terminal, deterministic task runner; no provider/network requests.
const evidence = process.env.TASK_TERMINAL_EVENTS!;
const record = (value: object) => appendFileSync(evidence, `${JSON.stringify({ at: performance.now(), ...value })}\n`);
const workflow = await createStageSkillFixture();
const keys = new KeybindingsManager();
setKeybindings(keys);
const tui = createFullscreenTui({
	showHardwareCursor: false,
	logDirectory: process.env.TEMP!,
	shouldHandleViewportInput: () => false,
});
const tasks = taskFixture();
bindOwnerTaskStore(workflow.main.session, tasks.store);
const main = new ChatSessionHost({
	taskRowsInChat: false,
	style: plainStyle,
	editorTheme,
	tui,
	keybindings: keys,
	getAgentSession: () => workflow.main.session,
	requestRender: () => tui.requestRender(),
	commands: {
		handleSlashCommand: (text): boolean => {
			record({ kind: "slash", text });
			return text === "/tasks" && main.openTasks();
		},
	},
});
const session = SessionManager.inMemory();
const listeners = new Set<(event: AgentSessionEvent) => void>();
const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-responses",
	provider: "openai",
	model: "fixture",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
});
for (let i = 0; i < 120; i++)
	session.appendMessage(
		assistant(`HISTORY-${String(i).padStart(3, "0")} **retained**\n\n\`\`\`ts\nconst n = ${i};\n\`\`\``),
	);
await tasks.start("Windows burst transcript");
tasks.runners[0].context.bindTranscript({
	getSessionId: () => session.getSessionId(),
	getEntries: () => session.getEntries(),
	subscribe: (listener) => {
		listeners.add(listener);
		record({ kind: "subscribe", count: listeners.size });
		return () => {
			listeners.delete(listener);
			record({ kind: "unsubscribe", count: listeners.size });
		};
	},
});
let timer: ReturnType<typeof setInterval> | undefined;
let count = 0;
let stopping = false;
const emit = (event: AgentSessionEvent) => {
	for (const listener of listeners) listener(event);
};
function burst() {
	if (timer) return;
	record({ kind: "burst-start" });
	timer = setInterval(async () => {
		const start = performance.now();
		for (let j = 0; j < 4; j++) {
			const marker = `LIVE-${String(count++).padStart(4, "0")}`;
			emit({ type: "message_start", message: assistant(marker) });
			for (let k = 0; k < 8; k++)
				emit({
					type: "message_update",
					message: assistant(""),
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: ` delta-${k}`,
						partial: assistant(""),
					},
				});
			const final = assistant(
				`${marker} delta-0 delta-1 delta-2 delta-3 delta-4 delta-5 delta-6 delta-7\n\n**burst retained markdown**`,
			);
			(await session.appendMessage(final));
			emit({ type: "message_end", message: final });
		}
		record({ kind: "burst", count, eventMs: performance.now() - start });
		if (count >= 1000) {
			clearInterval(timer);
			timer = undefined;
			record({ kind: "burst-end", count });
		}
	}, 20);
}
async function stop() {
	if (stopping) return;
	stopping = true;
	clearInterval(timer);
	main.dispose();
	tui.stop();
	await tasks.dispose();
	await workflow.cleanup();
	record({ kind: "exit", listeners: listeners.size });
	process.exit(0);
}
const component = {
	focused: true,
	invalidate() {
		main.invalidate();
	},
	render(width: number) {
		const start = performance.now();
		const rows = tui.terminal.rows;
		const footer = main.renderFooter(width);
		const editor = main.hasTaskInspector ? [] : main.renderEditor(width);
		const lines = main.taskInspectorFullscreen
			? main.renderBody(width, rows)
			: [...main.renderBody(width, Math.max(1, rows - footer.length - editor.length)), ...editor, ...footer];
		record({
			kind: "frame",
			width,
			rows,
			fullscreen: main.taskInspectorFullscreen,
			picker: main.hasTaskInspector,
			count,
			renderMs: performance.now() - start,
			text: stripVTControlCharacters(lines.join("\n")),
		});
		return lines;
	},
	handleInput(data: string) {
		record({ kind: "input", data });
		if (matchesKey(data, Key.ctrl("c"))) {
			void stop();
			return true;
		}
		if (matchesKey(data, "f4")) burst();
		else if (matchesKey(data, "f5"))
			void tasks.settle().then(() => {
				record({ kind: "completed" });
				tui.requestRender();
			});
		else if (!main.handleTaskInput(data)) main.handleInput(data);
		tui.requestRender();
		return true;
	},
};
tui.showOverlay(component, { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 });
tui.start();
record({
	kind: "ready",
	platform: process.platform,
	tty: [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY],
});
process.once("SIGTERM", () => void stop());
