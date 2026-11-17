import assert from "node:assert/strict";
import type { Component } from "@bastani/atomic-tui";
import { setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	PromptHistorySelectorComponent,
	promptAge,
	promptHistoryEntries,
} from "../src/modes/interactive/components/prompt-history-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

function lines(component: Component, width: number): string[] {
	return component.render(width).map((line) => stripTerminalSequences(line).replace(/\s+$/, ""));
}

describe("prompt history search (ctrl+r) (#5224)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("lists the prompts up and down walk through, newest first and each once, then older session prompts", () => {
		const entries = promptHistoryEntries(
			["ship it", "fix the login bug", "ship it"],
			[
				{ text: "plan the release", sentAt: minutesAgo(90) },
				{ text: "fix the login bug", sentAt: minutesAgo(30) },
				{ text: "ship it", sentAt: minutesAgo(2) },
				{ text: "  ", sentAt: minutesAgo(1) },
			],
		);
		assert.deepEqual(entries, [
			{ text: "ship it", sentAt: minutesAgo(2) },
			{ text: "fix the login bug", sentAt: minutesAgo(30) },
			{ text: "plan the release", sentAt: minutesAgo(90) },
		]);
	});

	it("says how long ago a prompt was sent", () => {
		assert.equal(promptAge(20_000), "just now");
		assert.equal(promptAge(5 * 60_000), "5m ago");
		assert.equal(promptAge(3 * 3_600_000), "3h ago");
		assert.equal(promptAge(2 * 86_400_000), "2d ago");
		assert.equal(promptAge(-5), "just now");
	});

	for (const width of [80, 160]) {
		it(`draws the shared picker at ${width} columns: title, search box, ages and one hint line of live keys`, () => {
			const selector = new PromptHistorySelectorComponent(
				[
					{ text: "ship it", sentAt: minutesAgo(2) },
					{ text: "fix the login bug\nand the redirect", sentAt: minutesAgo(30) },
					{ text: "typed before a restart" },
				],
				{ onSelect: () => {}, onCancel: () => {}, now: () => NOW },
			);
			const out = lines(selector, width);
			assert.ok(
				out.some((line) => line.trim() === "Search prompts"),
				out.join("\n"),
			);
			assert.ok(out.some((line) => line.includes("⌕ Filter prompts…")));
			const first = out.find((line) => line.includes("❯ ship it"));
			assert.ok(first?.endsWith("2m ago"), out.join("\n"));
			assert.ok(out.some((line) => line.includes("fix the login bug and the redirect") && line.endsWith("30m ago")));
			assert.ok(out.some((line) => line.trim() === "typed before a restart"));
			assert.equal(out.at(-2)?.trim(), "↑↓ select · enter use · type to search · esc cancel");
			assert.ok(out.every((line) => line.length <= width));
		});
	}

	it("typing filters, enter hands back the whole prompt, and esc clears a search before it cancels", () => {
		const chosen: string[] = [];
		let cancelled = 0;
		const selector = new PromptHistorySelectorComponent(
			[{ text: "ship it" }, { text: "fix the login bug\nand the redirect" }],
			{ onSelect: (text) => chosen.push(text), onCancel: () => cancelled++, now: () => NOW },
		);
		for (const ch of "redirect") selector.handleInput(ch);
		assert.ok(lines(selector, 100).some((line) => line.includes("❯ fix the login bug and the redirect")));
		selector.handleInput("\x1b");
		assert.equal(cancelled, 0);
		const cleared = lines(selector, 100);
		assert.ok(cleared.some((line) => line.includes("❯ fix the login bug and the redirect")));
		assert.ok(cleared.some((line) => line.trim() === "ship it"));
		selector.handleInput("\x1b");
		assert.equal(cancelled, 1);
		const again = new PromptHistorySelectorComponent([{ text: "fix the login bug\nand the redirect" }], {
			onSelect: (text) => chosen.push(text),
			onCancel: () => {},
		});
		again.handleInput("\r");
		assert.deepEqual(chosen, ["fix the login bug\nand the redirect"]);
	});

	it("says there are no prompts yet when there are none", () => {
		const selector = new PromptHistorySelectorComponent([], { onSelect: () => {}, onCancel: () => {} });
		assert.ok(lines(selector, 80).some((line) => line.trim() === "No prompts yet"));
	});

	it("ctrl+r puts the chosen prompt in the composer without sending it, and esc leaves the draft alone", () => {
		let shown: Component | undefined;
		let closed = 0;
		const editor = {
			text: "my draft",
			getHistory: () => ["ship it", "fix the login bug"],
			setText(text: string) {
				this.text = text;
			},
		};
		let sent = 0;
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			editor,
			runtimeHost: {
				session: {
					sessionManager: {
						getEntries: () => [
							{
								type: "message",
								id: "u1",
								parentId: null,
								timestamp: new Date(Date.now() - 4 * 60_000 - 5_000).toISOString(),
								message: { role: "user", content: [{ type: "text", text: "fix the login bug" }] },
							},
							{
								type: "message",
								id: "a1",
								parentId: "u1",
								timestamp: new Date(Date.now() - 3 * 60_000).toISOString(),
								message: { role: "assistant", content: [{ type: "text", text: "done" }] },
							},
						],
					},
					prompt: () => sent++,
				},
			},
			ui: { requestRender: () => {} },
			showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
				shown = create(() => closed++).component;
			},
		}) as InteractiveMode;

		mode.showPromptHistorySearch();
		assert.ok(shown);
		const out = lines(shown, 100);
		assert.ok(out.some((line) => line.includes("❯ ship it")));
		assert.ok(out.some((line) => line.includes("fix the login bug") && line.endsWith("4m ago")));
		shown.handleInput?.("\x1b[B");
		shown.handleInput?.("\r");
		assert.equal(editor.text, "fix the login bug");
		assert.equal(closed, 1);
		assert.equal(sent, 0);

		editor.text = "my draft";
		mode.showPromptHistorySearch();
		shown.handleInput?.("\x1b");
		assert.equal(editor.text, "my draft");
		assert.equal(closed, 2);
	});

	it("binds ctrl+r to the search by default", () => {
		assert.deepEqual(new KeybindingsManager().getKeys("app.history.search"), ["ctrl+r"]);
	});
});
