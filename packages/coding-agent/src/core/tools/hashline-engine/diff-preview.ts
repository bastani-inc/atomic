// @generated vendored verbatim from oh-my-pi packages/hashline @ 15b5c1397fc -- DO NOT EDIT.
// Parity source for the Atomic hashline edit engine (issue #1483); adapted only for Atomic's Node runtime (relative imports, Bun->Node host calls, erasable constructor syntax).
/**
 * Re-number a unified diff that uses the `+<lineNum>|content` /
 * `-<lineNum>|content` / ` <lineNum>|content` line format into a compact
 * current-file preview. Removed lines are counted for stats and post-edit
 * offset tracking, but omitted from the preview. Added and context lines are
 * anchored to their post-edit positions so a follow-up edit can reuse visible
 * concrete lines directly. Long contiguous added runs are summarized with a
 * `…` marker instead of echoing every inserted line.
 *
 * This is intentionally decoupled from the diff producer: anything that
 * emits the `<sign><lineNum>|<content>` shape works.
 */
import type { CompactDiffOptions, CompactDiffPreview } from "./types.js";

const DEFAULT_ADDED_RUN_CONTEXT_LINES = 2;

const PREVIEW_ELISION_MARKER = "…";
/** Blank row separating non-contiguous regions of a numbered diff. */
const PREVIEW_GAP_ROW = "";
const RAW_ELISION_MARKERS = new Set(["...", PREVIEW_ELISION_MARKER, `+${PREVIEW_ELISION_MARKER}`]);

function isPreviewSeparator(line: string | undefined): boolean {
	return line === PREVIEW_ELISION_MARKER || line === PREVIEW_GAP_ROW;
}

function appendPreviewLine(output: string[], line: string): void {
	const normalized = RAW_ELISION_MARKERS.has(line) ? PREVIEW_ELISION_MARKER : line;
	// Separators (elision markers, blank gap rows) never stack: omitted
	// removed lines between two separators would otherwise leave them
	// adjacent. A leading separator is dropped outright.
	if (isPreviewSeparator(normalized) && (output.length === 0 || isPreviewSeparator(output[output.length - 1]))) {
		return;
	}
	output.push(normalized);
}

interface ParsedDiffLine {
	kind: "+" | "-" | " ";
	lineNumber: number;
	content: string;
}

function normalizeAddedRunContext(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_ADDED_RUN_CONTEXT_LINES;
	return Math.max(1, Math.trunc(value));
}

function parseNumberedDiffLine(line: string): ParsedDiffLine | undefined {
	const kind = line[0];
	if (kind !== "+" && kind !== "-" && kind !== " ") return undefined;

	const body = line.slice(1);
	const sep = body.indexOf("|");
	if (sep === -1) return undefined;

	const lineNumber = Number.parseInt(body.slice(0, sep), 10);
	if (!Number.isFinite(lineNumber)) return undefined;

	return { kind, lineNumber, content: body.slice(sep + 1) };
}

function appendAddedRun(output: string[], run: string[], edgeLines: number): void {
	if (run.length === 0) return;

	const collapseThreshold = edgeLines * 2 + 1;
	if (run.length <= collapseThreshold) {
		for (const text of run) appendPreviewLine(output, text);
		return;
	}

	for (let i = 0; i < edgeLines; i++) appendPreviewLine(output, run[i]);
	appendPreviewLine(output, PREVIEW_ELISION_MARKER);
	for (let i = run.length - edgeLines; i < run.length; i++) appendPreviewLine(output, run[i]);
}

export function buildCompactDiffPreview(diff: string, options: CompactDiffOptions = {}): CompactDiffPreview {
	const lines = diff.length === 0 ? [] : diff.split("\n");
	const addedRunContext = normalizeAddedRunContext(options.maxAddedRunContext ?? options.maxUnchangedRun);
	let addedLines = 0;
	let removedLines = 0;
	const formatted: string[] = [];
	const addedRun: string[] = [];

	const flushAddedRun = (): void => {
		appendAddedRun(formatted, addedRun, addedRunContext);
		addedRun.length = 0;
	};

	// External diff producers number `+` lines with the post-edit line number,
	// `-` lines with the pre-edit line number, and context lines with the
	// pre-edit line number. To emit fresh line numbers usable for follow-up
	// edits, convert context-line numbers to post-edit positions by tracking
	// the running offset (added so far - removed so far) as we walk the diff.
	for (const line of lines) {
		const parsed = parseNumberedDiffLine(line);
		if (!parsed) {
			flushAddedRun();
			appendPreviewLine(formatted, line);
			continue;
		}

		switch (parsed.kind) {
			case "+": {
				addedLines++;
				addedRun.push(`${parsed.lineNumber}:${parsed.content}`);
				break;
			}
			case "-":
				flushAddedRun();
				removedLines++;
				break;
			default: {
				flushAddedRun();
				const newLineNumber = parsed.lineNumber + addedLines - removedLines;
				appendPreviewLine(formatted, `${newLineNumber}:${parsed.content}`);
				break;
			}
		}
	}
	flushAddedRun();
	while (formatted.length > 0 && isPreviewSeparator(formatted[formatted.length - 1])) formatted.pop();

	return { preview: formatted.join("\n"), addedLines, removedLines };
}
