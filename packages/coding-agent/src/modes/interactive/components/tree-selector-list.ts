import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import type { SessionTreeNode } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.js";
import { formatLabelTimestamp, getEntryDisplayText } from "./tree-selector-content.ts";
import { applyTreeFilter, buildActivePath, findNearestVisibleIndex, flattenTree } from "./tree-selector-model.ts";
import type { FilterMode, HorizontalViewportRow, ToolCallInfo, TreeListState } from "./tree-selector-types.ts";
import { renderHorizontalViewport } from "./tree-selector-viewport.ts";

/** Tree list component with selection and ASCII art visualization */
export class TreeList implements Component {
	private readonly state: TreeListState;
	private filterChosen = false;

	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	public onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		maxVisibleLines: number,
		initialSelectedId?: string,
		initialFilterMode?: FilterMode,
		archive?: TreeListState["archive"],
	) {
		const toolCallMap = new Map<string, ToolCallInfo>();
		const flatNodes = flattenTree(tree, currentLeafId, toolCallMap);
		archive?.indexCalls(flatNodes);
		this.state = {
			archive,
			flatNodes,
			filteredNodes: [],
			selectedIndex: 0,
			currentLeafId,
			maxVisibleLines,
			filterMode: initialFilterMode ?? "default",
			searchQuery: "",
			toolCallMap,
			multipleRoots: tree.length > 1,
			showLabelTimestamps: false,
			activePathIds: new Set(),
			visibleParentMap: new Map(),
			visibleChildrenMap: new Map(),
			lastSelectedId: null,
			foldedNodes: new Set(),
		};

		buildActivePath(this.state.flatNodes, this.state.currentLeafId, this.state.activePathIds);
		applyTreeFilter(this.state);

		// Start with initialSelectedId if provided, otherwise current leaf
		const targetId = initialSelectedId ?? currentLeafId;
		this.state.selectedIndex = findNearestVisibleIndex(this.state.flatNodes, this.state.filteredNodes, targetId);
		this.state.lastSelectedId = this.state.filteredNodes[this.state.selectedIndex]?.node.entry.id ?? null;
	}

	invalidate(): void {}

	/** Withdraw a preliminary project default, without overwriting a filter the user selected. */
	updateInitialFilter(mode: FilterMode): void {
		if (this.filterChosen || mode === this.state.filterMode) return;
		this.state.filterMode = mode;
		applyTreeFilter(this.state);
	}

	private chooseFilter(mode: FilterMode): void {
		this.filterChosen = true;
		this.state.filterMode = mode;
		this.state.foldedNodes.clear();
		applyTreeFilter(this.state);
	}

	getSearchQuery(): string {
		return this.state.searchQuery;
	}

	getSelectedNode(): SessionTreeNode | undefined {
		return this.state.filteredNodes[this.state.selectedIndex]?.node;
	}

	updateNodeLabel(entryId: string, label: string | undefined, labelTimestamp?: string): void {
		this.state.archive?.labelChanged(entryId, label);
		for (const flatNode of this.state.flatNodes) {
			if (flatNode.node.entry.id === entryId) {
				flatNode.node.label = label;
				flatNode.node.labelTimestamp = label ? (labelTimestamp ?? new Date().toISOString()) : undefined;
				break;
			}
		}
	}

	private getStatusLabels(): string[] {
		const labels: string[] = [];
		switch (this.state.filterMode) {
			case "no-tools":
				labels.push("no tool calls");
				break;
			case "user-only":
				labels.push("your messages only");
				break;
			case "labeled-only":
				labels.push("labeled only");
				break;
			case "all":
				labels.push("everything");
				break;
		}
		if (this.state.showLabelTimestamps) labels.push("label times");
		return labels;
	}

	render(width: number): string[] {
		const state = this.state;
		const lines: string[] = [];

		if (state.filteredNodes.length === 0) {
			lines.push(truncateToWidth(theme.fg("dim", "  No entries match"), width));
			const status = this.getStatusLabels();
			if (status.length > 0) lines.push(truncateToWidth(theme.fg("dim", `  ${status.join(" · ")}`), width));
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				state.selectedIndex - Math.floor(state.maxVisibleLines / 2),
				state.filteredNodes.length - state.maxVisibleLines,
			),
		);
		const endIndex = Math.min(startIndex + state.maxVisibleLines, state.filteredNodes.length);

		state.archive?.show(
			state.filteredNodes.slice(startIndex, endIndex).map((node) => node.node.entry.id),
			width,
		);
		const renderedRows: HorizontalViewportRow[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const flatNode = state.filteredNodes[i];
			const entry = flatNode.node.entry;
			const isSelected = i === state.selectedIndex;

			// Build line: cursor + prefix + path marker + label + content
			const cursor = isSelected ? theme.fg("accent", theme.bold("❯ ")) : "  ";

			// If multiple roots, shift display (roots at 0, not 1)
			const displayIndent = state.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;

			// Build prefix with gutters at their correct positions
			// Each gutter has a position (displayIndent where its connector was shown)
			const connector =
				flatNode.showConnector && !flatNode.isVirtualRootChild ? (flatNode.isLast ? "└─ " : "├─ ") : "";
			const connectorPosition = connector ? displayIndent - 1 : -1;

			// Build prefix char by char, placing gutters and connector at their positions
			const totalChars = displayIndent * 3;
			const prefixChars: string[] = [];
			const isFolded = state.foldedNodes.has(entry.id);
			for (let i = 0; i < totalChars; i++) {
				const level = Math.floor(i / 3);
				const posInLevel = i % 3;

				// Check if there's a gutter at this level
				const gutter = flatNode.gutters.find((g) => g.position === level);
				if (gutter) {
					if (posInLevel === 0) {
						prefixChars.push(gutter.show ? "│" : " ");
					} else {
						prefixChars.push(" ");
					}
				} else if (connector && level === connectorPosition) {
					// Connector at this level, with fold indicator
					if (posInLevel === 0) {
						prefixChars.push(flatNode.isLast ? "└" : "├");
					} else if (posInLevel === 1) {
						const foldable = this.isFoldable(entry.id);
						prefixChars.push(isFolded ? "⊞" : foldable ? "⊟" : "─");
					} else {
						prefixChars.push(" ");
					}
				} else {
					prefixChars.push(" ");
				}
			}
			const prefix = prefixChars.join("");

			// Fold marker for nodes without connectors (roots)
			const showsFoldInConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
			const foldMarker = isFolded && !showsFoldInConnector ? theme.fg("accent", "⊞ ") : "";

			// Active path marker - shown right before the entry text
			const isOnActivePath = state.activePathIds.has(entry.id);
			const pathMarker = isOnActivePath ? theme.fg("accent", "• ") : "";

			const preview = state.archive?.peek(entry.id);
			const labelText = preview?.label ?? flatNode.node.label;
			const label = labelText ? theme.fg("warning", `[${labelText}] `) : "";
			const labelTimestamp =
				state.showLabelTimestamps && flatNode.node.label && flatNode.node.labelTimestamp
					? theme.fg("muted", `${formatLabelTimestamp(flatNode.node.labelTimestamp)} `)
					: "";
			const content = !state.archive
				? getEntryDisplayText(flatNode.node, isSelected, state.toolCallMap)
				: preview
					? getEntryDisplayText(
							{ ...flatNode.node, entry: preview.entry },
							isSelected,
							new Map(preview.call ? [preview.call] : []),
						)
					: theme.fg(
							"dim",
							`[${state.archive.rows.get(entry.id)?.role ?? state.archive.rows.get(entry.id)?.type ?? "entry"}]`,
						);
			const prefixPart = theme.fg("dim", prefix) + foldMarker + pathMarker;
			const anchorCol = visibleWidth(prefixPart);
			let gutter = cursor;
			let body = prefixPart + label + labelTimestamp + content;
			if (isSelected) {
				gutter = theme.bg("selectedBg", gutter);
				body = theme.bg("selectedBg", body);
			}
			renderedRows.push({ gutter, body, anchorCol, bodyWidth: visibleWidth(body), isSelected });
		}

		lines.push(...renderHorizontalViewport(renderedRows, width));
		const above = startIndex;
		const below = state.filteredNodes.length - endIndex;
		const footer = [
			above > 0 ? `↑ ${above} more` : "",
			below > 0 ? `↓ ${below} more` : "",
			...this.getStatusLabels(),
		].filter(Boolean);
		if (footer.length > 0) lines.push(truncateToWidth(theme.fg("dim", `  ${footer.join(" · ")}`), width));

		return lines;
	}

	handleInput(keyData: string): boolean {
		const state = this.state;
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			state.selectedIndex = state.selectedIndex === 0 ? state.filteredNodes.length - 1 : state.selectedIndex - 1;
		} else if (kb.matches(keyData, "tui.select.down")) {
			state.selectedIndex = state.selectedIndex === state.filteredNodes.length - 1 ? 0 : state.selectedIndex + 1;
		} else if (kb.matches(keyData, "app.tree.foldOrUp")) {
			const currentId = state.filteredNodes[state.selectedIndex]?.node.entry.id;
			if (currentId && this.isFoldable(currentId) && !state.foldedNodes.has(currentId)) {
				state.foldedNodes.add(currentId);
				applyTreeFilter(state);
			} else {
				state.selectedIndex = this.findBranchSegmentStart("up");
			}
		} else if (kb.matches(keyData, "app.tree.unfoldOrDown")) {
			const currentId = state.filteredNodes[state.selectedIndex]?.node.entry.id;
			if (currentId && state.foldedNodes.has(currentId)) {
				state.foldedNodes.delete(currentId);
				applyTreeFilter(state);
			} else {
				state.selectedIndex = this.findBranchSegmentStart("down");
			}
		} else if (kb.matches(keyData, "tui.editor.cursorLeft") || kb.matches(keyData, "tui.select.pageUp")) {
			// Page up
			state.selectedIndex = Math.max(0, state.selectedIndex - state.maxVisibleLines);
		} else if (kb.matches(keyData, "tui.editor.cursorRight") || kb.matches(keyData, "tui.select.pageDown")) {
			// Page down
			state.selectedIndex = Math.min(state.filteredNodes.length - 1, state.selectedIndex + state.maxVisibleLines);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = state.filteredNodes[state.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.node.entry.id);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			if (state.searchQuery) {
				state.searchQuery = "";
				state.foldedNodes.clear();
				applyTreeFilter(state);
			} else {
				this.onCancel?.();
			}
		} else if (kb.matches(keyData, "app.tree.filter.default")) {
			// Direct filter: default
			this.chooseFilter("default");
		} else if (kb.matches(keyData, "app.tree.filter.noTools")) {
			// Toggle filter: no-tools ↔ default
			this.chooseFilter(state.filterMode === "no-tools" ? "default" : "no-tools");
		} else if (kb.matches(keyData, "app.tree.filter.userOnly")) {
			// Toggle filter: user-only ↔ default
			this.chooseFilter(state.filterMode === "user-only" ? "default" : "user-only");
		} else if (kb.matches(keyData, "app.tree.filter.labeledOnly")) {
			// Toggle filter: labeled-only ↔ default
			this.chooseFilter(state.filterMode === "labeled-only" ? "default" : "labeled-only");
		} else if (kb.matches(keyData, "app.tree.filter.all")) {
			// Toggle filter: all ↔ default
			this.chooseFilter(state.filterMode === "all" ? "default" : "all");
		} else if (kb.matches(keyData, "app.tree.filter.cycleBackward")) {
			// Cycle filter backwards
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(state.filterMode);
			this.chooseFilter(modes[(currentIndex - 1 + modes.length) % modes.length]!);
		} else if (kb.matches(keyData, "app.tree.filter.cycleForward")) {
			// Cycle filter forwards: default → no-tools → user-only → labeled-only → all → default
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(state.filterMode);
			this.chooseFilter(modes[(currentIndex + 1) % modes.length]!);
		} else if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			if (state.searchQuery.length > 0) {
				state.searchQuery = state.searchQuery.slice(0, -1);
				state.foldedNodes.clear();
				applyTreeFilter(state);
			}
		} else if (kb.matches(keyData, "app.tree.editLabel")) {
			const selected = state.filteredNodes[state.selectedIndex];
			if (selected && this.onLabelEdit) {
				this.onLabelEdit(selected.node.entry.id, selected.node.label);
			}
		} else if (kb.matches(keyData, "app.tree.toggleLabelTimestamp")) {
			state.showLabelTimestamps = !state.showLabelTimestamps;
		} else {
			const hasControlChars = [...keyData].some((ch) => {
				const code = ch.charCodeAt(0);
				return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
			});
			if (!hasControlChars && keyData.length > 0) {
				state.searchQuery += keyData;
				state.foldedNodes.clear();
				applyTreeFilter(state);
				return true;
			}
			return false;
		}
		return true;
	}

	/**
	 * Whether a node can be folded. A node is foldable if it has visible children
	 * and is either a root (no visible parent) or a segment start (visible parent
	 * has multiple visible children).
	 */
	private isFoldable(entryId: string): boolean {
		const children = this.state.visibleChildrenMap.get(entryId);
		if (!children || children.length === 0) return false;
		const parentId = this.state.visibleParentMap.get(entryId);
		if (parentId === null || parentId === undefined) return true;
		const siblings = this.state.visibleChildrenMap.get(parentId);
		return siblings !== undefined && siblings.length > 1;
	}

	/**
	 * Find the index of the next branch segment start in the given direction.
	 * A segment start is the first child of a branch point.
	 *
	 * "up" walks the visible parent chain; "down" walks visible children
	 * (always following the first child).
	 */
	private findBranchSegmentStart(direction: "up" | "down"): number {
		const selectedId = this.state.filteredNodes[this.state.selectedIndex]?.node.entry.id;
		if (!selectedId) return this.state.selectedIndex;

		const indexByEntryId = new Map(this.state.filteredNodes.map((node, i) => [node.node.entry.id, i]));
		let currentId: string = selectedId;
		if (direction === "down") {
			while (true) {
				const children: string[] = this.state.visibleChildrenMap.get(currentId) ?? [];
				if (children.length === 0) return indexByEntryId.get(currentId)!;
				if (children.length > 1) return indexByEntryId.get(children[0])!;
				currentId = children[0];
			}
		}

		// direction === "up"
		while (true) {
			const parentId: string | null = this.state.visibleParentMap.get(currentId) ?? null;
			if (parentId === null) return indexByEntryId.get(currentId)!;
			const children = this.state.visibleChildrenMap.get(parentId) ?? [];
			if (children.length > 1) {
				const segmentStart = indexByEntryId.get(currentId)!;
				if (segmentStart < this.state.selectedIndex) {
					return segmentStart;
				}
			}
			currentId = parentId;
		}
	}
}
