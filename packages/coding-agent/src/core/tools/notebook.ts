import { existsSync, readFileSync } from "node:fs";

/**
 * Editable notebook projection, mirrored from oh-my-pi's
 * `packages/coding-agent/src/edit/notebook.ts` at 15b5c1397fc.
 *
 * A notebook is projected to an editable text form using cell markers:
 *
 *   # %% [code|markdown|raw] cell:<index>
 *
 * Source lines that themselves look like a cell marker are escaped by adding
 * one extra `%`. Edits applied to the projected text are mapped back to the
 * underlying notebook JSON, preserving cell metadata/outputs/execution counts.
 */

export type NotebookCellType = "code" | "markdown" | "raw";

export interface NotebookCell {
	cell_type: NotebookCellType;
	source?: string | string[];
	metadata?: Record<string, unknown>;
	execution_count?: number | null;
	outputs?: unknown[];
	[key: string]: unknown;
}

export interface NotebookDocument {
	cells: NotebookCell[];
	metadata: Record<string, unknown>;
	nbformat: number;
	nbformat_minor: number;
	[key: string]: unknown;
}

const CELL_MARKER_RE = /^# %% \[(code|markdown|raw)\](?: cell:(\d+))?$/;
const ESCAPABLE_MARKER_RE = /^# %%+ \[(?:code|markdown|raw)\](?: cell:\d+)?$/;
const ESCAPED_MARKER_RE = /^# %%%+ \[(?:code|markdown|raw)\](?: cell:\d+)?$/;

export function isNotebookPath(absolutePath: string): boolean {
	return /\.ipynb$/i.test(absolutePath);
}

function escapeMarkerLikeSourceLine(line: string): string {
	if (ESCAPABLE_MARKER_RE.test(line)) return `${line.slice(0, 2)}%${line.slice(2)}`;
	return line;
}

function unescapeMarkerLikeSourceLine(line: string): string {
	if (ESCAPED_MARKER_RE.test(line)) return `${line.slice(0, 2)}${line.slice(3)}`;
	return line;
}

export function cellSourceToString(source: NotebookCell["source"]): string {
	if (source === undefined) return "";
	if (typeof source === "string") return source;
	return source.join("");
}

export function splitNotebookSource(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function emptyNotebook(): NotebookDocument {
	return { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
}

export function newNotebookCell(cellType: NotebookCellType, source: string): NotebookCell {
	const cell: NotebookCell = { cell_type: cellType, metadata: {}, source: splitNotebookSource(source) };
	if (cellType === "code") { cell.execution_count = null; cell.outputs = []; }
	return cell;
}

export function notebookToEditableText(notebook: NotebookDocument): string {
	const lines: string[] = [];
	for (const [index, cell] of notebook.cells.entries()) {
		const source = cellSourceToString(cell.source);
		lines.push(`# %% [${cell.cell_type}] cell:${index}`);
		if (source !== "") for (const line of source.split("\n")) lines.push(escapeMarkerLikeSourceLine(line));
	}
	return lines.join("\n");
}

interface ParsedVirtualCell {
	cellType: NotebookCellType;
	cellIndex?: number;
	source: string;
}

function parseNotebookEditableText(text: string, displayPath: string): ParsedVirtualCell[] {
	const lines = text.split("\n");
	const cells: ParsedVirtualCell[] = [];
	let current: ParsedVirtualCell | null = null;
	let sawMarker = false;
	for (const line of lines) {
		const match = line.match(CELL_MARKER_RE);
		if (match) {
			sawMarker = true;
			const cellType = (match[1] ?? "raw") as NotebookCellType;
			const cellIndex = match[2] !== undefined ? Number.parseInt(match[2], 10) : undefined;
			current = { cellType, cellIndex, source: "" };
			cells.push(current);
			continue;
		}
		if (!sawMarker) {
			throw new Error(
				`Invalid notebook editable representation for ${displayPath}: expected first line to be "# %% [code] cell:0", "# %% [markdown] cell:0", or "# %% [raw] cell:0".`,
			);
		}
		const restored = unescapeMarkerLikeSourceLine(line);
		current!.source = current!.source === "" ? restored : `${current!.source}\n${restored}`;
	}
	return cells;
}

export function applyNotebookEditableText(notebook: NotebookDocument, text: string, displayPath: string): NotebookDocument {
	const parsed = parseNotebookEditableText(text, displayPath);
	const next = structuredClone(notebook) as NotebookDocument;
	const used = new Set<number>();
	next.cells = parsed.map((parsedCell) => {
		let cell: NotebookCell;
		const cellIndex = parsedCell.cellIndex;
		if (cellIndex !== undefined && cellIndex >= 0 && cellIndex < notebook.cells.length && !used.has(cellIndex)) {
			used.add(cellIndex);
			cell = structuredClone(notebook.cells[cellIndex]!) as NotebookCell;
		} else {
			cell = newNotebookCell(parsedCell.cellType, "");
		}
		cell.cell_type = parsedCell.cellType;
		cell.source = splitNotebookSource(parsedCell.source);
		if (parsedCell.cellType === "code") {
			if (cell.execution_count === undefined) cell.execution_count = null;
			if (cell.outputs === undefined) cell.outputs = [];
		} else {
			delete cell.execution_count;
			delete cell.outputs;
		}
		return cell;
	});
	return next;
}

export function readEditableNotebookText(absolutePath: string, displayPath: string): string {
	const notebook = existsSync(absolutePath) ? parseNotebookSafe(readFileSync(absolutePath, "utf8"), displayPath) : emptyNotebook();
	return notebookToEditableText(notebook);
}

export function serializeEditedNotebookText(absolutePath: string, displayPath: string, text: string): string {
	const notebook = existsSync(absolutePath) ? parseNotebookSafe(readFileSync(absolutePath, "utf8"), displayPath) : emptyNotebook();
	const next = applyNotebookEditableText(notebook, text, displayPath);
	return JSON.stringify(next, null, 1);
}

function parseNotebookSafe(raw: string, displayPath: string): NotebookDocument {
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { throw new Error(`Invalid notebook JSON for ${displayPath}`); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid notebook JSON for ${displayPath}`);
	const doc = parsed as Partial<NotebookDocument>;
	return { cells: Array.isArray(doc.cells) ? doc.cells as NotebookCell[] : [], metadata: (doc.metadata ?? {}) as Record<string, unknown>, nbformat: doc.nbformat ?? 4, nbformat_minor: doc.nbformat_minor ?? 5 };
}
