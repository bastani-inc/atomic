import { truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { singleLineDisplayText } from "../../../utils/terminal-text.ts";
import { colorEnvironment } from "../theme/color-utils.ts";
import { stripAnsi } from "./chat-session-host-utils.ts";
import { renderComposerRule } from "./composer-rule.ts";

/** Supported terminal floor for naming the session in a chat input's top rule. */
export const INPUT_LABEL_MIN_COLUMNS = 40;

/** What kind of session a chat input sends to: the recipient of an attached composer. */
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

/** `text` in bold, unless NO_COLOR or FORCE_COLOR=0 turned styles off; reads the cached color environment only. */
function emboldened(text: string): string {
	return colorEnvironment().off ? text : `${BOLD}${text}${NORMAL_INTENSITY}`;
}
const EDITOR_SUFFIX = "] ";
const EDITOR_OVERFLOW_RE = /^(─*)( [↑↓] \d+ more )(─*)$/u;

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
		styled: style.textMuted(prefix) + emboldened(style.text(shown)) + style.textMuted(suffix),
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

export interface AttachedComposerStyle {
	accent(text: string): string;
	text(text: string): string;
	dim(text: string): string;
}

const RULE = "─";
const PROMPT_GLYPH = "❯";

function stripApc(text: string): string {
	let start = text.indexOf("\x1b_");
	if (start === -1) return text;
	let out = "";
	let cursor = 0;
	while (start !== -1) {
		const end = text.indexOf("\x07", start + 2);
		if (end === -1) break;
		out += text.slice(cursor, start);
		cursor = end + 1;
		start = text.indexOf("\x1b_", cursor);
	}
	return cursor === 0 ? text : out + text.slice(cursor);
}

function trimTrailingSpaces(line: string): string {
	let sgrStart = line.length;
	while (sgrStart >= 3 && line.charCodeAt(sgrStart - 1) === 0x6d) {
		let index = sgrStart - 2;
		while (index >= 0) {
			const code = line.charCodeAt(index);
			if ((code >= 0x30 && code <= 0x39) || code === 0x3b) index--;
			else break;
		}
		if (index >= 1 && line.charCodeAt(index) === 0x5b && line.charCodeAt(index - 1) === 0x1b) {
			sgrStart = index - 1;
		} else {
			break;
		}
	}
	let spaceStart = sgrStart;
	while (spaceStart > 0 && line.charCodeAt(spaceStart - 1) === 0x20) spaceStart--;
	if (spaceStart === sgrStart) return line;
	return line.slice(0, spaceStart) + line.slice(sgrStart);
}

export function applyAttachedComposer(
	style: AttachedComposerStyle,
	label: string | undefined,
	placeholder: string | undefined,
	editorLines: readonly string[],
): string[] {
	const lines = [...editorLines];
	const cleanLabel = label === undefined ? undefined : singleLineDisplayText(label).trim();
	const cleanPlaceholder = placeholder === undefined ? undefined : singleLineDisplayText(placeholder).trim();
	const top = lines[0];
	const isRule = (line: string) => {
		const plain = stripAnsi(line);
		return /^─+$/.test(plain) || EDITOR_OVERFLOW_RE.test(plain);
	};
	let bottomIndex = lines.length - 1;
	while (bottomIndex > 0 && !isRule(lines[bottomIndex]!)) bottomIndex--;
	if (top === undefined || bottomIndex < 1) return lines;
	const width = visibleWidth(stripAnsi(top));
	const overflowNote = isRule(top) ? EDITOR_OVERFLOW_RE.exec(stripAnsi(top))?.[2] : undefined;
	if (isRule(top) && overflowNote === undefined) {
		lines[0] = renderComposerRule(width, {
			...(cleanLabel === undefined
				? {}
				: { label: { plain: cleanLabel, styled: emboldened(style.text(cleanLabel)) } }),
			color: style.accent,
		});
	} else if (isRule(top)) {
		const overflow = overflowNote;
		const shown =
			cleanLabel === undefined || width < INPUT_LABEL_MIN_COLUMNS
				? undefined
				: truncateToWidth(
						cleanLabel,
						Math.max(1, width - (overflow === undefined ? 0 : visibleWidth(overflow)) - 6),
						"…",
					);
		const tail = shown === undefined ? "" : ` ${shown} `;
		const fill = Math.max(0, width - visibleWidth(tail) - 1 - (overflow === undefined ? 0 : visibleWidth(overflow)));
		lines[0] =
			style.accent(RULE.repeat(fill)) +
			(overflow === undefined ? "" : style.dim(overflow)) +
			(shown === undefined ? "" : emboldened(style.text(tail))) +
			style.accent(
				RULE.repeat(
					Math.max(0, width - fill - visibleWidth(tail) - (overflow === undefined ? 0 : visibleWidth(overflow))),
				),
			);
	}
	const bottom = lines[bottomIndex]!;
	if (isRule(bottom)) lines[bottomIndex] = style.accent(stripAnsi(bottom));
	if (cleanPlaceholder !== undefined && bottomIndex === 2) {
		const line = lines[1]!;
		const plain = stripAnsi(stripApc(line)).trimEnd();
		if (plain === PROMPT_GLYPH || plain === `${PROMPT_GLYPH} `) {
			const trimmed = trimTrailingSpaces(line);
			const separator = trimmed.includes("\x1b_pi:fc\x07") ? "" : " ";
			const room = Math.max(0, width - visibleWidth(stripAnsi(line).trimEnd()) - separator.length - 1);
			const text = truncateToWidth(cleanPlaceholder, room, "…");
			lines[1] = `${trimmed}${separator}${style.dim(text)}`;
		}
	}
	return lines;
}
