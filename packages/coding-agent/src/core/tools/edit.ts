import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { experimentalToolSamplingProperty } from "../experimental.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { nativeBlockResolver } from "./block-resolver.ts";
import { EditBatchCoordinator, parallelEditBatchWarning } from "./edit-batch.ts";
import { generateDiffString, generateUnifiedPatch, normalizeToLF, stripBom } from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import {
	createHashlineSnapshotStore,
	formatCompactHashlineEditResult,
	type HashlineSnapshotStore,
	recordHashlineSnapshot,
} from "./hashline.ts";
import {
	Filesystem,
	missingSnapshotTagMessage,
	Patch,
	Patcher,
	type PatchSectionResult,
	type PreparedSection,
	type WriteResult,
} from "./hashline-engine/index.ts";
import { isNotebookPath, readEditableNotebookText, serializeEditedNotebookText } from "./notebook.ts";
import { resolveReadPath } from "./path-utils.ts";
import { renderToolPath } from "./render-utils.ts";
import { invalidateNativeSearchCache } from "./search-native.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const editSchema = Type.Object(
	{
		input: Type.String({
			description:
				"One or more hashline file sections. Must start with [PATH#TAG]; tag comes from the latest read, search, write, or successful edit output.",
		}),
	},
	{ additionalProperties: false },
);
// Hashline prompt origin: can1357/oh-my-pi packages/hashline/src/prompt.md @ 15b5c1397fc (MIT).
// This file carries Atomic-maintained local modifications; see ./hashline-engine/PROVENANCE.md and ./hashline-engine/LICENSE.upstream.
export const editToolSystemPromptContribution = Object.freeze({
	snippet: "Apply source edits with hashline patch input",
	guidelines: Object.freeze([
		"hashline edit format: a header ending in ':' is followed by '+TEXT' body rows; 'delete' has no body. Every section starts with [PATH#TAG]; TAG is REQUIRED (the 4-hex snapshot tag from your latest read/search) — there is no hashless form. Use the write tool to create new files.",
		"Ops: 'replace N..M:' replaces original lines N..M (INCLUSIVE — line M is consumed); 'delete N..M' / 'delete block N' delete (no body); 'insert before N:' / 'insert after N:' insert relative to a line; 'insert head:' / 'insert tail:' insert at file start/end. Block ops ('replace block N:', 'delete block N', 'insert after block N:') resolve the exact syntactic node BEGINNING on N through the native Rust tree-sitter `blockRangeAt` primitive in `@bastani/atomic-natives`; the brace/indent heuristic is the fallback only when the native binding is unavailable. Single line: 'replace N..N:' / 'delete N'. The range is the ORIGINAL lines you touch; body length is irrelevant.",
		"Body rows appear only under a ':' header and start on the NEXT line. Every row is '+TEXT' (adds a literal line, leading whitespace kept; '+' alone adds a blank line). There is NO other body row kind — never write '-old' or a bare/context line. To keep a line, leave it out of every range. For a literal line starting with '-' or '+', prefix it: '+-x', '++x'.",
		"Block anchors: 'replace block N' resolves the outermost node BEGINNING on N. Where a language folds a decorator/annotation into its construct (Python folds `@dec` and `def` into one node; TypeScript/Java annotations also fold), anchoring at the first decorator sweeps both. Rust `#[attr]` and doc- or line-comments resolve alone; replacing there with a construct body duplicates the construct, so use explicit 'replace N..M:' to take both. Confirm the result echo: 'replace block N → resolved lines A-B (K lines)'. 'insert after block N:' takes the opener, never the closer; insert-after echoes '; body lands after line B'. Resolution fails for an unsupported language, blank/closer line, no node beginning on N, or an unparsable block; use 'replace N..M:' or 'insert after M:' instead.",
		"Numbers refer to the ORIGINAL file and do not shift as hunks apply; they die with the call — every applied edit mints a fresh #TAG and renumbers, so anchor the next edit on the edit response or a fresh read. Parallel edit calls that share a [path#TAG] are applied as one snapshot batch. Ranges are TIGHT: cover ONLY lines whose content changes; a stale wide range shreds everything it spans. Pure additions use 'insert', never a widened 'replace'. Whole construct → 'replace block N'; lines inside it → 'replace N..M'.",
		"On a stale-tag rejection or any surprising result: STOP and re-read before further edits. Never start or end a range mid-expression/mid-block, and never span a hunk across an elided ('…') region — read it first. Never use edit to reformat/restyle code; run the project formatter instead.",
		[
			"Worked examples. Original (the exact shape `read` returns):",
			"```text",
			"[greet.py#A1B2]",
			"1:@cache",
			"2:def greet(name):",
			'3:    msg = "Hello, " + name',
			"4:    print(msg)",
			'5:greet("world")',
			"```",
			"Replace one original line with one line:",
			"```text",
			"[greet.py#A1B2]",
			"replace 3..3:",
			'+    msg = f"Hi, {name}"',
			"```",
			"Replace the decorated Python block (Python folds `@cache` and `def` into one node; anchoring at line 2 would keep/orphan line 1). For a Rust attribute or doc- or line-comment, use explicit `replace N..M:` to take both it and the construct:",
			"```text",
			"[greet.py#A1B2]",
			"replace block 1:",
			"+@cache",
			"+def greet(name):",
			'+    print(f"Hello, {name}")',
			"```",
			"Delete one line (no colon/body):",
			"```text",
			"[greet.py#A1B2]",
			"delete 4",
			"```",
			"Delete a range (no colon/body):",
			"```text",
			"[greet.py#A1B2]",
			"delete 3..4",
			"```",
			"Delete a whole block (no colon/body):",
			"```text",
			"[greet.py#A1B2]",
			"delete block 2",
			"```",
			"Insert before a line:",
			"```text",
			"[greet.py#A1B2]",
			"insert before 5:",
			"+log()",
			"```",
			"Insert after a line:",
			"```text",
			"[greet.py#A1B2]",
			"insert after 3:",
			"+    print(msg)",
			"```",
			"Insert after the block whose opener is line 2:",
			"```text",
			"[greet.py#A1B2]",
			"insert after block 2:",
			"+audit()",
			"```",
			"Insert at both file ends:",
			"```text",
			"[greet.py#A1B2]",
			"insert head:",
			"+# generated",
			"insert tail:",
			'+greet("everyone")',
			"```",
			"Multi-file input:",
			"```text",
			"[src/a.ts#0A3B]",
			"replace 1..1:",
			"+export const enabled = true;",
			"[src/b.ts#1F7C]",
			"delete 20",
			"```",
		].join("\n"),
		[
			"Anti-patterns:",
			"```text",
			"# WRONG — `-` rows are rejected; bare context rows are auto-prefixed and inserted as literal content: `-` rows are not valid; the range already names the lines being changed. For a literal `-` line, write `+-…`.",
			"replace 3..3:",
			'    msg = "Hello"',
			"-   print(msg)",
			"+   return msg",
			"# RIGHT",
			"replace 3..3:",
			"+   return msg",
			"",
			"# WRONG — body glued to its header: payload line has no preceding hunk header; body starts on the NEXT line.",
			"replace block 238:+export const value = 1;",
			"# RIGHT",
			"replace block 238:",
			"+export const value = 1;",
			"",
			"# WRONG — `delete N..M` has no colon and no body.",
			"delete 2..3:",
			"+replacement",
			"# RIGHT: delete 2..3",
			"",
			"# WRONG — empty `insert` / `replace`: `insert` needs at least one `+TEXT` body row. A bodyless concrete `replace` silently deletes the range.",
			"insert after 2:",
			"replace 4..4:",
			"# RIGHT — give `replace` a body; if deletion is intended, write `delete 4`.",
			"",
			"# WRONG — widened replace for a pure insertion can drop retyped keepers.",
			"replace 2..4:",
			"+kept()",
			"+added()",
			"# RIGHT: insert after 2:",
			"+added()",
			"",
			"# WRONG — block anchor is a closer/last visible line.",
			"insert after block 3:",
			"+after()",
			"# RIGHT: insert after 3:",
			"+after()",
			"```",
		].join("\n"),
		[
			"If you remember nothing else:",
			"1. RE-GROUND AFTER EVERY EDIT. Every apply mints a fresh #TAG and renumbers; use the edit response or a fresh read. Stale tag or surprise? STOP and re-read.",
			"2. RANGES ARE TIGHT. Cover only lines that change; a stale wide range shreds everything it spans. Whole construct → replace block N.",
			"3. THE BODY IS THE FINAL CONTENT. Only +TEXT rows; never -old/context lines. The range does the deleting.",
		].join("\n"),
	] as const),
} as const);

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

