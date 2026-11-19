/**
 * One left click runs a row of the session picker (/resume) and the session tree navigator (/tree) as moving there and
 * pressing Enter would, driven through Atomic's fullscreen renderer with SGR mouse reports.
 */
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type {
	SessionInfo,
	SessionMessageEntry,
	SessionTreeNode,
} from "../../packages/coding-agent/src/core/session-manager.js";
import { SessionSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/session-selector.js";
import { TreeSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/tree-selector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { flushClicks, makeClickScreen } from "../helpers/fullscreen-clicks.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

function session(id: string, name: string, modified: number): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "",
		name,
		created: new Date(modified),
		modified: new Date(modified),
		messageCount: 3,
		firstMessage: name,
		allMessagesText: name,
	};
}

async function picker(width: number) {
	const ui = makeClickScreen(width);
	const resumed: string[] = [];
	const sessions = [
		session("a", "Fix the login page", 3_000),
		session("b", "Write the release notes", 2_000),
		session("c", "Port the parser", 1_000),
	];
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => sessions,
		(info) => resumed.push(info.id),
		() => {},
		() => {},
		() => ui.tui.requestRender(),
		{ keybindings: new KeybindingsManager(), deleteSession: async () => {} },
	);
	await flushClicks();
	ui.dock(selector);
	return { ui, resumed, selector };
}

for (const width of [80, 160]) {
	test(`a click on a session in /resume resumes it, title or detail line, at ${width} columns`, async () => {
		const { ui, resumed } = await picker(width);
		await ui.click(/Write the release notes/, "release notes");
		assert.deepEqual(resumed, ["b"]);

		const title = ui.rowOf(/Port the parser/);
		await ui.clickAt(10, title + 1);
		assert.deepEqual(resumed, ["b", "c"]);
		ui.tui.stop();
	});
}

test("a double-click on a session in /resume resumes it once", async () => {
	const { ui, resumed } = await picker(100);
	await ui.doubleClick(/Port the parser/, "parser");
	assert.deepEqual(resumed, ["c"]);
	ui.tui.stop();
});

test("while /resume waits to confirm a delete, a click on a session resumes nothing", async () => {
	const { ui, resumed, selector } = await picker(100);
	selector.handleInput("\x04");
	ui.tui.renderNow();
	assert.ok(
		ui.screen().some((line) => /delete/i.test(line)),
		ui.screen().join("\n"),
	);
	await ui.click(/Port the parser/, "parser");
	assert.deepEqual(resumed, []);
	ui.tui.stop();
});

test("scrolling over /resume keeps the selected session (#5532)", async () => {
	const { ui, selector } = await picker(100);
	const row = ui.rowOf(/Fix the login page/);
	await ui.wheel("down", 6, row);
	await ui.wheel("down", 6, row);
	assert.equal(selector.getSessionList().getSelectedSessionId(), "a");
	ui.tui.stop();
});

/** A session tree with one entry after another. */
function linearTree(length: number): { roots: SessionTreeNode[]; leafId: string } {
	const nodes: SessionTreeNode[] = [];
	let parentId: string | null = null;
	for (let index = 0; index < length; index += 1) {
		const id = `entry-${index}`;
		const entry: SessionMessageEntry = {
			type: "message",
			id,
			parentId,
			timestamp: new Date(index * 1000).toISOString(),
			message: { role: "user", content: `question number ${index}`, timestamp: index * 1000 },
		};
		const node: SessionTreeNode = { entry, children: [] };
		if (nodes.length > 0) nodes[nodes.length - 1]!.children.push(node);
		nodes.push(node);
		parentId = id;
	}
	return { roots: nodes.length > 0 ? [nodes[0]!] : [], leafId: nodes.at(-1)?.entry.id ?? "" };
}

for (const width of [80, 160]) {
	test(`a click on an entry in the session tree goes to it, as enter on it does, at ${width} columns`, async () => {
		const ui = makeClickScreen(width);
		const { roots, leafId } = linearTree(6);
		const chosen: string[] = [];
		const tree = new TreeSelectorComponent(
			roots,
			leafId,
			ui.terminal.rows,
			(entryId) => chosen.push(entryId),
			() => {},
		);
		ui.dock(tree);
		await ui.click(/question number 2/, "question number 2");
		assert.deepEqual(chosen, ["entry-2"]);
		await ui.doubleClick(/question number 4/, "question number 4");
		assert.deepEqual(chosen, ["entry-2", "entry-4"]);
		const row = ui.rowOf(/question number 0/);
		await ui.wheel("down", 6, row);
		assert.equal(tree.getTreeList().getSelectedNode()?.entry.id, "entry-4");
		ui.tui.stop();
	});
}
