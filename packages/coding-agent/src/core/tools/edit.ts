import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Filesystem, Patch, Patcher, type PatchSectionResult, type PreparedSection, type WriteResult } from "./hashline-engine/index.ts";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { generateDiffString, generateUnifiedPatch, normalizeToLF, stripBom } from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { createHashlineSnapshotStore, formatCompactHashlineEditResult, recordHashlineSnapshot, type HashlineSnapshotStore } from "./hashline.ts";
import { invalidateNativeSearchCache } from "./search-native.ts";
import { isNotebookPath, readEditableNotebookText, serializeEditedNotebookText } from "./notebook.ts";
import { nativeBlockResolver } from "./block-resolver.ts";
import { resolveReadPath } from "./path-utils.ts";
import { renderToolPath } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const editSchema = Type.Object(
	{ input: Type.String({ description: "One or more hashline file sections. Must start with [PATH#TAG]; tag comes from the latest read, search, write, or successful edit output." }) },
	{ additionalProperties: false },
);

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
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

class EditFilesystem extends Filesystem {
	private readonly cwd: string;
	private readonly operations: EditOperations;
	constructor(cwd: string, operations: EditOperations) { super(); this.cwd = cwd; this.operations = operations; }

	canonicalPath(path: string): string { return resolveReadPath(path, this.cwd); }

	async preflightWrite(path: string): Promise<void> {
		const absolutePath = this.canonicalPath(path);
		try { await this.operations.access(absolutePath); }
		catch (error: unknown) {
			const message = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			throw new Error(`Could not edit file: ${path}. ${message}.`);
		}
	}

	async readText(path: string): Promise<string> {
		const absolutePath = this.canonicalPath(path);
		return isNotebookPath(absolutePath) ? readEditableNotebookText(absolutePath, path) : (await this.operations.readFile(absolutePath)).toString("utf-8");
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		const absolutePath = this.canonicalPath(path);
		const persisted = isNotebookPath(absolutePath) ? serializeEditedNotebookText(absolutePath, path, normalizeToLF(stripBom(content).text)) : content;
		await this.operations.writeFile(absolutePath, persisted);
		return { text: persisted };
	}
}

