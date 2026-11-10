import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

/** `prefix`, `name` truncated with an ellipsis to `maxNameWidth` columns, then `suffix`; nothing when no column fits. */
export function buildInputLabel(
	style: InputLabelStyle,
	name: string,
	maxNameWidth: number,
	prefix: string,
	suffix: string,
): InputLabel | undefined {
	if (maxNameWidth < 1) return undefined;
	const shown = visibleWidth(name) <= maxNameWidth ? name : truncateToWidth(name, maxNameWidth, "…");
	return {
		plain: prefix + shown + suffix,
		styled: style.textMuted(prefix) + BOLD + style.text(shown) + NORMAL_INTENSITY + style.textMuted(suffix),
	};
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
	const label = buildInputLabel(style, name, maxNameWidth, prefix, EDITOR_SUFFIX);
	if (label === undefined) return undefined;
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
 * indicator stays; later rules never are. A rule that is labeled already, or narrower than
 * {@link INPUT_LABEL_MIN_COLUMNS}, is left as it is; draft text that names a label does not count as one.
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
	if (plain.includes(inputLabelMarker(kind))) return lines;
	const overflow = EDITOR_OVERFLOW_RE.exec(plain)?.[2];
	if (!/^─+$/.test(plain) && overflow === undefined) return lines;
	const decorated = decorateEditorTopLine(style, kind, name, topLine, plain, overflow);
	if (decorated !== undefined) lines[0] = decorated;
	return lines;
}
