import type { SessionInfo } from "../../../core/session-manager.ts";
import { getSessionPathKey } from "./session-selector-utils.ts";

/** A session tree node for hierarchical display */
interface SessionTreeNode {
	session: SessionInfo;
	children: SessionTreeNode[];
}

/** Flattened node for display with tree structure info */
export interface FlatSessionNode {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	/** For each ancestor level, whether there are more siblings after it */
	ancestorContinues: boolean[];
}

const pathKeys = new WeakMap<SessionInfo, { path: string; key: string }>();

function sessionPathKey(session: SessionInfo): string {
	const cached = pathKeys.get(session);
	if (cached?.path === session.path) return cached.key;
	const key = getSessionPathKey(session.path);
	pathKeys.set(session, { path: session.path, key });
	return key;
}

function removeParentCycles(parents: Map<SessionTreeNode, SessionTreeNode>): void {
	const visitedFrom = new Map<SessionTreeNode, SessionTreeNode>();
	for (const origin of parents.keys()) {
		let node: SessionTreeNode | undefined = origin;
		while (node && !visitedFrom.has(node)) {
			visitedFrom.set(node, origin);
			node = parents.get(node);
		}
		if (node && visitedFrom.get(node) === origin) parents.delete(node);
	}
}

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending).
 */
export function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	const nodes = sessions.map((session): SessionTreeNode => ({ session, children: [] }));
	const byPath = new Map<string, SessionTreeNode>();
	for (const node of nodes) byPath.set(node.session.path, node);
	let byKey: Map<string, SessionTreeNode> | undefined;
	const parentOf = (parentPath: string): SessionTreeNode | undefined => {
		const exact = byPath.get(parentPath);
		if (exact) return exact;
		if (!byKey) {
			byKey = new Map();
			for (const node of nodes) byKey.set(sessionPathKey(node.session), node);
		}
		return byKey.get(getSessionPathKey(parentPath));
	};

	const parents = new Map<SessionTreeNode, SessionTreeNode>();
	for (const node of nodes) {
		const parentPath = node.session.parentSessionPath;
		const parent = parentPath ? parentOf(parentPath) : undefined;
		if (parent && parent !== node) parents.set(node, parent);
	}
	removeParentCycles(parents);

	const roots: SessionTreeNode[] = [];
	for (const node of nodes) {
		const parent = parents.get(node);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}

	// Sort children and roots by modified date (descending)
	const sortNodes = (list: SessionTreeNode[]): void => {
		list.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
		for (const node of list) {
			sortNodes(node.children);
		}
	};
	sortNodes(roots);

	return roots;
}

/**
 * Flatten tree into display list with tree structure metadata.
 */
export function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];

	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		result.push({ session: node.session, depth, isLast, ancestorContinues });

		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			// Only show continuation line for non-root ancestors
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};

	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}

	return result;
}
