/*
 * Portions of this file are derived from:
 * - ansi-regex (https://github.com/chalk/ansi-regex)
 * - strip-ansi (https://github.com/chalk/strip-ansi)
 *
 * MIT License
 *
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

function ansiRegex({ osc = true }: { osc?: boolean } = {}): RegExp {
	// Valid string terminator sequences are BEL, ESC\, and 0x9c
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";

	// OSC sequences only: ESC ] ... ST (non-greedy until the first ST)
	const oscPattern = String.raw`(?:\u001B\][\s\S]*?${ST})`;

	// CSI and related: ESC/C1, optional intermediates, optional params (supports ; and :) then final byte
	const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";

	return new RegExp(osc ? `${oscPattern}|${csi}` : csi, "g");
}

const regex = ansiRegex();
const csiRegex = ansiRegex({ osc: false });

/** End of the final BEL/ST, or zero when no control string can be complete. */
export function controlStringTerminatorEnd(value: string): number {
	const st = value.lastIndexOf("\x1b\\");
	return Math.max(value.lastIndexOf("\x07"), value.lastIndexOf("\x9c"), st < 0 ? -1 : st + 1) + 1;
}

export function stripAnsi(value: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Expected a \`string\`, got \`${typeof value}\``);
	}

	// Fast path: ANSI codes require ESC (7-bit) or CSI (8-bit) introducer
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		return value;
	}

	// Every OSC start in this prefix has a terminator ahead, so successful
	// matches consume disjoint spans. Never retry OSC on the unterminated tail.
	// Keep the original OSC/CSI alternation and CSI fallback semantics; stripping
	// OSC first could create new ANSI matches across the removed string.
	const end = controlStringTerminatorEnd(value);
	return value.slice(0, end).replace(regex, "") + value.slice(end).replace(csiRegex, "");
}

/** C0 except LF, DEL, and C1. LF is layout; a tab is a control until a tabWidth expands it. */
const TERMINAL_CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

/** True when `text` contains a C0/C1 control other than LF. */
export function hasTerminalControls(text: string): boolean {
	return TERMINAL_CONTROL.test(text);
}

/**
 * Render C0/C1 controls as printable `\xNN` so untrusted text cannot emit live sequences.
 * Without `tabWidth`, a tab becomes `\x09` (questionnaire/preview layout). With `tabWidth`,
 * tabs expand to spaces at that stop (bordered tool boxes). LF is left as layout.
 */
export function escapeTerminalControls(text: string, options: { tabWidth?: number } = {}): string {
	if (options.tabWidth === undefined) {
		return text.replace(
			/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g,
			(control) => `\\x${control.charCodeAt(0).toString(16).padStart(2, "0")}`,
		);
	}
	const stops = Math.max(1, Math.floor(options.tabWidth));
	let out = "";
	let column = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (char === "\n") {
			out += char;
			column = 0;
			continue;
		}
		if (char === "\t") {
			const pad = stops - (column % stops);
			out += " ".repeat(pad);
			column += pad;
			continue;
		}
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			const escaped = `\\x${code.toString(16).padStart(2, "0")}`;
			out += escaped;
			column += escaped.length;
			continue;
		}
		out += char;
		column += 1;
	}
	return out;
}
