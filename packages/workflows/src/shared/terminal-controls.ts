const ESC = 0x1b;
const BEL = 0x07;
const DEL = 0x7f;
const CSI_8BIT = 0x9b;
const OSC_8BIT = 0x9d;
const DCS_8BIT = 0x90;
const SOS_8BIT = 0x98;
const ST_8BIT = 0x9c;
const PM_8BIT = 0x9e;
const APC_8BIT = 0x9f;

function isC0(code: number): boolean {
	return code <= 0x1f || code === DEL;
}

function isC1(code: number): boolean {
	return code >= 0x80 && code <= 0x9f;
}

function skipStringControl(message: string, start: number, osc: boolean): number {
	for (let i = start; i < message.length; i++) {
		const code = message.charCodeAt(i);
		if (osc && code === BEL) return i + 1;
		if (code === ST_8BIT) return i + 1;
		if (code === ESC && message.charCodeAt(i + 1) === 0x5c) return i + 2;
	}
	return message.length;
}

function skipCsi(message: string, start: number): number {
	for (let i = start; i < message.length; i++) {
		const code = message.charCodeAt(i);
		if (code >= 0x40 && code <= 0x7e) return i + 1;
	}
	return message.length;
}

function skipEscSequence(message: string, start: number): number {
	if (start >= message.length) return start;
	const next = message.charCodeAt(start);
	if (next === 0x5b) return skipCsi(message, start + 1);
	if (next === 0x5d) return skipStringControl(message, start + 1, true);
	if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
		return skipStringControl(message, start + 1, false);
	}
	let i = start;
	while (i < message.length) {
		const code = message.charCodeAt(i);
		if (code >= 0x20 && code <= 0x2f) {
			i += 1;
			continue;
		}
		return i + 1;
	}
	return message.length;
}

export function stripTerminalSequences(message: string, preserveControlCharacters = false): string {
	let out = "";
	for (let i = 0; i < message.length; ) {
		const code = message.charCodeAt(i);
		if (code === ESC) {
			i = skipEscSequence(message, i + 1);
			continue;
		}
		if (code === CSI_8BIT) {
			i = skipCsi(message, i + 1);
			continue;
		}
		if (code === OSC_8BIT) {
			i = skipStringControl(message, i + 1, true);
			continue;
		}
		if (code === DCS_8BIT || code === SOS_8BIT || code === PM_8BIT || code === APC_8BIT) {
			i = skipStringControl(message, i + 1, false);
			continue;
		}
		if (preserveControlCharacters && (isC0(code) || isC1(code))) {
			out += message[i];
			i += 1;
			continue;
		}
		if (code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d || code === 0x85) {
			out += " ";
			i += 1;
			continue;
		}
		if (isC0(code) || isC1(code)) {
			i += 1;
			continue;
		}
		const cp = message.codePointAt(i);
		if (cp === undefined) break;
		out += String.fromCodePoint(cp);
		i += cp > 0xffff ? 2 : 1;
	}
	return out;
}