export interface EditOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	operations?: EditOperations;
	hashlineStore?: HashlineSnapshotStore;
}

type EditToolResultLike = {
	content: Array<{ type: "text"; text: string }>;
	details: EditToolDetails | undefined;
};

class EditFilesystem extends Filesystem {
	private readonly cwd: string;
	private readonly operations: EditOperations;
	constructor(cwd: string, operations: EditOperations) {
		super();
		this.cwd = cwd;
		this.operations = operations;
	}

	canonicalPath(path: string): string {
		return resolveReadPath(path, this.cwd);
	}

	async preflightWrite(path: string): Promise<void> {
		const absolutePath = this.canonicalPath(path);
		try {
			await this.operations.access(absolutePath);
		} catch (error: unknown) {
			const message = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			throw new Error(`Could not edit file: ${path}. ${message}.`);
		}
	}

	async readText(path: string): Promise<string> {
		const absolutePath = this.canonicalPath(path);
		return isNotebookPath(absolutePath)
			? readEditableNotebookText(absolutePath, path)
			: (await this.operations.readFile(absolutePath)).toString("utf-8");
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		const absolutePath = this.canonicalPath(path);
		const persisted = isNotebookPath(absolutePath)
			? serializeEditedNotebookText(absolutePath, path, normalizeToLF(stripBom(content).text))
			: content;
		await this.operations.writeFile(absolutePath, persisted);
		return { text: persisted };
	}
}

