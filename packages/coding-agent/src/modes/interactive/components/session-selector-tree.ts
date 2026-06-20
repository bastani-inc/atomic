import type { SessionInfo } from "../../../core/session-manager.ts";
import { canonicalizePath } from "./session-selector-utils.ts";

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

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending).
 */
export function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	const byPath = new Map<string, SessionTreeNode>();

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		byPath.set(sessionPath, { session, children: [] });
	}

	const roots: SessionTreeNode[] = [];

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		const node = byPath.get(sessionPath)!;
		const parentPath = canonicalizePath(session.parentSessionPath);

		if (parentPath && byPath.has(parentPath)) {
			byPath.get(parentPath)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	// Sort children and roots by modified date (descending)
	const sortNodes = (nodes: SessionTreeNode[]): void => {
		nodes.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
		for (const node of nodes) {
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
