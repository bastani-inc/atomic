/**
 * Clickable key hints. A hint such as `esc cancel` is drawn with zero-width markers around it that name what a click on
 * it runs: a key, which the renderer feeds to the input path as if it were pressed, or a slash command. The fullscreen
 * renderer strips the markers before writing a frame and remembers where each hint was painted.
 */

import { CORE_COMMAND_NAMES } from "./builtin-command-names.ts";
import { getKeybindings, type KeybindingsManager } from "./keybindings.ts";
import { type KeyId, keyInputData } from "./keys.ts";
import { extractAnsiCode, HINT_CLOSE, HINT_OPEN, visibleWidth } from "./utils.ts";

/** What a click on a hint runs: a key, exactly as if it were pressed, or a slash command such as `/tasks`. */
export type HintAction =
	| { readonly kind: "key"; readonly key: KeyId }
	| { readonly kind: "command"; readonly command: string };

/** Where a hint was painted on a row, in columns `[start, end)`, and what a click on it runs. */
export interface HintSpan {
	readonly start: number;
	readonly end: number;
	readonly action: HintAction;
}

/** One key a hint names, and the text that names it, such as `pgup/` for the first key of `pgup/pgdn`. */
export interface HintKeyPart {
	readonly text: string;
	readonly key?: KeyId;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export function keyHintAction(key: KeyId): HintAction {
	return { kind: "key", key };
}

export function commandHintAction(command: string): HintAction {
	return { kind: "command", command };
}

function encodeAction(action: HintAction): string {
	const payload = action.kind === "key" ? `k:${action.key}` : `c:${action.command}`;
	return payload.replace(CONTROL_CHARACTERS, "");
}

function decodeAction(payload: string): HintAction | undefined {
	const value = payload.slice(2);
	if (value === "") return undefined;
	if (payload.startsWith("k:")) return { kind: "key", key: value as KeyId };
	if (payload.startsWith("c:")) return { kind: "command", command: value };
	return undefined;
}

/**
 * `text` marked as a hint that a click runs `action`. The markers take no columns, so widths, truncation and wrapping
 * are unchanged; text with no action is returned as it is.
 */
export function clickableHint(text: string, action: HintAction | undefined): string {
	if (action === undefined || text === "") return text;
	return `${HINT_OPEN}${encodeAction(action)}\x07${text}${HINT_CLOSE}`;
}

/**
 * A hint naming one or more keys, such as `pgup/pgdn scroll`: the text of each key runs that key, and `label` runs the
 * last one, so a hint that names two keys acts by the half clicked. A part with no key is drawn without an action.
 */
export function clickableKeysHint(parts: readonly HintKeyPart[], label = ""): string {
	if (parts.length === 0) return label;
	return parts
		.map((part, index) =>
			clickableHint(
				index === parts.length - 1 ? part.text + label : part.text,
				part.key === undefined ? undefined : keyHintAction(part.key),
			),
		)
		.join("");
}

const ARROW_GLYPHS = new Set(["↑", "↓", "←", "→"]);
const CORE_COMMANDS = new Set<string>(CORE_COMMAND_NAMES);
const bundledCommandLookups = new WeakMap<KeybindingsManager, (name: string) => boolean>();

/** Resolve bundled command hints against the live registrations of the session that owns these bindings. */
export function bindBundledHintCommands(bindings: KeybindingsManager, isRegistered: (name: string) => boolean): void {
	bundledCommandLookups.set(bindings, isRegistered);
}

/** Key names a hint shows, by the key id they stand for. */
const HINT_KEY_IDS: Record<string, string> = {
	"↑": "up",
	"↓": "down",
	"←": "left",
	"→": "right",
	esc: "escape",
	"↵": "enter",
	return: "enter",
	pgup: "pageUp",
	pgdn: "pageDown",
	pageup: "pageUp",
	pagedown: "pageDown",
	del: "delete",
	control: "ctrl",
	option: "alt",
};

/** The key id a hint's name for a key stands for, such as `pageUp` for `pgup`; undefined when no key is named. */
export function hintKeyId(name: string): KeyId | undefined {
	const id = name
		.split("+")
		.map((part) => HINT_KEY_IDS[part.toLowerCase()] ?? (part.length === 1 ? part : part.toLowerCase()))
		.join("+");
	return keyInputData(id as KeyId) === undefined ? undefined : (id as KeyId);
}

/**
 * A hint's key text, such as `pgup/pgdn`, `↑↓` or `esc/←`, split by key: each part keeps its text and the separator
 * after it, so the parts read as the text did, and names the key a click on it presses.
 */
export function hintKeyParts(text: string): HintKeyPart[] {
	return parseHintKeys(text).parts;
}

function hintSpace(char: string | undefined, wholeLine: boolean): boolean {
	return (
		char === " " || (wholeLine && (char === "\t" || (char !== undefined && char >= "\u00a0" && /\p{Zs}/u.test(char))))
	);
}

function hintTokenAt(text: string, start: number, wholeLine: boolean): string {
	if (ARROW_GLYPHS.has(text[start]!)) return text[start]!;
	let end = start;
	// No recognized key exceeds `control+option+shift+super+backspace`. One more character proves this
	// speculative token is label text. Explicit key parts, on the other hand, must retain unknown tokens whole.
	const limit = wholeLine ? Math.min(text.length, start + 37) : text.length;
	for (; end < limit; end++) {
		const char = text[end]!;
		const expectsKey = end - start > 1 && text[end - 1] === "+" && text[end - 2] !== "+";
		if (hintSpace(char, wholeLine) || (ARROW_GLYPHS.has(char) && !expectsKey)) break;
		if (char === "/" && end !== start && !expectsKey) break;
	}
	return text.slice(start, end);
}

const DIGIT_RANGE = /^[1-9]-[1-9]$/;

function parseHintKeys(
	text: string,
	bindings?: readonly KeyId[],
	numericList = false,
): { parts: HintKeyPart[]; label: string } {
	const parts: HintKeyPart[] = [];
	const wholeLine = bindings !== undefined;
	// Whole-line parsing is speculative: an invalid member invalidates its entire compact shortcut, not just its tail.
	let groupStart = 0;
	let groupPart = 0;
	let afterSlash = false;
	let crossedHorizontalSpace = false;
	let index = 0;
	while (index < text.length) {
		const start = index;
		if (!afterSlash && hintSpace(text[start - 1], wholeLine)) {
			groupStart = start;
			groupPart = parts.length;
		}
		let token = hintTokenAt(text, index, wholeLine);
		index += token.length;
		const end = index;
		while (hintSpace(text[index], wholeLine)) index++;
		if (token !== "" && text[index] === "/") {
			let next = index + 1;
			while (hintSpace(text[next], wholeLine)) next++;
			// In `esc / enter` this slash separates keys; in `esc /` the final slash is a key itself.
			const following = index === end ? undefined : hintTokenAt(text, next, wholeLine);
			if (following === undefined || DIGIT_RANGE.test(following) || hintKeyId(following) !== undefined) index = next;
		}
		const separator = text.slice(end, index);
		// A named key needs no binding lookup. Don't start looking up bare letters in previously inert prose
		// merely because a tab or Unicode space was recognized (e.g. `a destination` or `esc a destination`).
		const inferBare =
			numericList || (!crossedHorizontalSpace && (text[end] === " " || !hintSpace(text[end], wholeLine)));
		if (wholeLine && /[^ /]/.test(separator)) crossedHorizontalSpace = true;
		if (token === "") {
			if (parts.length > 0) {
				const last = parts[parts.length - 1]!;
				parts[parts.length - 1] = { ...last, text: last.text + separator };
			} else {
				parts.push({ text: separator });
			}
			continue;
		}
		// In a numbered picker, `1-4` shows two keys: the dash belongs to the first, the label to the last.
		if (DIGIT_RANGE.test(token) && (!bindings || (inferBare && bindings.includes(token[0] as KeyId)))) {
			parts.push({ text: token.slice(0, 2), key: token[0] as KeyId });
			token = token[2]!;
		}
		const key = hintKeyId(token);
		if (
			bindings &&
			!(key && (key.length > 1 || (inferBare && bindings.includes(key)) || (key === "/" && parts.length > 0)))
		) {
			// `esc / a destination`: we now know that `a` starts the label rather than naming a key. The
			// provisional separator between the two spaces is itself the last key. Don't read the binding twice.
			if (numericList && /^\d$/.test(token)) return { parts: [], label: text };
			if (afterSlash && key?.length === 1) {
				const last = parts[parts.length - 1]!;
				const slash = last.text.lastIndexOf("/");
				if (hintSpace(last.text[slash - 1], true) && hintSpace(last.text[slash + 1], true)) {
					parts[parts.length - 1] = { ...last, text: last.text.slice(0, slash) };
					parts.push({ text: last.text.slice(slash), key: "/" });
					return { parts, label: text.slice(start) };
				}
			}
			return { parts: parts.slice(0, groupPart), label: text.slice(groupStart) };
		}
		afterSlash = separator.includes("/");
		parts.push(key === undefined ? { text: token + separator } : { text: token + separator, key });
	}
	return bindings && afterSlash
		? { parts: parts.slice(0, groupPart), label: text.slice(groupStart) }
		: { parts, label: "" };
}

/** Does the slash after a numeric prefix continue a complete list containing a named key? No binding reads here:
 * a ratio followed by ordinary text (even `esc/not-a-key`) must stay inert without consulting caller code. */
function hasMixedKeySuffix(text: string, start: number): boolean {
	let named = false;
	let index = start;
	while (index < text.length) {
		while (hintSpace(text[index], true)) index++;
		const token = hintTokenAt(text, index, true);
		const key = hintKeyId(token);
		if (key === undefined && !DIGIT_RANGE.test(token)) return false;
		if (key && key.length > 1) named = true;
		index += token.length;
		const end = index;
		while (hintSpace(text[index], true)) index++;
		if (text[index] === "/") index++;
		else if (index === text.length || index !== end) return named;
		else if (!ARROW_GLYPHS.has(text[index]!)) return false;
	}
	return false; // a trailing separator is not another named key
}

/** A hint for `keyText`, such as `pgup/pgdn`, and `label`, each key running when its text is clicked. */
export function clickableKeyTextHint(keyText: string, label: string): string {
	return clickableKeysHint(hintKeyParts(keyText), label);
}

/**
 * A hint line written as text, such as `↑↓ select · ↵ open · esc close`: each ` · `-separated segment that starts with
 * a complete named key (or a modified key) runs it. Bare letters, digits and punctuation must be listed in `bindings`,
 * except a literal slash following a recognized key. Every member of a compact shortcut must be recognized. Numeric
 * ratios stay plain even with digit bindings. Use {@link clickableKeyTextHint} when the key text is known separately.
 * Built-in slash commands such as `/tasks to manage` run the command. Use {@link slashCommandHint} for custom commands.
 */
export function clickableHintText(text: string): string;
export function clickableHintText(text: string, bindings: readonly KeyId[]): string;
export function clickableHintText(text: string, bindings?: readonly KeyId[]): string {
	// Passing the one-argument builder to Array.map supplies a numeric index, not a binding list.
	const configured = Array.isArray(bindings) ? bindings : [];
	return text
		.split(" · ")
		.map((segment) => {
			const lead = /^\s*/.exec(segment)?.[0] ?? "";
			const body = segment.slice(lead.length);
			const command = /^\/([\w:-]+)(?:\s|$)/.exec(body)?.[1];
			if (command && (CORE_COMMANDS.has(command) || bundledCommandLookups.get(getKeybindings())?.(command))) {
				return lead + slashCommandHint(body);
			}
			const ratio = /^(\d+(?:\s*\/\s*\d+)+)(?:([\t\p{Zs}]+\/)|(?=\s|$))/u.exec(body);
			if (
				ratio &&
				(!ratio[2] || /\d\d|[^\d/\t\p{Zs}]/u.test(ratio[1]!) || !hasMixedKeySuffix(body, ratio[0].length))
			) {
				return segment;
			}
			const { parts, label } = parseHintKeys(body, configured, ratio !== null);
			return lead + clickableKeysHint(parts, label);
		})
		.join(" · ");
}

/** A hint naming a slash command, such as `/tasks to manage`, that runs the command when clicked. */
export function slashCommandHint(text: string): string {
	const command = /^\/[\w:-]+/.exec(text)?.[0];
	return command === undefined ? text : clickableHint(text, commandHintAction(command));
}

/** Whether `line` has hint markers. */
export function hasHintMarkers(line: string): boolean {
	return line.includes(HINT_OPEN) || line.includes(HINT_CLOSE);
}

/** `line` without its hint markers. */
export function stripHintMarkers(line: string): string {
	return hasHintMarkers(line) ? readHintSpans(line).line : line;
}

/**
 * `line` without its hint markers, and the columns each marked hint covers. A hint whose closing marker was cut off,
 * by truncation for example, ends at the end of the line; a closing marker whose opening one was cut off is dropped.
 */
export function readHintSpans(line: string): { readonly line: string; readonly spans: readonly HintSpan[] } {
	if (!hasHintMarkers(line)) return { line, spans: [] };
	const spans: HintSpan[] = [];
	let text = "";
	let column = 0;
	let open: { start: number; action: HintAction | undefined } | undefined;
	const close = () => {
		if (open?.action !== undefined && column > open.start)
			spans.push({ start: open.start, end: column, action: open.action });
		open = undefined;
	};
	let index = 0;
	while (index < line.length) {
		const ansi = line.charCodeAt(index) === 0x1b ? extractAnsiCode(line, index) : null;
		if (ansi) {
			index += ansi.length;
			if (ansi.code.startsWith(HINT_OPEN)) {
				close();
				const payload = ansi.code.slice(HINT_OPEN.length).replace(/(?:\x07|\x1b\\)$/, "");
				open = { start: column, action: decodeAction(payload) };
			} else if (ansi.code === HINT_CLOSE) {
				close();
			} else {
				text += ansi.code;
			}
			continue;
		}
		let next = line.indexOf("\x1b", index + 1);
		if (next === -1) next = line.length;
		const chunk = line.slice(index, next);
		text += chunk;
		column += visibleWidth(chunk);
		index = next;
	}
	close();
	return { line: text, spans };
}

/**
 * `line` with the hints that press a key `drop` accepts drawn as plain text, so a click on their text reaches whatever
 * draws them. Their text, its style and every other hint stay as they are, in the same columns.
 */
export function withoutKeyHints(line: string, drop: (key: KeyId) => boolean): string {
	if (!line.includes(HINT_OPEN)) return line;
	let kept = "";
	let index = 0;
	while (index < line.length) {
		const next = line.indexOf("\x1b", index);
		if (next === -1) {
			kept += line.slice(index);
			break;
		}
		kept += line.slice(index, next);
		const ansi = extractAnsiCode(line, next);
		if (!ansi) {
			kept += "\x1b";
			index = next + 1;
			continue;
		}
		index = next + ansi.length;
		if (ansi.code.startsWith(HINT_OPEN)) {
			const action = decodeAction(ansi.code.slice(HINT_OPEN.length).replace(/(?:\x07|\x1b\\)$/, ""));
			// An opening marker also ends the hint before it, as a closing marker in its place does; the dropped
			// hint's own closing marker then closes nothing.
			if (action?.kind === "key" && drop(action.key)) {
				kept += HINT_CLOSE;
				continue;
			}
		}
		kept += ansi.code;
	}
	return kept;
}

/** The action of the hint painted at `column`, among a row's `spans`. */
export function hintActionAt(spans: readonly HintSpan[] | undefined, column: number): HintAction | undefined {
	return spans?.find((span) => column >= span.start && column < span.end)?.action;
}

let hintActivationDepth = 0;

/**
 * Whether the input being handled was sent by a click on a key hint. A key that acts only on an empty prompt, such as
 * `?` for the keys of a screen, acts for a click whatever the prompt holds: a click cannot be typing.
 */
export function isHintActivation(): boolean {
	return hintActivationDepth > 0;
}

/** Run `handle` as the input of a click on a key hint; see {@link isHintActivation}. */
export function runAsHintActivation<T>(handle: () => T): T {
	hintActivationDepth++;
	try {
		return handle();
	} finally {
		hintActivationDepth--;
	}
}

/** The terminal input a click on a key hint sends for `action`, or undefined for a command or an unknown key. */
export function hintKeyInput(action: HintAction): string | undefined {
	return action.kind === "key" ? keyInputData(action.key) : undefined;
}
