import {
	type Component,
	CURSOR_MARKER,
	clickableKeysHint,
	type Focusable,
	getKeybindings,
	type HintKeyPart,
	type Keybinding,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@bastani/atomic-tui";
import { theme } from "../theme/theme.js";
import { formatKeyText } from "./keybinding-hints.js";
import type { TreeList } from "./tree-selector-list.ts";

/** Component that displays the current search query */
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
		].map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
	}

	handleInput(_keyData: string): boolean {
		return false;
	}
}

/** Component that renders tree help as semantic rows with chunk-aware wrapping */
export class TreeHelp implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		const items = TREE_HELP_ITEMS.map(({ keys, label, labelFirst, drop }) => {
			const parts = helpKeyParts(keys);
			const text = parts.map((part) => part.text).join("");
			return {
				text: !text ? label : labelFirst ? `${label} ${text}` : `${text} ${label}`,
				hint: !text
					? label
					: labelFirst
						? `${label} ${clickableKeysHint(parts)}`
						: clickableKeysHint(parts, ` ${label}`),
				drop,
			};
		});
		const room = Math.max(1, width - 2);
		const kept = [...items];
		const line = () => kept.map((item) => item.text).join(" · ");
		const byDrop = [...items].filter((item) => item.drop !== undefined).sort((a, b) => (a.drop ?? 0) - (b.drop ?? 0));
		for (const item of byDrop) {
			if (visibleWidth(line()) <= room) break;
			kept.splice(kept.indexOf(item), 1);
		}
		return [theme.fg("dim", truncateToWidth(`  ${kept.map((item) => item.hint).join(" · ")}`, width, "…"))];
	}
}

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

/** Compact shared modifiers and paired arrows without losing the key ID of any visible segment. */
function helpKeyParts(keybindings: Keybinding[]): HintKeyPart[] {
	const keys = keybindings.flatMap((keybinding) => getKeybindings().getKeys(keybinding).slice(0, 1));
	const modifiers = keys.map((key) => /^(?:(?:ctrl|alt|shift|super)\+)+/i.exec(key)?.[0] ?? "");
	const prefix = modifiers.every((part) => part === modifiers[0]) ? modifiers[0] : undefined;
	const labels = keys.map((key, index) =>
		formatKeyText(prefix && index > 0 ? key.slice(prefix.length) : key)
			.replace(/\bpageup\b/g, "pgup")
			.replace(/\bpagedown\b/g, "pgdn")
			.replace(/\bup\b/g, "↑")
			.replace(/\bdown\b/g, "↓")
			.replace(/\bleft\b/g, "←")
			.replace(/\bright\b/g, "→"),
	);
	return keys.map((key, index) => {
		const label = labels[index]!;
		const next = labels[index + 1];
		const paired = (label.endsWith("↑") && next === "↓") || (label.endsWith("←") && next === "→");
		return { text: label + (next && !paired ? "/" : ""), key };
	});
}
