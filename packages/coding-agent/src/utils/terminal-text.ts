/**
 * Terminal-safe text for content that is rendered in the TUI.
 *
 * A small state machine removes 7-bit and 8-bit (C1) escape sequences together with their
 * parameters and control-string payloads (OSC, DCS, SOS, PM, APC up to BEL or ST), plus the
 * remaining C0/C1 control characters other than tab and newline. Because the state is carried
 * between {@link TerminalTextSanitizer.write} calls, a sequence split across chunks is removed
 * whole, and a control string of any length is dropped up to its terminator without buffering it.
 *
 * Input is a decoded JS string, so U+0080..U+009F are code points; bytes that belong to valid
 * UTF-8 multibyte characters never appear here as C1 controls.
 */

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const ST = 0x9c;

const State = {
	Ground: 0,
	Escape: 1,
	EscapeIntermediate: 2,
	Csi: 3,
	ControlString: 4,
	ControlStringEscape: 5,
} as const;
type State = (typeof State)[keyof typeof State];

function isControlStringIntroducer8Bit(code: number): boolean {
	// DCS, SOS, OSC, PM, APC
	return code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f;
}

// Final bytes that end a two-character escape sequence (the strip-ansi set). After any other character only the
// ESC is dropped, so text such as "\x1bend" keeps its letters; without the ESC the terminal sees plain text.
function isEscapeFinal(code: number): boolean {
	return /[\dA-PR-TZcf-nq-uy=><~]/.test(String.fromCharCode(code));
}

function isDroppedCharacter(code: number): boolean {
	return (
		(code < 0x20 && code !== 0x09 && code !== 0x0a) ||
		(code >= 0x7f && code <= 0x9f) ||
		(code >= 0xfff9 && code <= 0xfffb)
	);
}

/** Streaming sanitizer: feed chunks with {@link write}, then call {@link end}. */
export class TerminalTextSanitizer {
	private state: State = State.Ground;

	write(chunk: string): string {
		let output = "";
		let runStart = 0;
		for (let index = 0; index < chunk.length; index++) {
			const code = chunk.charCodeAt(index);
			if (this.state === State.Ground) {
				if (!isDroppedCharacter(code)) continue;
				output += chunk.slice(runStart, index);
				runStart = index + 1;
				if (code === ESC) this.state = State.Escape;
				else if (code === 0x9b) this.state = State.Csi;
				else if (isControlStringIntroducer8Bit(code)) this.state = State.ControlString;
				continue;
			}
			runStart = index + 1;
			if (!this.step(code)) {
				// The sequence was cut short by this character: it starts over in the ground state.
				this.state = State.Ground;
				index--;
				runStart = index + 1;
			}
		}
		if (this.state === State.Ground) output += chunk.slice(runStart);
		return output;
	}

	/** Finish the stream. An unterminated sequence at the end is dropped. */
	end(): string {
		this.state = State.Ground;
		return "";
	}

	/** Consume one character inside a sequence. Returns false when the character does not belong to it. */
	private step(code: number): boolean {
		switch (this.state) {
			case State.Escape:
				if (code === 0x5b) this.state = State.Csi;
				else if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f)
					this.state = State.ControlString;
				else if (code >= 0x20 && code <= 0x2f) this.state = State.EscapeIntermediate;
				else if (isEscapeFinal(code)) this.state = State.Ground;
				else return false;
				return true;
			case State.EscapeIntermediate:
				if (code >= 0x20 && code <= 0x2f) return true;
				if (code >= 0x30 && code <= 0x7e) {
					this.state = State.Ground;
					return true;
				}
				return false;
			case State.Csi:
				if (code >= 0x20 && code <= 0x3f) return true;
				if (code >= 0x40 && code <= 0x7e) {
					this.state = State.Ground;
					return true;
				}
				return false;
			case State.ControlString:
				if (code === BEL || code === ST || code === CAN || code === SUB) this.state = State.Ground;
				else if (code === ESC) this.state = State.ControlStringEscape;
				return true;
			case State.ControlStringEscape:
				if (code === 0x5c) {
					this.state = State.Ground;
					return true;
				}
				// ESC inside a control string ends it and starts a new sequence.
				this.state = State.Escape;
				return this.step(code);
			default:
				return false;
		}
	}
}

/** Remove escape sequences and control characters other than tab and newline from complete text. */
export function sanitizeTerminalText(text: string): string {
	const sanitizer = new TerminalTextSanitizer();
	return sanitizer.write(text) + sanitizer.end();
}

const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

/** Show bidirectional embeddings, overrides and isolates as visible `<U+XXXX>` escapes. */
export function escapeBidiControls(text: string): string {
	return text.replace(BIDI_CONTROLS, (char) => `<U+${char.charCodeAt(0).toString(16).toUpperCase()}>`);
}

/** Make untrusted text inert for terminal display, keeping its newlines and tabs. */
export function terminalDisplayText(text: string): string {
	return escapeBidiControls(sanitizeTerminalText(text));
}
