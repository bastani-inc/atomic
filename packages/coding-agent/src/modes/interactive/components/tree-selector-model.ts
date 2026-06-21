import type { SessionTreeNode } from "../../../core/session-manager.ts";
import { getSearchableText, hasTextContent } from "./tree-selector-content.ts";
import type { FlatNode, GutterInfo, ToolCallInfo, TreeListState } from "./tree-selector-types.ts";

export function flattenTree(
	roots: SessionTreeNode[],
	currentLeafId: string | null,
	toolCallMap: Map<string, ToolCallInfo>,
): FlatNode[] {
	const result: FlatNode[] = [];
	toolCallMap.clear();

	// Indentation rules:
	// - At indent 0: stay at 0 unless parent has >1 children (then +1)
	// - At indent 1: children always go to indent 2 (visual grouping of subtree)
	// - At indent 2+: stay flat for single-child chains, +1 only if parent branches

	// Stack items: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
	type StackItem = [SessionTreeNode, number, boolean, boolean, boolean, GutterInfo[], boolean];
	const stack: StackItem[] = [];

	// Determine which subtrees contain the active leaf (to sort current branch first)
	// Use iterative post-order traversal to avoid stack overflow
	const containsActive = new Map<SessionTreeNode, boolean>();
	const leafId = currentLeafId;
	{
		// Build list in pre-order, then process in reverse for post-order effect
		const allNodes: SessionTreeNode[] = [];
		const preOrderStack: SessionTreeNode[] = [...roots];
		while (preOrderStack.length > 0) {
			const node = preOrderStack.pop()!;
			allNodes.push(node);
			// Push children in reverse so they're processed left-to-right
			for (let i = node.children.length - 1; i >= 0; i--) {
				preOrderStack.push(node.children[i]);
			}
		}
		// Process in reverse (post-order): children before parents
		for (let i = allNodes.length - 1; i >= 0; i--) {
			const node = allNodes[i];
			let has = leafId !== null && node.entry.id === leafId;
			for (const child of node.children) {
				if (containsActive.get(child)) {
					has = true;
				}
			}
			containsActive.set(node, has);
		}
	}

	// Add roots in reverse order, prioritizing the one containing the active leaf
	// If multiple roots, treat them as children of a virtual root that branches
	const multipleRoots = roots.length > 1;
	const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
	for (let i = orderedRoots.length - 1; i >= 0; i--) {
		const isLast = i === orderedRoots.length - 1;
		stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
	}

	while (stack.length > 0) {
		const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

		// Extract tool calls from assistant messages for later lookup
		const entry = node.entry;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const content = (entry.message as { content?: unknown }).content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
						const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
						toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
					}
				}
			}
		}

		result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

		const children = node.children;
		const multipleChildren = children.length > 1;

		// Order children so the branch containing the active leaf comes first
		const orderedChildren = (() => {
			const prioritized: SessionTreeNode[] = [];
			const rest: SessionTreeNode[] = [];
			for (const child of children) {
				if (containsActive.get(child)) {
					prioritized.push(child);
				} else {
					rest.push(child);
				}
			}
			return [...prioritized, ...rest];
		})();

		// Calculate child indent
		let childIndent: number;
		if (multipleChildren) {
			// Parent branches: children get +1
			childIndent = indent + 1;
		} else if (justBranched && indent > 0) {
			// First generation after a branch: +1 for visual grouping
			childIndent = indent + 1;
		} else {
			// Single-child chain: stay flat
			childIndent = indent;
		}

		// Build gutters for children
		// If this node showed a connector, add a gutter entry for descendants
		// Only add gutter if connector is actually displayed (not suppressed for virtual root children)
		const connectorDisplayed = showConnector && !isVirtualRootChild;
		// When connector is displayed, add a gutter entry at the connector's position
		// Connector is at position (displayIndent - 1), so gutter should be there too
		const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
		const connectorPosition = Math.max(0, currentDisplayIndent - 1);
		const childGutters: GutterInfo[] = connectorDisplayed
			? [...gutters, { position: connectorPosition, show: !isLast }]
			: gutters;

		// Add children in reverse order
		for (let i = orderedChildren.length - 1; i >= 0; i--) {
			const childIsLast = i === orderedChildren.length - 1;
			stack.push([
				orderedChildren[i],
				childIndent,
				multipleChildren,
				multipleChildren,
				childIsLast,
				childGutters,
				false,
			]);
		}
	}

	return result;
}

