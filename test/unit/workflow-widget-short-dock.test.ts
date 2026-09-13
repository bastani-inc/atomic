import assert from "node:assert/strict";
import { type KeyId, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.js";
import { getEditorTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
} from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.js";
import factory from "../../packages/workflows/src/extension/extension-factory.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { store } from "../../packages/workflows/src/shared/store.js";

// #3015: a multiline editor can leave only one painted widget row at 80x9.
test("registered workflow shortcuts reach every run in a clipped dock without stealing the editor", async () => {
	const fixture = createProductionFullscreenContext({ columns: 80, rows: 9 });
	const { context, tui, terminal } = fixture;
	const shortcuts = new Map<KeyId, Parameters<NonNullable<ExtensionAPI["registerShortcut"]>>[1]>();
	const ids = Array.from({ length: 7 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
		context.editorContainer.clear();
		context.editorContainer.addChild(editor);
		context.editor = editor;
		context.defaultEditor = editor;
		tui.setFocus(editor);
		factory({
			ui: context.createExtensionUIContext() as unknown as NonNullable<ExtensionAPI["ui"]>,
			on() {},
			registerShortcut(key, shortcut) {
				shortcuts.set(key as KeyId, shortcut);
			},
			registerTool() {},
			registerCommand() {},
			events: {
				on() {
					return () => {};
				},
				emit() {},
			},
		});
		editor.onExtensionShortcut = (data) => {
			for (const [key, shortcut] of shortcuts) {
				if (matchesKey(data, key)) {
					void shortcut.handler();
					return true;
				}
			}
			return false;
		};
		for (const [i, id] of ids.entries())
			store.recordRunStart({
				id,
				name: "same name",
				status: "paused",
				inputs: {},
				stages: [],
				startedAt: 1_700_000_000_000 + i,
			});
		await Promise.resolve();
		const draft = Array.from({ length: 10 }, (_, i) => `draft${i}`).join("\n");
		editor.setText(draft);
		tui.renderNow();
		const mounted = context.extensionWidgetsBelow.get("workflow.run");
		assert.ok(mounted);
		const frame = () => {
			tui.renderNow();
			const lines = getLayoutFrame(tui).lines;
			assert.ok(lines.every((line) => visibleWidth(line) <= terminal.columns));
			assert.ok(lines.length <= terminal.rows);
			assert.equal(editor.getText(), draft);
			assert.equal(context.extensionWidgetsBelow.get("workflow.run"), mounted);
			return lines;
		};
		for (const [width, height] of [
			[80, 9],
			[27, 8],
			[120, 40],
			[80, 12],
			[80, 9],
		]) {
			terminal.resize(width!, height!);
			frame();
			if (width! < 80) continue;
			for (let n = 0; n < 50; n++) {
				terminal.input("\x1b[5;3~");
				frame();
			}
			for (const key of ["\x1b[6;3~", "\x1b[5;3~"]) {
				const seen = new Set<string>();
				for (let n = 0; n < 50; n++) {
					for (const id of ids) if (frame().some((line) => line.includes(id))) seen.add(id);
					terminal.input(key);
				}
				assert.equal(seen.size, ids.length, `${width}x${height}: every UUID reachable in either direction`);
				const endpoint = frame();
				terminal.input(key);
				assert.deepEqual(frame(), endpoint);
			}
		}
		for (const id of ids.slice(0, -1)) store.removeRun(id);
		await Promise.resolve();
		terminal.resize(120, 40);
		assert.ok(frame().some((line) => line.includes(ids.at(-1)!)));
		store.recordRunEnd(ids.at(-1)!, "completed");
		await Promise.resolve();
		assert.ok(frame().some((line) => line.includes("complete")));
		store.removeRun(ids.at(-1)!);
		await Promise.resolve();
		tui.renderNow();
		assert.equal(context.extensionWidgetsBelow.has("workflow.run"), false);
		assert.equal(editor.getText(), draft);
	} finally {
		for (const id of ids) store.removeRun(id);
		fixture.resolveTheme();
		await fixture.initPromise;
		tui.stop();
		fixture.restoreOffline();
	}
});
