import type { FencedPathId } from "./database.js";

/** What makes a fenced write path correct without the domain's serial lock. */
export interface FencedPathAudit {
	/** The rows the path locks, in the order it locks them (the same order on every fenced path, so none deadlock). */
	readonly fences: readonly string[];
	/** The conformance test that runs the path concurrently on every backend. */
	readonly conformance: string;
}

/**
 * Every audited path that may run a `fenced` transaction. A path is added here, with its fences and its test, in the
 * change that makes it fenced; nothing else can name one.
 */
const FENCED_PATHS = {} as const satisfies Readonly<Record<string, FencedPathAudit>>;

export type FencedPathName = keyof typeof FENCED_PATHS;

/** The audit record of a fenced path. */
export function fencedPathAudit(name: FencedPathName): FencedPathAudit {
	return FENCED_PATHS[name];
}

/** The `FencedPathId` that lets an audited path run `{ kind: "fenced", audit }` transactions. */
export function fencedPath(name: FencedPathName): FencedPathId {
	return name as FencedPathId;
}
