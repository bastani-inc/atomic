import { dirname } from "node:path";
import { sliceByColumn, visibleWidth } from "@bastani/atomic-tui";
import { canonicalizePathAsync, getPathComparisonKey, shortenHomePath } from "../../../utils/paths.ts";

export function shortenPath(path: string): string {
	return shortenHomePath(path);
}

export function truncatePathStart(path: string, maxWidth: number): string {
	const pathWidth = visibleWidth(path);
	if (pathWidth <= maxWidth) return path;
	if (maxWidth <= 0) return "";
	const tailWidth = maxWidth - 1;
	return `…${sliceByColumn(path, pathWidth - tailWidth, tailWidth)}`;
}

export function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

const canonicalPathKeys = new Map<string, string>();

/**
 * Resolves the symlinks of these paths off the event loop, so {@link getSessionPathKey} can answer from memory while
 * the picker renders and filters. Resolves to whether any path's key differs from its spelling's.
 */
export async function resolveSessionPathKeys(paths: Iterable<string | undefined>): Promise<boolean> {
	const pending = [...new Set(paths)].filter(
		(path): path is string => path !== undefined && !canonicalPathKeys.has(path),
	);
	let changed = false;
	await Promise.all(
		pending.map(async (path) => {
			const key = getPathComparisonKey(await canonicalizePathAsync(path));
			canonicalPathKeys.set(path, key);
			if (key !== getPathComparisonKey(path)) changed = true;
		}),
	);
	return changed;
}

/** The paths a picker compares for these sessions: each file, its directory and its parent session's file. */
export function sessionComparisonPaths(
	sessions: Iterable<{ readonly path: string; readonly parentSessionPath?: string }>,
	currentDirectory?: string,
): string[] {
	const paths: string[] = currentDirectory === undefined ? [] : [currentDirectory];
	for (const session of sessions) {
		paths.push(session.path, dirname(session.path));
		if (session.parentSessionPath !== undefined) paths.push(session.parentSessionPath);
	}
	return paths;
}

/** Whether {@link resolveSessionPathKeys} has resolved this path's symlinks. */
export function isSessionPathKeyResolved(path: string): boolean {
	return canonicalPathKeys.has(path);
}

/**
 * Comparison key for a session file path; follows symlinks and ignores case on Windows. Answers from the keys
 * {@link resolveSessionPathKeys} resolved; a path it has not seen yet compares by its spelling.
 */
export function getSessionPathKey(path: string): string {
	return canonicalPathKeys.get(path) ?? getPathComparisonKey(path);
}
