export interface EarlyInputState {
	text: string;
	submissions: string[];
}

export interface EarlyInputSnapshot {
	text: string;
	submissions: string[];
}

export interface EarlyInputCapture {
	consume(): EarlyInputSnapshot;
}

interface EarlyInputStream {
	isTTY?: boolean;
	isRaw?: boolean;
	setRawMode?(mode: boolean): void;
	setEncoding?(encoding: BufferEncoding): void;
	resume(): void;
	on(event: "data", listener: (chunk: Buffer | string) => void): void;
	off?(event: "data", listener: (chunk: Buffer | string) => void): void;
	removeListener(event: "data", listener: (chunk: Buffer | string) => void): void;
}

export interface StartEarlyInputCaptureOptions {
	enabled: boolean;
	stdin?: EarlyInputStream;
}

function submitCurrentText(state: EarlyInputState): void {
	const submitted = state.text.trim();
	state.text = "";
	if (submitted.length > 0) state.submissions.push(submitted);
}

function skipEscapeSequence(chars: string[], start: number): number {
	const next = chars[start + 1];
	if (next !== "[" && next !== "O") return start + 1;
	for (let index = start + 2; index < chars.length; index += 1) {
		const code = chars[index]?.charCodeAt(0) ?? 0;
		if (code >= 0x40 && code <= 0x7e) return index + 1;
	}
	return chars.length;
}

export function applyEarlyInputChunk(state: EarlyInputState, chunk: string): void {
	const chars = Array.from(chunk);
	for (let index = 0; index < chars.length;) {
		const char = chars[index] ?? "";
		if (char === "\x1b") {
			index = skipEscapeSequence(chars, index);
			continue;
		}
		if (char === "\r" || char === "\n") {
			submitCurrentText(state);
			index += 1;
			continue;
		}
		if (char === "\b" || char === "\x7f") {
			state.text = Array.from(state.text).slice(0, -1).join("");
			index += 1;
			continue;
		}
		const code = char.charCodeAt(0);
		if (code >= 0x20 && code !== 0x7f) state.text += char;
		index += 1;
	}
}

export function startEarlyInputCapture(options: StartEarlyInputCaptureOptions): EarlyInputCapture | undefined {
	const stdin = options.stdin ?? process.stdin;
	if (!options.enabled || stdin.isTTY !== true || !stdin.setRawMode) return undefined;

	const state: EarlyInputState = { text: "", submissions: [] };
	const wasRaw = stdin.isRaw === true;
	let consumed = false;
	let onData: (chunk: Buffer | string) => void;
	const cleanup = () => {
		if (consumed) return;
		consumed = true;
		if (stdin.off) stdin.off("data", onData);
		else stdin.removeListener("data", onData);
		stdin.setRawMode?.(wasRaw);
	};
	onData = (chunk: Buffer | string) => {
		const text = chunk.toString();
		if (text.includes("\x03")) {
			cleanup();
			process.kill(process.pid, "SIGINT");
			return;
		}
		applyEarlyInputChunk(state, text);
	};

	stdin.setRawMode(true);
	stdin.setEncoding?.("utf8");
	stdin.resume();
	stdin.on("data", onData);

	return {
		consume() {
			cleanup();
			return { text: state.text, submissions: [...state.submissions] };
		},
	};
}
