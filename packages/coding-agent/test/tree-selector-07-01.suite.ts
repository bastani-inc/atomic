import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionEntry, SessionMessageEntry, SessionTreeNode } from "../src/core/session-manager.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { SearchLine } from "../src/modes/interactive/components/tree-selector-help.ts";
import type { TreeList } from "../src/modes/interactive/components/tree-selector-list.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

function userMessage(id: string, parentId: string | null, content: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

// Helper to build a tree from entries using parentId relationships
function buildTree(entries: Array<SessionEntry>): SessionTreeNode[] {
	if (entries.length === 0) return [];

	const nodes: SessionTreeNode[] = entries.map((entry) => ({
		entry,
		children: [],
	}));

	const byId = new Map<string, SessionTreeNode>();
	for (const node of nodes) {
		byId.set(node.entry.id, node);
	}

	const roots: SessionTreeNode[] = [];
	for (const node of nodes) {
		if (node.entry.parentId === null) {
			roots.push(node);
		} else {
			const parent = byId.get(node.entry.parentId);
			if (parent) {
				parent.children.push(node);
			}
		}
	}
	return roots;
}

function searchLine(query: string): SearchLine {
	return new SearchLine({ getSearchQuery: () => query } as TreeList);
}

describe("SearchLine", () => {
	test("renders the typed query after its prompt", () => {
		assert.deepEqual(searchLine("abc").render(80).map(stripVTControlCharacters), ["  Type to search: abc"]);
	});

	test("renders the bare prompt while the query is empty", () => {
		assert.deepEqual(searchLine("").render(80).map(stripVTControlCharacters), ["  Type to search: "]);
	});

	test("truncates the line to the available width", () => {
		const lines = searchLine("a long search query").render(12);

		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]!) <= 12);
		assert.ok(stripVTControlCharacters(lines[0]!).startsWith("  Type to"));
	});

	test("renders one empty line, without a cursor, when there is no width", () => {
		const line = searchLine("abc");
		assert.deepEqual(line.render(0), [""]);

		line.focused = true;
		assert.deepEqual(line.render(0), [""]);
	});
});

describe("TreeSelectorComponent", () => {
	describe("search cursor (pi #9157)", () => {
		test("renders the cursor only while the selector is focused", () => {
			const tree = buildTree([userMessage("user-1", null, "hello")]);
			const selector = new TreeSelectorComponent(
				tree,
				"user-1",
				24,
				() => {},
				() => {},
			);

			assert.ok(!selector.render(80).join("\n").includes(CURSOR_MARKER));

			selector.focused = true;
			const focusedLines = selector.render(80);
			const cursorLines = focusedLines.filter((line) => line.includes(CURSOR_MARKER));
			assert.equal(cursorLines.length, 1);
			assert.equal(stripVTControlCharacters(cursorLines[0]!.replace(CURSOR_MARKER, "")), "  Type to search:  ");
			assert.ok(cursorLines[0]!.includes(`${CURSOR_MARKER}\x1b[7m \x1b[27m`));

			selector.focused = false;
			assert.ok(!selector.render(80).join("\n").includes(CURSOR_MARKER));
		});

		test("moves focus to the label input and restores it after cancellation", () => {
			const tree = buildTree([userMessage("user-1", null, "hello")]);
			const selector = new TreeSelectorComponent(
				tree,
				"user-1",
				24,
				() => {},
				() => {},
			);
			selector.focused = true;

			selector.handleInput("L");
			let rendered = selector.render(80);
			let cursorLineIndex = rendered.findIndex((line) => line.includes(CURSOR_MARKER));
			assert.ok(cursorLineIndex > 0);
			assert.ok(stripVTControlCharacters(rendered[cursorLineIndex - 1]!).includes("Label (empty to remove):"));
			assert.equal(rendered.filter((line) => line.includes(CURSOR_MARKER)).length, 1);

			selector.handleInput("\x1b");
			rendered = selector.render(80);
			cursorLineIndex = rendered.findIndex((line) => line.includes(CURSOR_MARKER));
			assert.ok(stripVTControlCharacters(rendered[cursorLineIndex]!).includes("Type to search:"));
			assert.equal(rendered.filter((line) => line.includes(CURSOR_MARKER)).length, 1);
		});

		test("keeps the cursor within narrow terminal widths", () => {
			const tree = buildTree([userMessage("user-1", null, "hello")]);
			const selector = new TreeSelectorComponent(
				tree,
				"user-1",
				24,
				() => {},
				() => {},
			);
			selector.focused = true;
			selector.handleInput("a long search query");

			const cursorLine = selector.render(10).find((line) => line.includes(CURSOR_MARKER));
			assert.ok(cursorLine !== undefined);
			assert.ok(visibleWidth(cursorLine) <= 10);
		});
	});
});