function isFourDigitHexTag(value: string): boolean {
	return value.length === 4 && [...value].every((char) => (char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F"));
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
	const pathDisplay = renderToolPath(extractFirstHeaderPath(typeof input === "string" ? input : undefined) ?? null, theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function formatEditResult(result: EditToolResultLike, theme: Theme, isError: boolean): string | undefined {
	if (isError) {
		const errorText = result.content.filter((c) => c.type === "text").map((c) => c.text || "").join("\n");
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
	const warnings = "parseWarnings" in item ? [...item.parseWarnings, ...(item.applyResult.warnings ?? [])] : item.warnings;
	const resolutions = ("applyResult" in item ? item.applyResult.blockResolutions : item.blockResolutions)?.map((resolution) => {
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
		if (previous) throw new Error(`Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Merge their ops under one header before applying.`);
		seen.set(entry.canonicalPath, entry.section.path);
	}
}

export function createEditToolDefinition(cwd: string, options?: EditToolOptions): ToolDefinition<typeof editSchema, EditToolDetails | undefined> {
	const ops = options?.operations ?? defaultEditOperations;
	const hashlineStore = options?.hashlineStore ?? createHashlineSnapshotStore();
	const fs = new EditFilesystem(cwd, ops);
	const patcher = new Patcher({ fs, snapshots: hashlineStore.snapshots, blockResolver: nativeBlockResolver });
	const noopCounts = new Map<string, number>();
	return {
		name: "edit",
		label: "edit",
		description: "Edit existing files with the hashline patch language: each section starts with [PATH#TAG] (TAG is the 4-hex snapshot tag from your latest read/search), then hunk headers (replace N..M:, replace block N:, delete N..M, delete block N, insert before|after N:, insert after block N:, insert head:, insert tail:) followed by +TEXT body rows. Numbers refer to the original file. Use the write tool to create new files.",
		promptSnippet: "Apply source edits with hashline patch input",
		promptGuidelines: [
			"hashline edit format: a header ending in ':' is followed by '+'TEXT body rows; 'delete' has no body. Every section starts with [PATH#TAG]; TAG is REQUIRED (the 4-hex snapshot tag from your latest read/search) — there is no hashless form. Use the write tool to create new files.",
			"Ops: 'replace N..M:' replaces original lines N..M (INCLUSIVE — line M is consumed); 'replace block N:' replaces the whole syntactic block that BEGINS on line N (Atomic resolves the closing line with a brace/indent heuristic; point N at the opener); 'delete N..M' / 'delete block N' delete (no body); 'insert before N:' / 'insert after N:' insert relative to a line; 'insert after block N:' inserts after the END of the block beginning on N; 'insert head:' / 'insert tail:' insert at file start/end. Single line: 'replace N..N:' / 'delete N'. The range is the ORIGINAL lines you touch; body length is irrelevant.",
			"Body rows appear only under a ':' header. Every row is '+TEXT' (adds a literal line, leading whitespace kept; '+' alone adds a blank line). There is NO other body row kind — never write '-old' or a bare/context line. To keep a line, leave it out of every range. For a literal line starting with '-' or '+', prefix it: '+-x', '++x'.",
			"Numbers refer to the ORIGINAL file and do not shift as hunks apply; they die with the call — every applied edit mints a fresh #TAG and renumbers, so anchor the next edit on the edit response or a fresh read. Ranges are TIGHT: cover ONLY lines whose content changes; a stale wide range shreds everything it spans. Pure additions use 'insert', never a widened 'replace'. Whole construct → 'replace block N'; lines inside it → 'replace N..M'.",
			"On a stale-tag rejection or any surprising result: STOP and re-read before further edits. Never start or end a range mid-expression/mid-block, and never span a hunk across an elided ('…') region — read it first. Never use edit to reformat/restyle code; run the project formatter instead.",
		],
		parameters: editSchema,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal) {
			if (typeof input.input !== "string" || input.input.trim() === "") throw new Error("edit input must be a non-empty hashline script with [PATH#TAG] sections.");
			const patch = Patch.parse(input.input, { cwd });
			const prepared: PreparedSection[] = [];
			for (const section of patch.sections) { throwIfAborted(signal); prepared.push(await patcher.prepare(section)); }
			assertUniquePreparedPaths(prepared);
			const noops = prepared.filter((item) => item.isNoop);
			if (noops.length > 0) {
				if (noops.length !== prepared.length) throw new Error(`Hashline edit for ${noops[0]!.section.path} did not change the file.`);
				const key = prepared.map((item) => `${item.canonicalPath}\0${item.applyResult.text}`).join("\0\0");
				const count = (noopCounts.get(key) ?? 0) + 1;
				noopCounts.set(key, count);
				if (count >= 3) throw new Error(`STOP. ${formatNoopMessage(prepared[0]!.section.path, count)}`);
				return { content: [{ type: "text", text: formatNoopMessage(prepared[0]!.section.path, count) }], details: { diff: "", patch: "" } };
			}
			return withFileMutationQueues(prepared.map((item) => item.canonicalPath), async () => {
				for (const item of prepared) if (normalizeToLF(stripBom(await fs.readText(item.section.path)).text) !== item.normalized) throw new Error(`Stale hashline tag for ${item.section.path}: file content changed before write. Re-read before editing.`);
				const applyResult = await patcher.apply(patch);
				const outputs: string[] = [];
				let combinedDiff = "", combinedPatch = "";
				let firstChangedLine: number | undefined;
				for (const result of applyResult.sections) {
					throwIfAborted(signal);
					invalidateNativeSearchCache(result.canonicalPath);
					const snapshot = recordHashlineSnapshot(result.canonicalPath, cwd, result.after, hashlineStore);
					const diffResult = generateDiffString(result.before, result.after);
					combinedDiff += `${combinedDiff ? "\n" : ""}${diffResult.diff}`;
					combinedPatch += `${combinedPatch ? "\n" : ""}${generateUnifiedPatch(result.path, result.before, result.after)}`;
					firstChangedLine ??= diffResult.firstChangedLine;
					outputs.push(formatCompactHashlineEditResult(snapshot, diffResult, blockMessages(result)));
				}
				return { content: [{ type: "text", text: outputs.join("\n\n") }], details: { diff: combinedDiff, patch: combinedPatch, firstChangedLine } };
			});
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
