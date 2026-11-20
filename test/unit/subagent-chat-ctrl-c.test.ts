import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { showTaskInspector } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";

const CTRL_C = "\x03";

test("Ctrl+C on a subagent chat's typed prompt clears it, as in the main chat; on an empty prompt it closes the chat", async () => {
	initTheme("dark");
	const previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const transcript = SessionManager.inMemory();
	await transcript.appendMessage({ role: "user", content: "Waiting for guidance", timestamp: 0 });
	let component: Component | undefined;
	let closed = false;
	const custom = ((factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
		new Promise<void>((resolve) => {
			const tui = { terminal: { rows: 24, columns: 80 }, requestRender: () => {} };
			component = factory(tui as never, theme, new KeybindingsManager(), () => resolve()) as Component;
		})) as ExtensionUIContext["custom"];
	const flush = async () => {
		for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
	};
	const input = async (data: string) => {
		component?.handleInput?.(data);
		await flush();
	};
	const screen = () => (component?.render(80) ?? []).map((line) => stripVTControlCharacters(line)).join("\n");
	try {
		await fixture.start("Chat target");
		fixture.runners[0]!.context.bindTranscript({
			getSessionId: () => transcript.getSessionId(),
			getEntries: () => transcript.getEntries(),
		});
		const taskId = fixture.store.tasks[0]!.ref.taskId;
		const shown = showTaskInspector({ custom }, fixture.store, taskId, { chat: true }).then(() => {
			closed = true;
		});
		await flush();
		for (const ch of "draft words") await input(ch);
		assert.match(screen(), /draft words/);
		await input(CTRL_C);
		assert.equal(closed, false, "the chat stays open");
		assert.doesNotMatch(screen(), /draft words/, "the typed prompt is cleared");
		await input(CTRL_C);
		await shown;
		assert.equal(closed, true, "Ctrl+C on the empty prompt closes the chat");
	} finally {
		await fixture.dispose();
		setKeybindings(previousKeys);
	}
});
