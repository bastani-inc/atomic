import assert from "node:assert/strict";
import { setKeybindings, stripTerminalSequences, visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionMessageEntry, SessionTreeNode } from "../src/core/session-manager.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function user(id: string, parentId: string | null, content: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

function chain(count: number): SessionTreeNode[] {
	const nodes: SessionTreeNode[] = [];
	for (let index = 0; index < count; index++) {
		nodes.push({ entry: user(`u${index}`, index === 0 ? null : `u${index - 1}`, `message ${index}`), children: [] });
	}
	for (let index = 1; index < count; index++) nodes[index - 1]!.children.push(nodes[index]!);
	return nodes.slice(0, 1);
}

function lines(selector: TreeSelectorComponent, width = 120): string[] {
	return selector.render(width).map((line) => stripTerminalSequences(line).replace(/\s+$/, ""));
}

describe("/tree on the shared picker look (#5224)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("has a title, a search box, the ∀ marker and one hint line at the bottom", () => {
		const selector = new TreeSelectorComponent(
			chain(3),
			"u2",
			30,
			() => {},
			() => {},
		);
		const out = lines(selector);
		assert.ok(
			out.some((line) => line.trim() === "Session tree"),
			out.join("\n"),
		);
		assert.ok(
			out.some((line) => line.includes("⌕") && line.includes("Search…")),
			out.join("\n"),
		);
		assert.ok(
			out.some((line) => /∀ .*message 2/.test(line)),
			out.join("\n"),
		);
		const hint = out.at(-2)!;
		assert.ok(hint.includes("↑↓ move") && hint.includes("enter go here") && hint.includes("esc cancel"), hint);
		assert.equal(out.filter((line) => line.includes("↑↓ move")).length, 1, "one hint line");
	});

	it("says which view is filtered in words, and how many rows are hidden above and below", () => {
		const selector = new TreeSelectorComponent(
			chain(40),
			"u39",
			20,
			() => {},
			() => {},
		);
		const list = selector.getTreeList();
		let footer = stripTerminalSequences(list.render(120).at(-1) ?? "").trim();
		assert.match(footer, /^↑ \d+ more$/);
		assert.ok(!/\(\d+\/\d+\)/.test(footer), footer);
		selector.handleInput("T");
		footer = stripTerminalSequences(list.render(120).at(-1) ?? "").trim();
		assert.match(footer, /↑ \d+ more · label times$/);
	});

	it("keeps search boxes inside the terminal after a narrow resize (#5256)", () => {
		const selector = new TreeSelectorComponent(
			chain(3),
			"u2",
			30,
			() => {},
			() => {},
		);
		selector.focused = true;
		for (const query of ["", "message 1"]) {
			for (const key of query) selector.handleInput(key);
			for (const width of [1, 2, 8, 10, 20, 40]) {
				for (const line of selector.render(width)) {
					assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
				}
			}
		}
	});

	it("the search box shows what was typed", () => {
		const selector = new TreeSelectorComponent(
			chain(3),
			"u2",
			30,
			() => {},
			() => {},
		);
		for (const ch of "message 1") selector.handleInput(ch);
		assert.ok(lines(selector).some((line) => line.includes("⌕ message 1")));
	});
});
