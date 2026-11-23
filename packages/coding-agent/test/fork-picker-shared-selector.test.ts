import assert from "node:assert/strict";
import { setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const messages = [
	{ id: "e1", text: "fix the login bug" },
	{ id: "e2", text: "now add a test for the\nredirect loop" },
	{ id: "e3", text: "ship it" },
];

function lines(selector: UserMessageSelectorComponent, width = 100): string[] {
	return selector.render(width).map((line) => stripTerminalSequences(line).replace(/\s+$/, ""));
}

describe("fork picker on the shared selector (#5224)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("lists messages as two-line rows, newest selected, with a search box and one hint line", () => {
		const selector = new UserMessageSelectorComponent(
			messages,
			() => {},
			() => {},
		);
		const out = lines(selector);
		assert.ok(
			out.some((line) => line.trim() === "Fork from message"),
			out.join("\n"),
		);
		assert.ok(
			out.some((line) => line.includes("⌕")),
			out.join("\n"),
		);
		const selected = out.findIndex((line) => line.includes("∀ ship it"));
		assert.ok(selected >= 0, out.join("\n"));
		assert.equal(out[selected + 1]?.trim(), "message 3 of 3");
		assert.ok(out.some((line) => line.includes("now add a test for the redirect loop")));
		assert.ok(
			out.some((line) => line.includes("enter fork") && line.includes("esc cancel")),
			out.join("\n"),
		);
	});

	it("starts on the message it was opened at, and typing filters only the message text (#5256)", () => {
		const chosen: string[] = [];
		const selector = new UserMessageSelectorComponent(
			messages,
			(id) => chosen.push(id),
			() => {},
			"e1",
		);
		assert.ok(lines(selector).some((line) => line.includes("∀ fix the login bug")));
		for (const ch of "redirect") selector.handleInput(ch);
		selector.handleInput("\r");
		assert.deepEqual(chosen, ["e2"]);

		const byPosition = new UserMessageSelectorComponent(
			messages,
			() => {},
			() => {},
		);
		for (const ch of "message 2 of 3") byPosition.handleInput(ch);
		assert.ok(
			lines(byPosition).some((line) => line.includes('No matches for "message 2 of 3"')),
			lines(byPosition).join("\n"),
		);
	});

	it("honors reassigned onSelect and onCancel callbacks on the component and getMessageList() (#5256)", () => {
		const selector = new UserMessageSelectorComponent(
			messages,
			() => {},
			() => {},
		);
		const picked: string[] = [];
		let cancelled = 0;
		selector.getMessageList().onSelect = (id) => picked.push(id);
		selector.getMessageList().onCancel = () => cancelled++;
		selector.handleInput("\r");
		assert.deepEqual(picked, ["e3"]);

		const cancelSelector = new UserMessageSelectorComponent(
			messages,
			() => {},
			() => {},
		);
		cancelSelector.onCancel = () => cancelled++;
		cancelSelector.handleInput("\x1b");
		assert.equal(cancelled, 1);
	});

	it("esc clears a search before it cancels", () => {
		let cancelled = 0;
		const selector = new UserMessageSelectorComponent(
			messages,
			() => {},
			() => cancelled++,
		);
		selector.handleInput("z");
		selector.handleInput("\x1b");
		assert.equal(cancelled, 0);
		selector.handleInput("\x1b");
		assert.equal(cancelled, 1);
	});
});