export function buildActivePath(flatNodes: FlatNode[], currentLeafId: string | null, activePathIds: Set<string>): void {
	activePathIds.clear();
	if (!currentLeafId) return;

	// Build a map of id -> entry for parent lookup
	const entryMap = new Map<string, FlatNode>();
	for (const flatNode of flatNodes) {
		entryMap.set(flatNode.node.entry.id, flatNode);
	}

	// Walk from leaf to root
	let currentId: string | null = currentLeafId;
	while (currentId) {
		activePathIds.add(currentId);
		const node = entryMap.get(currentId);
		if (!node) break;
		currentId = node.node.entry.parentId ?? null;
	}
}

export function findNearestVisibleIndex(
	flatNodes: FlatNode[],
	filteredNodes: FlatNode[],
	entryId: string | null,
): number {
	if (filteredNodes.length === 0) return 0;

	// Build a map for parent lookup
	const entryMap = new Map<string, FlatNode>();
	for (const flatNode of flatNodes) {
		entryMap.set(flatNode.node.entry.id, flatNode);
	}

	// Build a map of visible entry IDs to their indices in filteredNodes
	const visibleIdToIndex = new Map<string, number>(filteredNodes.map((node, i) => [node.node.entry.id, i]));

	// Walk from entryId up to root, looking for a visible entry
	let currentId = entryId;
	while (currentId !== null) {
		const index = visibleIdToIndex.get(currentId);
		if (index !== undefined) return index;
		const node = entryMap.get(currentId);
		if (!node) break;
		currentId = node.node.entry.parentId ?? null;
	}

	// Fallback: last visible entry
	return filteredNodes.length - 1;
}

export function applyTreeFilter(state: TreeListState): void {
	// Update lastSelectedId only when we have a valid selection (non-empty list)
	// This preserves the selection when switching through empty filter results
	if (state.filteredNodes.length > 0) {
		state.lastSelectedId = state.filteredNodes[state.selectedIndex]?.node.entry.id ?? state.lastSelectedId;
	}

	const searchTokens = state.searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

	state.filteredNodes = state.flatNodes.filter((flatNode) => {
		const entry = flatNode.node.entry;
		const isCurrentLeaf = entry.id === state.currentLeafId;

		// Skip assistant messages with only tool calls (no text) unless error/aborted
		// Always show current leaf so active position is visible
		if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
			const msg = entry.message as { stopReason?: string; content?: unknown };
			const hasText = hasTextContent(msg.content);
			const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
			// Only hide if no text AND not an error/aborted message
			if (!hasText && !isErrorOrAborted) {
				return false;
			}
		}

		// Apply filter mode
		let passesFilter = true;
		// Entry types hidden in default view (settings/bookkeeping)
		const isSettingsEntry =
			entry.type === "label" ||
			entry.type === "custom" ||
			entry.type === "model_change" ||
			entry.type === "thinking_level_change" ||
			entry.type === "context_window_change" ||
			entry.type === "session_info";

		switch (state.filterMode) {
			case "user-only":
				// Just user messages
				passesFilter = entry.type === "message" && entry.message.role === "user";
				break;
			case "no-tools":
				// Default minus tool results
				passesFilter = !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
				break;
			case "labeled-only":
				// Just labeled entries
				passesFilter = flatNode.node.label !== undefined;
				break;
			case "all":
				// Show everything
				passesFilter = true;
				break;
			default:
				// Default mode: hide settings/bookkeeping entries
				passesFilter = !isSettingsEntry;
				break;
		}

		if (!passesFilter) return false;

		// Apply search filter
		if (searchTokens.length > 0) {
			const nodeText = getSearchableText(flatNode.node).toLowerCase();
			return searchTokens.every((token) => nodeText.includes(token));
		}

		return true;
	});

	// Filter out descendants of folded nodes.
	if (state.foldedNodes.size > 0) {
		const skipSet = new Set<string>();
		for (const flatNode of state.flatNodes) {
			const { id, parentId } = flatNode.node.entry;
			if (parentId != null && (state.foldedNodes.has(parentId) || skipSet.has(parentId))) {
				skipSet.add(id);
			}
		}
		state.filteredNodes = state.filteredNodes.filter((flatNode) => !skipSet.has(flatNode.node.entry.id));
	}

	// Recalculate visual structure (indent, connectors, gutters) based on visible tree
	recalculateVisualStructure(state);

	// Try to preserve cursor on the same node, or find nearest visible ancestor
	if (state.lastSelectedId) {
		state.selectedIndex = findNearestVisibleIndex(state.flatNodes, state.filteredNodes, state.lastSelectedId);
	} else if (state.selectedIndex >= state.filteredNodes.length) {
		// Clamp index if out of bounds
		state.selectedIndex = Math.max(0, state.filteredNodes.length - 1);
	}

	// Update lastSelectedId to the actual selection (may have changed due to parent walk)
	if (state.filteredNodes.length > 0) {
		state.lastSelectedId = state.filteredNodes[state.selectedIndex]?.node.entry.id ?? state.lastSelectedId;
	}
}

