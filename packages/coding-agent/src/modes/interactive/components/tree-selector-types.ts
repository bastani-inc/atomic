import type { SessionTreeNode } from "../../../core/session-manager.ts";

/** Gutter info: position (displayIndent where connector was) and whether to show │ */
export interface GutterInfo {
	position: number; // displayIndent level where the connector was shown
	show: boolean; // true = show │, false = show spaces
}

/** Flattened tree node for navigation */
export interface FlatNode {
	node: SessionTreeNode;
	/** Indentation level (each level = 3 chars) */
	indent: number;
	/** Whether to show connector (├─ or └─) - true if parent has multiple children */
	showConnector: boolean;
	/** If showConnector, true = last sibling (└─), false = not last (├─) */
	isLast: boolean;
	/** Gutter info for each ancestor branch point */
	gutters: GutterInfo[];
	/** True if this node is a root under a virtual branching root (multiple roots) */
	isVirtualRootChild: boolean;
}

export interface HorizontalViewportRow {
	gutter: string;
	body: string;
	anchorCol: number;
	bodyWidth: number;
	isSelected: boolean;
}

export const TREE_GUTTER_WIDTH = 2;
export const MIN_VISIBLE_ANCHOR_CONTENT_WIDTH = 4;
export const MAX_VISIBLE_ANCHOR_CONTENT_WIDTH = 20;
export const MIN_ANCHOR_CONTEXT_WIDTH = 2;
export const MAX_ANCHOR_CONTEXT_WIDTH = 12;

/** Filter mode for tree display */
export type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

/** Tool call info for lookup */
export interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

export interface TreeListState {
	flatNodes: FlatNode[];
	filteredNodes: FlatNode[];
	selectedIndex: number;
	currentLeafId: string | null;
	maxVisibleLines: number;
	filterMode: FilterMode;
	searchQuery: string;
	toolCallMap: Map<string, ToolCallInfo>;
	multipleRoots: boolean;
	showLabelTimestamps: boolean;
	activePathIds: Set<string>;
	visibleParentMap: Map<string, string | null>;
	visibleChildrenMap: Map<string | null, string[]>;
	lastSelectedId: string | null;
	foldedNodes: Set<string>;
}
