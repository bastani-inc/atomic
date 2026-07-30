/**
 * `/workflow list` catalogue — rounded workflow-tool output surface.
 *
 * Visual contract:
 *  - One rounded `WORKFLOWS` panel with the registered count in the title.
 *  - One rounded card per workflow:
 *      title: workflow name
 *      row 1: muted description
 *      row 2: dim "inputs"  ·  signature
 *  - Hint rows pointing at `/workflow <name> …` and `/workflow inputs <name>`.
 *
 * Truncation policy (ui/mockups.html §4):
 *  - workflow name in tag end-truncates with `…`;
 *  - description end-truncates to the row width;
 *  - input signature renders the first 3 inputs inline, then `+N more`.
 *  - optional inputs are marked with a trailing `?`.
 *
 * cross-ref:
 *  - ui/mockups.html §3, §4 (long-description policy)
 *  - src/tui/chat-surface.ts shared primitives
 *  - src/extension/dispatcher.ts list result with `items` metadata
 */

import { chatWidth, ELLIPSIS, renderHintRows, renderRoundedBox } from "./chat-surface.js";
import { BOLD, hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";
import { truncateToWidth, visibleWidth } from "./text-helpers.js";

const INLINE_INPUT_LIMIT = 3;
const TAG_NAME_BUDGET = 50;

export interface WorkflowListEntry {
	/** Normalised workflow name — appears in the surface0 tag. */
	name: string;
	/** One-line description. End-truncated to the card body width. */
	description: string;
	/** Declared inputs in registry order. */
	inputs: ReadonlyArray<{ name: string; required?: boolean }>;
}

export interface RenderWorkflowListOpts {
	/** Provide for themed Catppuccin chrome; omit for plain ASCII. */
	theme?: GraphTheme;
	/** Render width (cells). Defaults to `process.stdout.columns`. */
	width?: number;
	/**
	 * When true, append the standard hint pair beneath the catalogue.
	 * Defaults to true.
	 */
	showHints?: boolean;
}

/**
 * Render the workflow catalogue as a rounded `WORKFLOWS` panel with
 * structured rows for each registered workflow.
 */
export function renderWorkflowList(entries: readonly WorkflowListEntry[], opts: RenderWorkflowListOpts = {}): string {
	const width = effectiveWidth(opts.width);
	const bodyWidth = Math.max(20, width - 4);
	const body: string[] = [];
	const subtitle = `${entries.length} registered`;
	const accent = opts.theme?.mauve;

	if (entries.length === 0) {
		body.push(` ${emptyState(opts.theme)} `);
	} else {
		for (let i = 0; i < entries.length; i++) {
			if (i > 0) body.push("");
			body.push(...renderWorkflowEntry(entries[i]!, { ...opts, width: bodyWidth }));
		}
	}

	if (opts.showHints !== false) {
		body.push("");
		body.push(
			...renderHintRows(
				[
					{ command: "/workflow <name> …", hint: "run a workflow" },
					{ command: "/workflow inputs <name>", hint: "inspect input schema" },
				],
				opts.theme,
			)
				.split("\n")
				.map((line) => ` ${line} `),
		);
	}

	return renderRoundedBox({
		title: `WORKFLOWS  ${subtitle}`,
		bodyLines: body,
		accent,
		theme: opts.theme,
		width,
	});
}

function renderWorkflowEntry(entry: WorkflowListEntry, opts: RenderWorkflowListOpts): string[] {
	const theme = opts.theme;
	const width = effectiveWidth(opts.width);
	const interior = Math.max(8, width - 2);
	const titleBudget = Math.max(8, Math.min(TAG_NAME_BUDGET, interior - 2));
	const title = truncateToWidth(entry.name, titleBudget, ELLIPSIS);
	const titleLine = theme ? ` ${hexToAnsi(theme.text)}${BOLD}${title}${RESET} ` : ` ${title} `;

	const descBudget = Math.max(8, interior - 4);
	const description = truncateToWidth(entry.description, descBudget, ELLIPSIS);
	const row1 = `   ${paintMuted(description, theme)} `;
	const row2 = `   ${inputsSignatureRow(entry.inputs, interior - 4, theme)} `;

	return [titleLine, row1, row2];
}

function inputsSignatureRow(
	inputs: ReadonlyArray<{ name: string; required?: boolean }>,
	interior: number,
	theme?: GraphTheme,
): string {
	const dim = theme ? hexToAnsi(theme.dim) : "";
	const text = theme ? hexToAnsi(theme.text) : "";
	const muted = theme ? hexToAnsi(theme.textMuted) : "";
	const reset = theme ? RESET : "";
	const sep = theme ? `  ${muted}·${reset}  ` : "  ·  ";
	const sepPlain = "  ·  ";

	const label = theme ? `${dim}inputs${reset}` : "inputs";
	const labelW = visibleWidth("inputs");

	if (inputs.length === 0) {
		const none = theme ? `${dim}(none)${reset}` : "(none)";
		return `${label}    ${none}`;
	}

	const visible = inputs.slice(0, INLINE_INPUT_LIMIT);
	const overflow = inputs.length - visible.length;

	// Build inline segments with optional `?` marker for optional inputs.
	const segs = visible.map((inp) => {
		const optional = inp.required !== true;
		const name = inp.name;
		if (theme) {
			return optional ? `${text}${name}${reset}${dim}?${reset}` : `${text}${name}${reset}`;
		}
		return optional ? `${name}?` : name;
	});

	let row = `${label}    ${segs.join(sep)}`;
	if (overflow > 0) {
		const moreText = `+${overflow} more`;
		if (theme) {
			row += `${sep}${dim}${moreText}${reset}`;
		} else {
			row += `${sepPlain}${moreText}`;
		}
	}

	// If the row exceeds budget, fall back to inline name list w/o decoration.
	const inlineWidth =
		labelW +
		4 +
		visible.reduce((a, b) => a + visibleWidth(b.name) + (b.required ? 0 : 1), 0) +
		Math.max(0, visible.length - 1) * visibleWidth(sepPlain) +
		(overflow > 0 ? visibleWidth(sepPlain) + visibleWidth(`+${overflow} more`) : 0);
	if (inlineWidth > interior) {
		// Drop to a single ellipsis-truncated plain join.
		const flat = inputs.map((i) => (i.required ? i.name : `${i.name}?`)).join(", ");
		const cut = truncateToWidth(flat, Math.max(8, interior - labelW - 4), ELLIPSIS);
		row = theme ? `${label}    ${text}${cut}${reset}` : `inputs    ${cut}`;
	}
	return row;
}

function paintMuted(text: string, theme?: GraphTheme): string {
	if (!theme) return text;
	return `${hexToAnsi(theme.textMuted)}${text}${RESET}`;
}

function emptyState(theme?: GraphTheme): string {
	if (!theme) return "  no workflows registered";
	return `  ${hexToAnsi(theme.dim)}no workflows registered${RESET}`;
}

/**
 * Resolve the render width for the catalogue surface. Delegates to the
 * shared `chatWidth()` helper which already accounts for the chat host's
 * 2-cell horizontal padding when no explicit width is supplied.
 */
function effectiveWidth(width?: number): number {
	return chatWidth(width);
}
