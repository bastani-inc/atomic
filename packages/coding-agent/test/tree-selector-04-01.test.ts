import { stripVTControlCharacters } from "node:util";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type {
	ModelChangeEntry,
	SessionEntry,
	SessionMessageEntry,
	SessionTreeNode,
} from "../src/core/session-manager.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	// Ensure test isolation: keybindings are a global singleton
	setKeybindings(new KeybindingsManager());
});

// Helper to create a user message entry
function userMessage(id: string, parentId: string | null, content: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

// Helper to create an assistant message entry
function assistantMessage(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
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
		},
	};
}

// Helper to create a tool-call-only assistant message (filtered out in default mode)
function toolCallOnlyAssistant(id: string, parentId: string | null): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `tc-${id}`, name: "read", arguments: { path: "test.ts" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		},
	};
}

// Helper to create a model_change entry
function modelChange(id: string, parentId: string | null): ModelChangeEntry {
	return {
		type: "model_change",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		provider: "anthropic",
		modelId: "claude-sonnet-4",
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

describe("TreeSelectorComponent", () => {
	describe("label timestamps", () => {
		test("toggles label timestamps for labeled nodes", () => {
			const entries = [userMessage("user-1", null, "hello"), assistantMessage("asst-1", "user-1", "hi")];
			const tree = buildTree(entries);
			const labelDate = new Date(2026, 2, 28, 14, 32, 0);
			tree[0]!.label = "checkpoint";
			tree[0]!.labelTimestamp = labelDate.toISOString();

			const selector = new TreeSelectorComponent(
				tree,
				"asst-1",
				24,
				() => {},
				() => {},
			);

			const list = selector.getTreeList();
			let render = list.render(200).join("\n");
			expect(render).toContain("[checkpoint]");
			expect(render).not.toContain("3/28 14:32");
			expect(render).not.toContain("[+label time]");

			selector.handleInput("T");

			render = list.render(200).join("\n");
			expect(render).toContain("3/28 14:32");
			expect(render).toContain("[+label time]");
		});
	});
});
