import { truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { stripAnsi } from "./chat-session-host-utils.ts";

/** Supported terminal floor for naming the session in a chat input's top rule. */
export const INPUT_LABEL_MIN_COLUMNS = 40;

/** What kind of session a chat input sends to: an attached workflow stage, or a subagent. */
export type InputLabelKind = "stage" | "subagent";

/** Colours of a label: the brackets and kind are muted, the name is bold in the text colour. */
export interface InputLabelStyle {
	textMuted(text: string): string;
	text(text: string): string;
}

/** A label for a rule: its plain text, for measuring, and its styled text. */
export interface InputLabel {
	readonly plain: string;
	readonly styled: string;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const NORMAL_INTENSITY = "\x1b[22m";
const EDITOR_SUFFIX = "] ";
const EDITOR_OVERFLOW_RE = /^(─*)( ↑ \d+ more )(─*)$/;

/** The text that opens a `kind` label, such as `[stage:`; a line containing it is labeled already. */
export function inputLabelMarker(kind: InputLabelKind): string {
	return `[${kind}:`;
}

/** The colour a rendered rule opens with, so a label's fill continues in it. */
export function ruleOpenColor(line: string): string {
	return line.match(/^(\x1b\[[0-9;]*m)/)?.[1] ?? "";
}

function inputLabel(
	style: InputLabelStyle,
	name: string,
	maxNameWidth: number,
	prefix: string,
	suffix: string,
): InputLabel {
	const shown = truncateToWidth(name, maxNameWidth, "…");
	return {
		plain: prefix + shown + suffix,
		styled: style.textMuted(prefix) + BOLD + style.text(shown) + NORMAL_INTENSITY + style.textMuted(suffix),
	};
}

/** `prefix`, `name` truncated with an ellipsis to `maxNameWidth` columns, then `suffix`; nothing when no column fits. */
export function buildInputLabel(
	style: InputLabelStyle,
	name: string,
	maxNameWidth: number,
	prefix: string,
	suffix: string,
): InputLabel | undefined {
	return maxNameWidth < 1 ? undefined : inputLabel(style, name, maxNameWidth, prefix, suffix);
}

function decorateEditorTopLine(
	style: InputLabelStyle,
	kind: InputLabelKind,
	name: string,
	line: string,
	plain: string,
	overflow: string | undefined,
): string | undefined {
	const width = visibleWidth(plain);
	if (width < INPUT_LABEL_MIN_COLUMNS) return undefined;
	const prefix = `${inputLabelMarker(kind)} `;
	const overflowWidth = overflow === undefined ? 0 : visibleWidth(overflow);
	const maxNameWidth = Math.max(1, width - overflowWidth - visibleWidth(prefix) - visibleWidth(EDITOR_SUFFIX) - 2);
	const label = inputLabel(style, name, maxNameWidth, prefix, EDITOR_SUFFIX);
	const labelWidth = visibleWidth(label.plain);
	if (labelWidth + overflowWidth >= width) return undefined;
	const fillWidth = width - labelWidth - overflowWidth;
	const openColor = ruleOpenColor(line);
	if (overflow === undefined) return openColor + RESET + label.styled + openColor + "─".repeat(fillWidth) + RESET;
	const leftFill = Math.floor(fillWidth / 2);
	return (
		openColor +
		RESET +
		label.styled +
		openColor +
		"─".repeat(leftFill) +
		overflow +
		"─".repeat(fillWidth - leftFill) +
		RESET
	);
}

/**
 * Names the session a chat input sends to in the editor's top rule, as `[kind: name]`. Call it on the editor's
 * rendered lines: decorating the rule while the editor renders would stop it recognising the rule as a border and
 * put the `❯` prompt on it. Only the first line is decorated, a plain `─` rule or a scrolled `↑ N more` rule, whose
 * indicator stays; later rules never are. A labeled rule is no longer plain, so it is never labeled twice, and draft
 * text that names a label does not count as one. A rule narrower than {@link INPUT_LABEL_MIN_COLUMNS} is left as it is.
 */
export function applyInputLabelToEditorTopRule(
	style: InputLabelStyle,
	kind: InputLabelKind,
	name: string | undefined,
	editorLines: readonly string[],
): string[] {
	const lines = [...editorLines];
	const topLine = lines[0];
	if (!name || topLine === undefined) return lines;
	const plain = stripAnsi(topLine);
	const overflow = EDITOR_OVERFLOW_RE.exec(plain)?.[2];
	if (!/^─+$/.test(plain) && overflow === undefined) return lines;
	const decorated = decorateEditorTopLine(style, kind, name, topLine, plain, overflow);
	if (decorated !== undefined) lines[0] = decorated;
	return lines;
}

/** Colours of an attached composer: its rules in the accent, its label bold, its placeholder dim. */
export interface AttachedComposerStyle {
	accent(text: string): string;
	text(text: string): string;
	dim(text: string): string;
}

const HEAVY_RULE = "━";
const PROMPT_GLYPH = "❯";

/**
 * The composer of a chat attached to a subagent or a workflow stage, so it never reads as the main chat's: heavy accent
 * rules above and below the prompt, the top one ending in `label` (`debugger · #5220 spawn lock · 18m`), and, while
 * nothing is typed, `placeholder` (`Message debugger…`) after the cursor. Call it on the editor's rendered lines. A
 * plain or scrolled rule is replaced; any other first or last line is left as it is. Terminals narrower than
 * {@link INPUT_LABEL_MIN_COLUMNS} keep the heavy rules without the label.
 */
export function applyAttachedComposer(
	style: AttachedComposerStyle,
	label: string | undefined,
	placeholder: string | undefined,
	editorLines: readonly string[],
): string[] {
	const lines = [...editorLines];
	const top = lines[0];
	const isRule = (line: string) => {
		const plain = stripAnsi(line);
		return /^─+$/.test(plain) || EDITOR_OVERFLOW_RE.test(plain);
	};
	// The editor may render rows below its bottom rule (an autocomplete list); the bottom rule is the last rule.
	let bottomIndex = lines.length - 1;
	while (bottomIndex > 0 && !isRule(lines[bottomIndex]!)) bottomIndex--;
	if (top === undefined || bottomIndex < 1) return lines;
	const width = visibleWidth(stripAnsi(top));
	if (isRule(top)) {
		const overflow = EDITOR_OVERFLOW_RE.exec(stripAnsi(top))?.[2];
		const shown =
			label === undefined || width < INPUT_LABEL_MIN_COLUMNS
				? undefined
				: truncateToWidth(
						label,
						Math.max(1, width - (overflow === undefined ? 0 : visibleWidth(overflow)) - 6),
						"…",
					);
		const tail = shown === undefined ? "" : ` ${shown} `;
		const fill = Math.max(0, width - visibleWidth(tail) - 1 - (overflow === undefined ? 0 : visibleWidth(overflow)));
		lines[0] =
			style.accent(HEAVY_RULE.repeat(fill)) +
			(overflow === undefined ? "" : style.dim(overflow)) +
			(shown === undefined ? "" : `${BOLD}${style.text(tail)}${NORMAL_INTENSITY}`) +
			style.accent(
				HEAVY_RULE.repeat(
					Math.max(0, width - fill - visibleWidth(tail) - (overflow === undefined ? 0 : visibleWidth(overflow))),
				),
			);
	}
	const bottom = lines[bottomIndex]!;
	if (isRule(bottom)) lines[bottomIndex] = style.accent(HEAVY_RULE.repeat(visibleWidth(stripAnsi(bottom))));
	if (placeholder !== undefined && bottomIndex === 2) {
		const line = lines[1]!;
		const plain = stripAnsi(line).trimEnd();
		if (plain === PROMPT_GLYPH || plain === `${PROMPT_GLYPH} `) {
			const room = Math.max(0, width - visibleWidth(stripAnsi(line).trimEnd()) - 2);
			const text = truncateToWidth(placeholder, room, "…");
			const trimmed = line.replace(/ +(\x1b\[[0-9;]*m)*$/, "$1");
			lines[1] = `${trimmed} ${style.dim(text)}`;
		}
	}
	return lines;
}
