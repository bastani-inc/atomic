import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	getKeybindings,
	type Keybinding,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@bastani/atomic-tui";
import { theme } from "../theme/theme.js";
import { formatKeyText } from "./keybinding-hints.js";
import type { TreeList } from "./tree-selector-list.ts";

/** The search box: the same rounded box with a ⌕ prompt every picker uses, showing the typed query. */
export class SearchLine implements Component, Focusable {
	focused = false;
	private readonly treeList: TreeList;

	constructor(treeList: TreeList) {
		this.treeList = treeList;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [""];
		const query = this.treeList.getSearchQuery();
		const boxWidth = Math.max(8, width - 2);
		const field = Math.max(1, boxWidth - 4);
		const prompt = theme.fg("text", "⌕ ");
		const cursor = this.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[27m` : "";
		// The end of a long query stays in view, so the cursor after it is never cut off.
		const room = Math.max(1, field - 2 - (this.focused ? 1 : 0));
		const shown =
			visibleWidth(query) > room ? `…${sliceByColumn(query, visibleWidth(query) - room + 1, room - 1)}` : query;
		const text = query ? theme.fg("text", shown) : this.focused ? "" : theme.fg("dim", "Search…");
		const placeholder = !query && this.focused ? theme.fg("dim", "Search…") : "";
		const content = query
			? `${prompt}${text}${cursor}`
			: truncateToWidth(`${prompt}${text}${cursor}${placeholder}`, field, "");
		const pad = " ".repeat(Math.max(0, field - visibleWidth(content)));
		const border = (value: string) => theme.fg(query ? "muted" : "borderMuted", value);
		return [
			` ${border(`╭${"─".repeat(boxWidth - 2)}╮`)}`,
			` ${border("│ ")}${content}${pad}${border(" │")}`,
			` ${border(`╰${"─".repeat(boxWidth - 2)}╯`)}`,
		];
	}

	handleInput(_keyData: string): boolean {
		return false;
	}
}

/**
 * The one hint line under the tree: its keys in order, the least needed dropped first on a narrow terminal so how to
 * move, go to an entry and leave stay longest.
 */
export class TreeHelp implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		const items = TREE_HELP_ITEMS.map(({ keys, label, labelFirst, drop }) => {
			const text = formatHelpKeys(keys);
			return { text: !text ? label : labelFirst ? `${label} ${text}` : `${text} ${label}`, drop };
		});
		const room = Math.max(1, width - 2);
		const kept = [...items];
		const line = () => kept.map((item) => item.text).join(" · ");
		const byDrop = [...items].filter((item) => item.drop !== undefined).sort((a, b) => (a.drop ?? 0) - (b.drop ?? 0));
		for (const item of byDrop) {
			if (visibleWidth(line()) <= room) break;
			kept.splice(kept.indexOf(item), 1);
		}
		return [theme.fg("dim", truncateToWidth(`  ${line()}`, width, "…"))];
	}
}

/** `drop` orders what a narrow line gives up first (lowest first); entries without it always stay. */
const TREE_HELP_ITEMS: Array<{ keys: Keybinding[]; label: string; labelFirst?: boolean; drop?: number }> = [
	{ keys: ["tui.select.up", "tui.select.down"], label: "move" },
	{ keys: ["tui.select.confirm"], label: "go here" },
	{ keys: ["tui.editor.cursorLeft", "tui.editor.cursorRight"], label: "page", drop: 3 },
	{ keys: ["app.tree.foldOrUp", "app.tree.unfoldOrDown"], label: "branch", drop: 5 },
	{ keys: ["app.tree.editLabel"], label: "label", drop: 4 },
	{ keys: ["app.tree.toggleLabelTimestamp"], label: "label time", drop: 1 },
	{
		keys: [
			"app.tree.filter.default",
			"app.tree.filter.noTools",
			"app.tree.filter.userOnly",
			"app.tree.filter.labeledOnly",
			"app.tree.filter.all",
		],
		label: "filters",
		labelFirst: true,
		drop: 0,
	},
	{ keys: ["app.tree.filter.cycleForward", "app.tree.filter.cycleBackward"], label: "filter", drop: 2 },
	{ keys: ["tui.select.cancel"], label: "cancel" },
];

function formatHelpKeys(keybindings: Keybinding[]): string {
	const keys: string[] = [];
	for (const keybinding of keybindings) {
		const key = getKeybindings().getKeys(keybinding)[0];
		if (key !== undefined) keys.push(key);
	}
	if (keys.length === 0) return "";

	return formatKeyText(compactRawKeys(keys))
		.replace(/\bpageup\b/g, "pgup")
		.replace(/\bpagedown\b/g, "pgdn")
		.replace(/\bup\b/g, "↑")
		.replace(/\bdown\b/g, "↓")
		.replace(/\bleft\b/g, "←")
		.replace(/\bright\b/g, "→")
		.replace("↑/↓", "↑↓")
		.replace("←/→", "←→");
}

function compactRawKeys(keys: string[]): string {
	if (keys.length === 1) return keys[0]!;

	const parts = keys.map((key) => {
		const separatorIndex = key.lastIndexOf("+");
		return separatorIndex === -1
			? { prefix: "", suffix: key }
			: { prefix: key.slice(0, separatorIndex + 1), suffix: key.slice(separatorIndex + 1) };
	});
	const prefix = parts[0]!.prefix;
	return prefix && parts.every((part) => part.prefix === prefix)
		? `${prefix}${parts.map((part) => part.suffix).join("/")}`
		: keys.join("/");
}