function isFourDigitHexTag(value: string): boolean {
	return (
		value.length === 4 &&
		[...value].every(
			(char) => (char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F"),
		)
	);
}

function extractFirstHeaderPath(input: string | undefined): string | undefined {
	if (!input) return undefined;
	for (const line of input.split("\n")) {
		const trimmed = line.trimStart();
		if (!trimmed.startsWith("[")) continue;
		const hashIndex = trimmed.indexOf("#", 1);
		const closeIndex = hashIndex >= 0 ? trimmed.indexOf("]", hashIndex + 1) : -1;
		if (hashIndex <= 1 || closeIndex !== hashIndex + 5) continue;
		const tag = trimmed.slice(hashIndex + 1, closeIndex);
		if (isFourDigitHexTag(tag)) return trimmed.slice(1, hashIndex);
	}
	return undefined;
}

function formatEditCall(args: unknown, theme: Theme, cwd: string): string {
	const input = args && typeof args === "object" && "input" in args ? (args as { input?: unknown }).input : undefined;
	const pathDisplay = renderToolPath(
		extractFirstHeaderPath(typeof input === "string" ? input : undefined) ?? null,
		theme,
		cwd,
	);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function formatEditResult(result: EditToolResultLike, theme: Theme, isError: boolean): string | undefined {
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		return errorText ? theme.fg("error", errorText) : undefined;
	}
	return result.details?.diff ? renderDiff(result.details.diff) : undefined;
}

async function withFileMutationQueues<T>(filePaths: readonly string[], fn: () => Promise<T>): Promise<T> {
	const sorted = [...new Set(filePaths)].sort();
	const run = (index: number): Promise<T> => {
		const filePath = sorted[index];
		return filePath ? withFileMutationQueue(filePath, () => run(index + 1)) : fn();
	};
	return run(0);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

function formatNoopMessage(path: string, count: number): string {
	return `Edits to ${path} parsed and applied cleanly, but produced no change: your body row(s) are byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor first.${count > 1 ? `\nNo-op count for this identical payload: ${count}.` : ""}`;
}

function blockMessages(item: PreparedSection | PatchSectionResult): string[] {
	const warnings =
		"parseWarnings" in item ? [...item.parseWarnings, ...(item.applyResult.warnings ?? [])] : item.warnings;
	const resolutions =
		("applyResult" in item ? item.applyResult.blockResolutions : item.blockResolutions)?.map((resolution) => {
			const verb = resolution.op === "insert_after" ? "insert after block" : `${resolution.op} block`;
			const lands = resolution.op === "insert_after" ? `; body lands after line ${resolution.end}` : "";
			return `${verb} ${resolution.anchorLine} → resolved lines ${resolution.start}-${resolution.end} (${resolution.end - resolution.start + 1} lines)${lands}`;
		}) ?? [];
	return [...warnings, ...resolutions];
}

function assertUniquePreparedPaths(prepared: readonly PreparedSection[]): void {
	const seen = new Map<string, string>();
	for (const entry of prepared) {
		const previous = seen.get(entry.canonicalPath);
		if (previous)
			throw new Error(
				`Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Merge their ops under one header before applying.`,
			);
		seen.set(entry.canonicalPath, entry.section.path);
	}
}

interface EditCwdScope {
	readonly fs: EditFilesystem;
	readonly batcher: EditBatchCoordinator<EditToolResultLike>;
	applySiblingEdits(siblings: readonly { input: string }[], applySignal?: AbortSignal): Promise<EditToolResultLike>;
}

function createEditCwdScope(cwd: string, ops: EditOperations, hashlineStore: HashlineSnapshotStore): EditCwdScope {
	const fs = new EditFilesystem(cwd, ops);
	const patcher = new Patcher({ fs, snapshots: hashlineStore.snapshots, blockResolver: nativeBlockResolver });
	const noopCounts = new Map<string, number>();
	const batcher = new EditBatchCoordinator<EditToolResultLike>();
	async function applySiblingEdits(
		siblings: readonly { input: string }[],
		applySignal?: AbortSignal,
	): Promise<EditToolResultLike> {
		const merged =
			siblings.length === 1
				? Patch.parse(siblings[0]!.input, { cwd })
				: Patch.parse(siblings.map((sibling) => sibling.input).join("\n"), { cwd });
		const prepared: PreparedSection[] = [];
		for (const section of merged.sections) {
			throwIfAborted(applySignal);
			prepared.push(await patcher.prepare(section));
		}
		assertUniquePreparedPaths(prepared);
		const noops = prepared.filter((item) => item.isNoop);
		if (noops.length > 0) {
			if (noops.length !== prepared.length)
				throw new Error(`Hashline edit for ${noops[0]!.section.path} did not change the file.`);
			const key = prepared.map((item) => `${item.canonicalPath}\0${item.applyResult.text}`).join("\0\0");
			const count = (noopCounts.get(key) ?? 0) + 1;
			noopCounts.set(key, count);
			if (count >= 3) throw new Error(`STOP. ${formatNoopMessage(prepared[0]!.section.path, count)}`);
			return {
				content: [{ type: "text", text: formatNoopMessage(prepared[0]!.section.path, count) }],
				details: { diff: "", patch: "" },
			};
		}
		for (const item of prepared) {
			throwIfAborted(applySignal);
			if (normalizeToLF(stripBom(await fs.readText(item.section.path)).text) !== item.normalized)
				throw new Error(
					`Stale hashline tag for ${item.section.path}: file content changed before write. Re-read before editing.`,
				);
		}
		const outputs: string[] = [];
		let combinedDiff = "",
			combinedPatch = "";
		let firstChangedLine: number | undefined;
		const batchNote = siblings.length > 1 ? [parallelEditBatchWarning(siblings.length)] : [];
		for (let index = 0; index < prepared.length; index++) {
			const item = prepared[index]!;
			throwIfAborted(applySignal);
			let result: PatchSectionResult;
			try {
				result = await patcher.commit(item);
			} catch (error) {
				const written = prepared.slice(0, index).map((entry) => entry.section.path);
				const notWritten = prepared.slice(index + 1).map((entry) => entry.section.path);
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to write ${item.section.path}: ${message}` +
						(written.length > 0 ? ` Sections already written: ${written.join(", ")}.` : "") +
						(notWritten.length > 0 ? ` Sections not written: ${notWritten.join(", ")}.` : ""),
					{ cause: error },
				);
			}
			throwIfAborted(applySignal);
			invalidateNativeSearchCache(result.canonicalPath);
			const snapshot = recordHashlineSnapshot(result.canonicalPath, cwd, result.after, hashlineStore);
			const diffResult = generateDiffString(result.before, result.after);
			combinedDiff += `${combinedDiff ? "\n" : ""}${diffResult.diff}`;
			combinedPatch += `${combinedPatch ? "\n" : ""}${generateUnifiedPatch(result.path, result.before, result.after)}`;
			firstChangedLine ??= diffResult.firstChangedLine;
			outputs.push(formatCompactHashlineEditResult(snapshot, diffResult, [...batchNote, ...blockMessages(result)]));
		}
		return {
			content: [{ type: "text", text: outputs.join("\n\n") }],
			details: { diff: combinedDiff, patch: combinedPatch, firstChangedLine },
		};
	}
	return { fs, batcher, applySiblingEdits };
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined> {
	const ops = options?.operations ?? defaultEditOperations;
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	// Atomic adaptation of upstream #8627 ("use ctx.cwd for cwd-sensitive tools"). Upstream's edit
	// tool is a stateless text replacer, so it could resolve `ctx?.cwd || cwd` inline. Atomic's
	// hashline patcher instead carries per-tool state — the `EditFilesystem`, the `Patcher`, the
	// repeated-no-op counters, and the parallel-edit batcher — that is all keyed to one cwd.
	// Mutating a shared cwd field would corrupt concurrent tool calls, so each distinct execution
	// cwd gets its own scope. Callers that pass no ctx keep the factory cwd's scope unchanged.
	const scopes = new Map<string, EditCwdScope>();
	const scopeFor = (executionCwd: string): EditCwdScope => {
		const existing = scopes.get(executionCwd);
		if (existing) return existing;
		const scope = createEditCwdScope(executionCwd, ops, hashlineStore);
		scopes.set(executionCwd, scope);
		return scope;
	};
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit existing files with the hashline patch language: each section starts with [PATH#TAG] (TAG is the 4-hex snapshot tag from your latest read/search), then hunk headers (replace N..M:, replace block N:, delete N..M, delete block N, insert before|after N:, insert after block N:, insert head:, insert tail:) followed by +TEXT body rows. Numbers refer to the original file. Use the write tool to create new files.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		...experimentalToolSamplingProperty(),
		parameters: editSchema,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			if (typeof input.input !== "string" || input.input.trim() === "")
				throw new Error("edit input must be a non-empty hashline script with [PATH#TAG] sections.");
			const executionCwd = ctx?.cwd || cwd;
			const { fs, batcher, applySiblingEdits } = scopeFor(executionCwd);
			const patch = Patch.parse(input.input, { cwd: executionCwd });
			const paths = new Map<string, string>();
			for (const section of patch.sections) {
				if (section.fileHash === undefined) throw new Error(missingSnapshotTagMessage(section.path));
				paths.set(section.path, section.fileHash);
			}
			const entry = batcher.announce(input.input, paths, signal);
			try {
				return await withFileMutationQueues(
					[...paths.keys()].map((sectionPath) => fs.canonicalPath(sectionPath)),
					async () => {
						if (entry.settled) return await entry.promise;
						throwIfAborted(signal);
						const siblings = batcher.takeCompatible(entry);
						try {
							const result = await applySiblingEdits(siblings, signal);
							for (const sibling of siblings) sibling.resolve(result);
							return result;
						} catch (error) {
							for (const sibling of siblings) sibling.reject(error);
							throw error;
						}
					},
				);
			} catch (error) {
				if (entry.settled) return await entry.promise;
				entry.reject(error);
				throw error;
			} finally {
				batcher.drop(entry);
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatEditCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const output = formatEditResult(result as EditToolResultLike, theme, context.isError);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) return component;
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