/**
 * Recompute indentation/connectors for the filtered view
 *
 * Filtering can hide intermediate entries; descendants attach to the nearest visible ancestor.
 * Keep indentation semantics aligned with flattenTree() so single-child chains don't drift right.
 */
function recalculateVisualStructure(state: TreeListState): void {
	if (state.filteredNodes.length === 0) return;

	const visibleIds = new Set(state.filteredNodes.map((n) => n.node.entry.id));

	// Build entry map for efficient parent lookup (using full tree)
	const entryMap = new Map<string, FlatNode>();
	for (const flatNode of state.flatNodes) {
		entryMap.set(flatNode.node.entry.id, flatNode);
	}

	// Find nearest visible ancestor for a node
	const findVisibleAncestor = (nodeId: string): string | null => {
		let currentId = entryMap.get(nodeId)?.node.entry.parentId ?? null;
		while (currentId !== null) {
			if (visibleIds.has(currentId)) {
				return currentId;
			}
			currentId = entryMap.get(currentId)?.node.entry.parentId ?? null;
		}
		return null;
	};

	// Build visible tree structure:
	// - visibleParent: nodeId → nearest visible ancestor (or null for roots)
	// - visibleChildren: parentId → list of visible children (in filteredNodes order)
	const visibleParent = new Map<string, string | null>();
	const visibleChildren = new Map<string | null, string[]>();
	visibleChildren.set(null, []); // root-level nodes

	for (const flatNode of state.filteredNodes) {
		const nodeId = flatNode.node.entry.id;
		const ancestorId = findVisibleAncestor(nodeId);
		visibleParent.set(nodeId, ancestorId);

		if (!visibleChildren.has(ancestorId)) {
			visibleChildren.set(ancestorId, []);
		}
		visibleChildren.get(ancestorId)!.push(nodeId);
	}

	// Update multipleRoots based on visible roots
	const visibleRootIds = visibleChildren.get(null)!;
	state.multipleRoots = visibleRootIds.length > 1;

	// Build a map for quick lookup: nodeId → FlatNode
	const filteredNodeMap = new Map<string, FlatNode>();
	for (const flatNode of state.filteredNodes) {
		filteredNodeMap.set(flatNode.node.entry.id, flatNode);
	}

	// DFS over the visible tree using flattenTree() indentation semantics
	// Stack items: [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
	type StackItem = [string, number, boolean, boolean, boolean, GutterInfo[], boolean];
	const stack: StackItem[] = [];

	// Add visible roots in reverse order (to process in forward order via stack)
	for (let i = visibleRootIds.length - 1; i >= 0; i--) {
		const isLast = i === visibleRootIds.length - 1;
		stack.push([
			visibleRootIds[i],
			state.multipleRoots ? 1 : 0,
			state.multipleRoots,
			state.multipleRoots,
			isLast,
			[],
			state.multipleRoots,
		]);
	}

	while (stack.length > 0) {
		const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

		const flatNode = filteredNodeMap.get(nodeId);
		if (!flatNode) continue;

		// Update this node's visual properties
		flatNode.indent = indent;
		flatNode.showConnector = showConnector;
		flatNode.isLast = isLast;
		flatNode.gutters = gutters;
		flatNode.isVirtualRootChild = isVirtualRootChild;

		// Get visible children of this node
		const children = visibleChildren.get(nodeId) || [];
		const multipleChildren = children.length > 1;

		// Child indent follows flattenTree(): branch points (and first generation after a branch) shift +1
		let childIndent: number;
		if (multipleChildren) {
			childIndent = indent + 1;
		} else if (justBranched && indent > 0) {
			childIndent = indent + 1;
		} else {
			childIndent = indent;
		}

		// Child gutters follow flattenTree() connector/gutter rules
		const connectorDisplayed = showConnector && !isVirtualRootChild;
		const currentDisplayIndent = state.multipleRoots ? Math.max(0, indent - 1) : indent;
		const connectorPosition = Math.max(0, currentDisplayIndent - 1);
		const childGutters: GutterInfo[] = connectorDisplayed
			? [...gutters, { position: connectorPosition, show: !isLast }]
			: gutters;

		// Add children in reverse order (to process in forward order via stack)
		for (let i = children.length - 1; i >= 0; i--) {
			const childIsLast = i === children.length - 1;
			stack.push([
				children[i],
				childIndent,
				multipleChildren,
				multipleChildren,
				childIsLast,
				childGutters,
				false,
			]);
		}
	}

	// Store visible tree maps for ancestor/descendant lookups in navigation
	state.visibleParentMap = visibleParent;
	state.visibleChildrenMap = visibleChildren;
}
