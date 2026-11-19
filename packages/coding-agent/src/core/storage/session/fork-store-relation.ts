import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { forkScope, forkStoreRelation } from "./fork-store-scope.js";
import type { SessionStore } from "./types.js";

export type ForkStoreRelation = "same" | "different" | "unknown";

interface JsonlForkScope {
	readonly directory: string;
	readonly exact: boolean;
}

/** Whether two JSONL collections are one, by filesystem identity. An exact directory and a project root
 * are different only when neither contains the other; a failed identity check proves nothing. */
export async function jsonlDirectoryRelation(a: JsonlForkScope, b: JsonlForkScope): Promise<ForkStoreRelation> {
	try {
		const [pa, pb] = await Promise.all([realpath(a.directory), realpath(b.directory)]);
		const [sa, sb] = await Promise.all([stat(pa, { bigint: true }), stat(pb, { bigint: true })]);
		if (sa.dev === sb.dev && sa.ino === sb.ino && sa.ino !== 0n) return a.exact === b.exact ? "same" : "unknown";
		const outside = (p: string) => isAbsolute(p) || p === ".." || p.startsWith(`..${sep}`);
		if ((a.exact && b.exact) || (outside(relative(pa, pb)) && outside(relative(pb, pa)))) return "different";
	} catch {
		/* A failed identity check is not evidence that private history belongs to another collection. */
	}
	return "unknown";
}

/** The relation of two open stores: registered backings first, then JSONL directory identity. */
export async function resolveForkStoreRelation(source: SessionStore, target: SessionStore): Promise<ForkStoreRelation> {
	const relation = forkStoreRelation(source, target);
	const a = forkScope(source),
		b = forkScope(target);
	return relation === "unknown" && a?.kind === "jsonl" && b?.kind === "jsonl"
		? jsonlDirectoryRelation(a, b)
		: relation;
}

/** A fork from a file in `source` into the exact directory `target`, before that directory is opened. A
 * directory that does not exist yet is never the file's own, so checking it must not create it. */
export async function exactDirectoryRelation(source: string, target: string): Promise<ForkStoreRelation> {
	try {
		await stat(target);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "different" : "unknown";
	}
	return jsonlDirectoryRelation({ directory: source, exact: true }, { directory: target, exact: true });
}
