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

export interface IdentifierLine {
	prefix: string;
	chunk: string;
}

/**
 * Hard-wrap an identifier without changing any of its characters. Prefixes
 * count against each row's visible-cell budget, but are not part of the id.
 */
export function wrapIdentifierLines(
	id: string,
	width: number,
	firstPrefix: string,
	continuationPrefix: string,
): IdentifierLine[] {
	const rows: IdentifierLine[] = [];
	let remaining = id;
	let first = true;
	while (remaining.length > 0 || rows.length === 0) {
		const prefix = first ? firstPrefix : continuationPrefix;
		const budget = Math.max(1, width - visibleWidth(prefix));
		let chunk = "";
		for (const character of remaining) {
			if (chunk.length > 0 && visibleWidth(`${chunk}${character}`) > budget) break;
			chunk += character;
		}
		if (chunk.length === 0) chunk = remaining[0] ?? "";
		rows.push({ prefix, chunk });
		remaining = remaining.slice(chunk.length);
		first = false;
	}
	return rows;
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
	const chunks = wrapIdentifierLines(opts.runId, availableWidth, idPrefix, continuationPrefix);
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

	const rows = chunks.map((chunk, index) => {
		if (index > 0) return `${chunk.prefix}${id(chunk.chunk)}`;
		return `${" ".repeat(idIndent)}${glyph}${" ".repeat(idGap)}${id(chunk.chunk)}`;
	});
	rows.push(`${" ".repeat(nameIndent)}${name}${meta}`);
	return rows;
}
