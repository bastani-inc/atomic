import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { mapRestoredPath } from "../session-worktree-snapshots.ts";
import type { WorktreeRootMapping } from "../worktree-snapshot/types.ts";

/**
 * Restores on this host by the root they produced, each keyed by its `from` and `to`: work recorded under each `from`
 * now happens under `to`.
 */
const mappingsByRoot = new Map<string, Map<string, WorktreeRootMapping>>();

/** Whether `child` is `parent` or a path below it. */
export function isInside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

/**
 * Makes `mappings` (one session's or run's restores, oldest first) apply to paths resolved for work under any of their
 * `to` roots on this host, so a path under any root the session recorded follows its restore. Registering the same
 * mapping again is a no-op.
 */
export function registerWorktreeRootMappings(mappings: readonly WorktreeRootMapping[]): void {
	for (const mapping of mappings) {
		const root = resolve(mapping.to);
		const known = mappingsByRoot.get(root) ?? new Map<string, WorktreeRootMapping>();
		for (const candidate of mappings) known.set(`${candidate.from}\0${candidate.to}`, candidate);
		mappingsByRoot.set(root, known);
	}
}

/** Forgets every registered mapping. */
export function clearWorktreeRootMappings(): void {
	mappingsByRoot.clear();
}

/**
 * `path` as it resolves for work in `cwd` on this host: when `cwd` is inside a restored root and `path` is outside it
 * but inside a root recorded on another node (or an earlier checkout), the path moves to the same place in the
 * restored root. From any other `cwd`, a path inside a recorded root that does not exist on this host moves to where
 * that root was restored, as for a session that continues in a checkout of its own and had another one restored.
 * Every other path is returned unchanged.
 */
export function mapPathForCwd(path: string, cwd: string): string {
	const base = resolve(cwd);
	let root: string | undefined;
	for (const candidate of mappingsByRoot.keys()) {
		if (isInside(candidate, base) && (root === undefined || candidate.length > root.length)) root = candidate;
	}
	if (root === undefined) return mapPathFromMissingRoot(path);
	if (isInside(root, resolve(path))) return path;
	const mapped = mapRestoredPath(path, [...mappingsByRoot.get(root)!.values()]);
	return mapped === resolve(path) ? path : mapped;
}

function mapPathFromMissingRoot(path: string): string {
	const target = resolve(path);
	for (const mappings of mappingsByRoot.values()) {
		for (const mapping of mappings.values()) {
			const from = resolve(mapping.from);
			if (!isInside(from, target) || existsSync(from)) continue;
			const mapped = mapRestoredPath(path, [...mappings.values()]);
			return mapped === target ? path : mapped;
		}
	}
	return path;
}
