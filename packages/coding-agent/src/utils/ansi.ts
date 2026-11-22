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

import { terminalDisplayText } from "./terminal-text.ts";

// CSI and related: ESC/C1, optional intermediates, optional params (supports ; and :), then final byte.
// A private prefix (<, =, >) is accepted only right after a real CSI introducer (ESC [ or 0x9B), so
// ESC[<35;59;1M (SGR mouse report) is stripped whole. After a bare ESC these bytes stay final bytes:
// ESC = and ESC > (keypad modes) must not swallow the digits of the text that follows.
const CSI_START = "(?:(?:\\u001B\\[|\\u009B)[<=>]|[\\u001B\\u009B][[\\]()#;?]*)(?:\\d{1,4}(?:[;:]\\d{0,4})*)?";
const CSI_FINAL = "[\\dA-PR-TZcf-nq-uy=><~]";
const CSI_STICKY = new RegExp(`${CSI_START}${CSI_FINAL}`, "y");

// Valid string terminator sequences are BEL (0x07), ESC\ (0x1B 0x5C), and 0x9C.
function findOscTerminatorEnd(value: string, fromIndex: number): number {
	for (let i = fromIndex; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code === 0x07 || code === 0x9c) return i + 1;
		if (code === 0x1b && i + 1 < value.length && value.charCodeAt(i + 1) === 0x5c) return i + 2;
	}
	return -1;
}

export function stripAnsi(value: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Expected a \`string\`, got \`${typeof value}\``);
	}

	let nextEsc = value.indexOf("\u001B");
	let nextCsi8 = value.indexOf("\u009B");
	// Fast path: ANSI codes require ESC (7-bit) or CSI (8-bit) introducer
	if (nextEsc === -1 && nextCsi8 === -1) {
		return value;
	}

	let output = "";
	let copied = 0;
	let pos = 0;
	let noOscSt = false;
	while (pos < value.length) {
		if (nextEsc !== -1 && nextEsc < pos) nextEsc = value.indexOf("\u001B", pos);
		if (nextCsi8 !== -1 && nextCsi8 < pos) nextCsi8 = value.indexOf("\u009B", pos);
		if (nextEsc === -1 && nextCsi8 === -1) break;
		pos = nextEsc === -1 ? nextCsi8 : nextCsi8 === -1 ? nextEsc : Math.min(nextEsc, nextCsi8);

		if (value.charCodeAt(pos) === 0x1b && pos + 1 < value.length && value.charCodeAt(pos + 1) === 0x5d) {
			if (!noOscSt) {
				const stEnd = findOscTerminatorEnd(value, pos + 2);
				if (stEnd !== -1) {
					output += value.slice(copied, pos);
					copied = stEnd;
					pos = stEnd;
					continue;
				}
				noOscSt = true;
			}
		}

		CSI_STICKY.lastIndex = pos;
		if (CSI_STICKY.exec(value) !== null) {
			output += value.slice(copied, pos);
			copied = CSI_STICKY.lastIndex;
			pos = copied;
			continue;
		}
		pos++;
	}
	return copied === 0 ? value : `${output}${value.slice(copied)}`;
}

/**
 * Make text that is rendered as content inert for the terminal: remove escape sequences (7-bit and 8-bit) with their
 * payloads and the remaining control characters, keeping newlines and tabs, and show bidirectional overrides escaped.
 */
export function stripTerminalControls(value: string): string {
	return terminalDisplayText(value);
}
