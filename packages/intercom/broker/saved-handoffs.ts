import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { SavedHandoff, SavedHandoffStore } from "./multinode-router.js";

/** Reads one saved hand-over, or undefined for an entry this version cannot use. */
function savedHandoffOf(value: unknown): SavedHandoff | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as Record<string, unknown>;
	const { identity, handoff, id, alias, aliasToken, recovery, at } = entry;
	if (
		typeof identity !== "string" ||
		typeof handoff !== "string" ||
		typeof id !== "string" ||
		typeof alias !== "string" ||
		typeof recovery !== "string" ||
		typeof at !== "number" ||
		!Number.isFinite(at) ||
		(aliasToken !== undefined && typeof aliasToken !== "string")
	)
		return undefined;
	return { identity, handoff, id, alias, ...(aliasToken === undefined ? {} : { aliasToken }), recovery, at };
}

/**
 * #5607: the hand-overs a broker gave, kept in the file `path` of its own directory, owner-only (they carry the tokens
 * and values that take ids back), so the next broker of that directory still honours one presented after a restart.
 * The file is replaced whole: it is written beside and renamed over, so a crash leaves the earlier one. Nothing creates
 * the directory: a broker whose directory was removed keeps them in memory.
 */
export function fileHandoffStore(path: string): SavedHandoffStore {
	return {
		load() {
			let text: string;
			try {
				text = readFileSync(path, "utf8");
			} catch {
				return [];
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				return [];
			}
			if (!Array.isArray(parsed)) return [];
			return parsed.flatMap((entry) => {
				const handoff = savedHandoffOf(entry);
				return handoff === undefined ? [] : [handoff];
			});
		},
		save(handoffs) {
			if (handoffs.length === 0) {
				rmSync(path, { force: true });
				return;
			}
			const written = `${path}.${process.pid}.new`;
			writeFileSync(written, JSON.stringify(handoffs), { mode: 0o600 });
			try {
				renameSync(written, path);
			} catch (error) {
				rmSync(written, { force: true });
				throw error;
			}
		},
	};
}
