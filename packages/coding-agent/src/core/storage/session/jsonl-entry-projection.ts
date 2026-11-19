import type { Token } from "stream-json/core/parser.js";
import type { SessionEntry, WorktreeRestoreHostWarning } from "../../session-manager-types.ts";
import {
	chunkedPrefixFields,
	type Reader,
	read,
	readValue,
	type Shape,
	skip,
	stringValue,
} from "./chunked-resume-projection.js";
import { validateSessionEntryStructure, validRestoreHostWarning } from "./entry-structure.js";
import { validateSessionEntries } from "./validation.js";

// A bounded witness for each predicate used by validateSessionEntryStructure. Preserve exact identity and
// timestamp values where validation compares them; never retain a message, patch, blob, output or summary.
const string: Shape = "stringPresent";
const nullableString: Shape = function* (t) {
	if (t.name === "startString") return yield* stringValue();
	yield* skip(t);
	return t.name === "nullValue" ? null : false;
};
const dateValue: Shape = function* (t) {
	if (t.name === "startString") return yield* stringValue();
	yield* skip(t);
	return t.name === "numberValue" ? Number(t.value) : false;
};
const array: Shape = function* (t) {
	yield* skip(t);
	return t.name === "startArray" ? [] : null;
};
const compound: Shape = function* (t) {
	yield* skip(t);
	return t.name === "startArray" || t.name === "startObject" ? {} : null;
};
const boolean: Shape = function* (t) {
	yield* skip(t);
	return t.name === "trueValue" || t.name === "falseValue" ? t.value : null;
};
const content: Shape = function* (t) {
	yield* skip(t);
	return t.name === "startArray" ? [] : t.name === "startString" ? "" : null;
};
const checkedArray = (shape: Shape, pred: (v: unknown) => boolean): Shape =>
	function* (t: Token) {
		if (t.name !== "startArray") {
			yield* skip(t);
			return null;
		}
		let valid = true;
		for (let token = yield; token.name !== "endArray"; token = yield)
			valid = pred(yield* readValue(token, shape)) && valid;
		return valid ? [] : [null];
	};
const strings = checkedArray(string, (v) => typeof v === "string");
const blobTypes: Shape = function* (t) {
	if (t.name !== "startObject") {
		yield* skip(t);
		return null;
	}
	let valid = true;
	while ((yield).name !== "endObject") {
		yield* stringValue(0);
		const v = yield;
		valid &&= v.name === "startString";
		yield* skip(v);
	}
	const witness: Record<string, number> = {};
	if (!valid) witness.bad = 0;
	return witness;
};
const worktree = {
	root: "string",
	snapshotId: "string",
	snapshot: { id: "string", tree: string, chain: array },
	restore: {
		from: string,
		to: "string",
		snapshotId: "string",
		degraded: {
			stage: "short",
			head: string,
			tree: string,
			missingLinks: checkedArray("number", (v) => Number.isInteger(v)),
			missingPaths: strings,
			missingCommits: strings,
			cause: string,
			hint: string,
		},
	},
	unrestored: {
		snapshotId: "string",
		continuedIn: string,
		place: "short",
		from: string,
		cause: string,
		detail: string,
		hint: string,
		at: string,
	},
	restoreWarnings: checkedArray({ code: "short", path: string, kind: "short", paths: strings }, (v) =>
		validRestoreHostWarning(v as WorktreeRestoreHostWarning),
	),
	blobs: blobTypes,
} satisfies Record<string, Shape>;
const variants: Readonly<Record<string, Record<string, Shape>>> = {
	message: {
		message: {
			role: "short",
			content,
			timestamp: "number",
			command: string,
			output: string,
			cancelled: boolean,
			truncated: boolean,
			summary: string,
			fromId: nullableString,
		},
	},
	thinking_level_change: { thinkingLevel: string },
	model_change: { provider: string, modelId: string },
	usage: { kind: string, provider: string, model: string, usage: compound },
	compaction: {
		summary: string,
		firstKeptEntryId: nullableString,
		coveredThroughEntryId: "string",
		tokensBefore: "number",
		systemMessage: { timestamp: dateValue },
	},
	context_compaction: { promptVersion: "number", deletedTargets: array, protectedEntryIds: array, stats: compound },
	branch_summary: { fromId: string, summary: string },
	custom: { customType: string },
	custom_message: { customType: string, content, display: boolean },
	context_edit: { targetId: string, replacement: { content } },
	label: { targetId: string, label: string },
	session_info: { name: string },
	session_summary: { summary: string, summarizedThroughId: "string" },
	worktree_snapshot: worktree,
};
export async function jsonlEntryProjection(path: string, chunks: () => AsyncIterable<Uint8Array>) {
	const kind = await read(
		chunks(),
		(function* (): Reader<unknown> {
			return yield* readValue(yield, { type: "short" });
		})(),
	);
	const type = kind && typeof kind === "object" && "type" in kind && typeof kind.type === "string" ? kind.type : "";
	const fields = Object.hasOwn(variants, type) ? variants[type]! : {};
	const sample = (await read(
		chunks(),
		(function* (): Reader<unknown> {
			return yield* readValue(yield, {
				type: "short",
				id: "string",
				parentId: nullableString,
				timestamp: "string",
				...fields,
			});
		})(),
	)) as SessionEntry;
	validateSessionEntryStructure([sample], path);
	validateSessionEntries([sample]);
	return chunkedPrefixFields(chunks);
}
