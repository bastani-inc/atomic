import { getKeybindings, type Keybinding } from "@bastani/atomic-tui";

/** What a terminal sends for a named key pressed alone. */
const NAMED_KEY_INPUTS: Readonly<Record<string, string>> = {
	enter: "\r",
	return: "\r",
	tab: "\t",
	space: " ",
	escape: "\x1b",
	esc: "\x1b",
	backspace: "\x7f",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	home: "\x1b[H",
	end: "\x1b[F",
	insert: "\x1b[2~",
	delete: "\x1b[3~",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
	f1: "\x1bOP",
	f2: "\x1bOQ",
	f3: "\x1bOR",
	f4: "\x1bOS",
	f5: "\x1b[15~",
	f6: "\x1b[17~",
	f7: "\x1b[18~",
	f8: "\x1b[19~",
	f9: "\x1b[20~",
	f10: "\x1b[21~",
	f11: "\x1b[23~",
	f12: "\x1b[24~",
};

/** The final byte of the cursor keys a terminal reports with modifiers as `CSI 1 ; <modifiers> <final>`. */
const CURSOR_KEY_FINALS: Readonly<Record<string, string>> = {
	up: "A",
	down: "B",
	right: "C",
	left: "D",
	home: "H",
	end: "F",
};

/** The code a terminal reports, in `CSI <code> ; <modifiers> u`, for a named key held with modifiers. */
const NAMED_KEY_CODES: Readonly<Record<string, number>> = {
	enter: 13,
	return: 13,
	tab: 9,
	space: 32,
	escape: 27,
	esc: 27,
	backspace: 127,
};

const MODIFIER_BITS: Readonly<Record<string, number>> = { shift: 1, alt: 2, ctrl: 4, super: 8 };

/**
 * What a terminal may send for `keyId`, such as `o`, `enter` or `ctrl+y`: the classic sequence first, then the
 * `CSI u` report terminals with extended key reporting send.
 */
function keyInputs(keyId: string): string[] {
	const parts = keyId.split("+");
	let key = parts.pop() ?? "";
	// `ctrl++` names the plus key.
	if (key === "" && parts.at(-1) === "") {
		parts.pop();
		key = "+";
	}
	let modifiers = 0;
	for (const part of parts) {
		const bit = MODIFIER_BITS[part.toLowerCase()];
		if (bit === undefined) return [];
		modifiers |= bit;
	}
	const named = key.toLowerCase();
	const character = [...key].length === 1 ? key : undefined;
	if (modifiers === 0) {
		const input = NAMED_KEY_INPUTS[named] ?? character;
		return input === undefined ? [] : [input];
	}
	const inputs: string[] = [];
	if (character !== undefined) {
		const lower = character.toLowerCase();
		const letter = lower >= "a" && lower <= "z";
		if (modifiers === MODIFIER_BITS.shift && letter) inputs.push(lower.toUpperCase());
		if (modifiers === MODIFIER_BITS.ctrl && letter) inputs.push(String.fromCharCode(lower.charCodeAt(0) - 96));
		if (modifiers === MODIFIER_BITS.alt) inputs.push(`\x1b${character}`);
	}
	const final = CURSOR_KEY_FINALS[named];
	if (final !== undefined) inputs.push(`\x1b[1;${modifiers + 1}${final}`);
	const code = NAMED_KEY_CODES[named] ?? character?.toLowerCase().codePointAt(0);
	if (code !== undefined) inputs.push(`\x1b[${code};${modifiers + 1}u`);
	return inputs;
}

/**
 * What the terminal sends for a key bound to `action`, so a click can press that key and take exactly the path the
 * keyboard takes, whichever key the user bound it to. Undefined when no bound key can be written as terminal input.
 */
export function rowKeyInput(action: Keybinding): string | undefined {
	const keybindings = getKeybindings();
	for (const key of keybindings.getKeys(action)) {
		const input = keyInputs(key).find((candidate) => keybindings.matches(candidate, action));
		if (input !== undefined) return input;
	}
	return undefined;
}
