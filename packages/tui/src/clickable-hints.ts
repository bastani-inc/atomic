/**
 * Clickable key hints. A hint such as `esc cancel` is drawn with zero-width markers around it that name what a click on
 * it runs: a key, which the renderer feeds to the input path as if it were pressed, or a slash command. The fullscreen
 * renderer strips the markers before writing a frame and remembers where each hint was painted.
 */

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
		.map((part, index, all) => {
			if (part === "" && index === all.length - 1) return "+";
			return HINT_KEY_IDS[part.toLowerCase()] ?? (part.length === 1 ? part : part.toLowerCase());
		})
		.join("+");
	return keyInputData(id as KeyId) === undefined ? undefined : (id as KeyId);
}

/**
 * A hint's key text, such as `pgup/pgdn`, `↑↓` or `esc/←`, split by key: each part keeps its text and the separator
 * after it, so the parts read as the text did, and names the key a click on it presses.
 */
export function hintKeyParts(text: string): HintKeyPart[] {
	const parts: HintKeyPart[] = [];
	let index = 0;
	while (index < text.length) {
		let token = "";
		if (ARROW_GLYPHS.has(text[index]!)) {
			token = text[index]!;
			index++;
		} else {
			while (index < text.length) {
				const char = text[index]!;
				if (char === " " || (ARROW_GLYPHS.has(char) && !token.endsWith("+"))) break;
				if (char === "/" && token !== "" && !token.endsWith("+")) break;
				token += char;
				index++;
			}
		}
		let separator = "";
		while (index < text.length && (text[index] === " " || text[index] === "/")) {
			separator += text[index];
			index++;
		}
		if (token === "") {
			if (parts.length > 0) {
				const last = parts[parts.length - 1]!;
				parts[parts.length - 1] = { ...last, text: last.text + separator };
			} else {
				parts.push({ text: separator });
			}
			continue;
		}
		const key = hintKeyId(token);
		parts.push(key === undefined ? { text: token + separator } : { text: token + separator, key });
	}
	return parts;
}

/** A hint for `keyText`, such as `pgup/pgdn`, and `label`, each key running when its text is clicked. */
export function clickableKeyTextHint(keyText: string, label: string): string {
	return clickableKeysHint(hintKeyParts(keyText), label);
}

/**
 * A hint line written as text, such as `↑↓ select · ↵ open · esc close`: each ` · `-separated segment that starts with
 * keys runs them as {@link clickableKeyTextHint} does, and one that starts with a slash command runs the command. Other
 * segments, such as a count, are drawn as they are. Style the result as a whole; the hint markers take no columns.
 */
export function clickableHintText(text: string): string {
	return text
		.split(" · ")
		.map((segment) => {
			const lead = /^\s*/.exec(segment)?.[0] ?? "";
			const body = segment.slice(lead.length);
			if (body.startsWith("/")) return lead + slashCommandHint(body);
			const words = body.split(" ");
			const keyParts: HintKeyPart[] = [];
			let index = 0;
			for (; index < words.length; index++) {
				if (words[index] === "/" && keyParts.length > 0 && index + 1 < words.length) {
					const previous = keyParts[keyParts.length - 1]!;
					keyParts[keyParts.length - 1] = { ...previous, text: `${previous.text}/ ` };
					continue;
				}
				// A number, such as the count in `2 shells`, is not a key a hint names.
				if (/^\d+$/.test(words[index]!)) break;
				const parts = hintKeyParts(words[index]!);
				if (parts.length === 0 || parts.some((part) => part.key === undefined)) break;
				keyParts.push(
					...parts.map((part, at) => (at === parts.length - 1 ? { ...part, text: `${part.text} ` } : part)),
				);
			}
			if (keyParts.length === 0) return segment;
			const last = keyParts[keyParts.length - 1]!;
			keyParts[keyParts.length - 1] = { ...last, text: last.text.slice(0, -1) };
			const label = words.slice(index).join(" ");
			return lead + clickableKeysHint(keyParts, label ? ` ${label}` : "");
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
