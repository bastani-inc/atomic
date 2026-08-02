/** Shared two-row run identity rendering for workflow cards and attribution banners. */

import { BOLD, hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { visibleWidth } from "./text-helpers.js";

export interface RunIdentityRowsOpts {
	/** Full run UUID; this value is never shortened. */
	readonly runId: string;
	/** Workflow display name shown on the second row. */
	readonly name: string;
	/** Optional metadata appended to the workflow name. */
	readonly meta?: string;
	/** Status glyph shown on the first row. */
	readonly glyph: string;
	/** Hex colour for the status glyph in themed output. */
	readonly glyphColor?: string;
	/** Hex colour for metadata in themed output. */
	readonly metaColor?: string;
	/** Omit for plain output. */
	readonly theme?: GraphTheme;
	/** Visible width available to the identity rows. Omit to disable wrapping. */
	readonly width?: number;
	/** Leading spaces before the glyph. Defaults to the widget's three cells. */
	readonly idIndent?: number;
	/** Spaces between the glyph and the full run id. Defaults to two cells. */
	readonly idGap?: number;
	/** Leading spaces before the workflow name. Defaults to five cells. */
	readonly nameIndent?: number;
}

interface IdentifierChunk {
	readonly text: string;
	readonly first: boolean;
}

function splitIdentifier(id: string, width: number, prefixWidth: number): IdentifierChunk[] {
	if (width === Number.POSITIVE_INFINITY) return [{ text: id, first: true }];

	const chunks: IdentifierChunk[] = [];
	let remaining = id;
	let first = true;
	while (remaining.length > 0 || chunks.length === 0) {
		const budget = Math.max(1, width - (first ? prefixWidth : Math.max(0, prefixWidth - 1)));
		let end = 0;
		for (const character of remaining) {
			if (end > 0 && visibleWidth(remaining.slice(0, end) + character) > budget) break;
			end += character.length;
		}
		if (end === 0) end = remaining[0]?.length ?? 1;
		chunks.push({ text: remaining.slice(0, end), first });
		remaining = remaining.slice(end);
		first = false;
	}
	return chunks;
}

/**
 * Render the canonical identity shape shared by the background widget and
 * awaiting-input attribution banner. The caller supplies the status glyph so
 * surfaces can preserve their existing run-state semantics.
 */
export function renderRunIdentityRows(opts: RunIdentityRowsOpts): string[] {
	const idIndent = Math.max(0, opts.idIndent ?? 3);
	const idGap = Math.max(0, opts.idGap ?? 2);
	const nameIndent = Math.max(0, opts.nameIndent ?? 5);
	const idPrefix = `${" ".repeat(idIndent)}${opts.glyph}${" ".repeat(idGap)}`;
	const continuationPrefix = " ".repeat(Math.max(0, idIndent + idGap - 1));
	const availableWidth = opts.width === undefined ? Number.POSITIVE_INFINITY : Math.max(1, opts.width);
	const chunks = splitIdentifier(opts.runId, availableWidth, visibleWidth(idPrefix));
	const themed = opts.theme !== undefined;
	const glyph = themed ? `${hexToAnsi(opts.glyphColor ?? opts.theme.text)}${opts.glyph}${RESET}` : opts.glyph;
	const id = themed ? (text: string) => `${hexToAnsi(opts.theme!.accent)}${text}${RESET}` : (text: string) => text;
	const name = themed ? `${hexToAnsi(opts.theme.text)}${BOLD}${opts.name}${RESET}` : opts.name;
	const metaColor = opts.metaColor ?? opts.theme?.dim;
	const meta =
		themed && opts.meta !== undefined && opts.meta.length > 0
			? ` · ${hexToAnsi(metaColor ?? opts.theme.textMuted)}${opts.meta}${RESET}`
			: opts.meta !== undefined && opts.meta.length > 0
				? ` · ${opts.meta}`
				: "";

	const rows = chunks.map((chunk) => {
		if (!chunk.first) return `${continuationPrefix}${id(chunk.text)}`;
		return `${" ".repeat(idIndent)}${glyph}${" ".repeat(idGap)}${id(chunk.text)}`;
	});
	rows.push(`${" ".repeat(nameIndent)}${name}${meta}`);
	return rows;
}
