export interface EarlyInputState {
	text: string;
	submissions: string[];
	pendingEscape?: string;
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

type EarlyInputProcessEvent = "exit" | "SIGINT" | "SIGTERM" | "SIGHUP" | "uncaughtException";
type EarlyInputProcessListener = (error?: Error) => void;

interface EarlyInputProcess {
	pid: number;
	platform: NodeJS.Platform;
	on(event: EarlyInputProcessEvent, listener: EarlyInputProcessListener): void;
	off?(event: EarlyInputProcessEvent, listener: EarlyInputProcessListener): void;
	removeListener(event: EarlyInputProcessEvent, listener: EarlyInputProcessListener): void;
	kill(pid: number, signal: NodeJS.Signals): void;
}

export interface StartEarlyInputCaptureOptions {
	enabled: boolean;
	stdin?: EarlyInputStream;
	process?: EarlyInputProcess;
}

const PENDING_ESCAPE_CLEAR_MS = 50;

function submitCurrentText(state: EarlyInputState): void {
	const submitted = state.text.trim();
	state.text = "";
	if (submitted.length > 0) state.submissions.push(submitted);
}

function escapeSequenceEndIndex(sequence: string): number | undefined {
	const chars = Array.from(sequence);
	const first = chars[0];
	if (first !== "\x1b") return 1;
	const next = chars[1];
	if (next === undefined) return undefined;
	if (next !== "[" && next !== "O") return 1;
	for (let index = 2; index < chars.length; index += 1) {
		const code = chars[index]?.charCodeAt(0) ?? 0;
		if (code >= 0x40 && code <= 0x7e) return index + 1;
	}
	return undefined;
}

function takePendingEscape(state: EarlyInputState): string {
	const pending = state.pendingEscape ?? "";
	state.pendingEscape = undefined;
	return pending;
}

export function applyEarlyInputChunk(state: EarlyInputState, chunk: string): void {
	const chars = Array.from(`${takePendingEscape(state)}${chunk}`);
	for (let index = 0; index < chars.length;) {
		const char = chars[index] ?? "";
		if (char === "\x1b") {
			const remaining = chars.slice(index).join("");
			const endIndex = escapeSequenceEndIndex(remaining);
			if (endIndex === undefined) {
				state.pendingEscape = remaining.slice(0, 16);
				return;
			}
			index += endIndex;
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

function removeProcessListener(
	processLike: EarlyInputProcess,
	event: EarlyInputProcessEvent,
	listener: EarlyInputProcessListener,
): void {
	if (processLike.off) processLike.off(event, listener);
	else processLike.removeListener(event, listener);
}

export function startEarlyInputCapture(options: StartEarlyInputCaptureOptions): EarlyInputCapture | undefined {
	const stdin = options.stdin ?? process.stdin;
	const processLike = options.process ?? process;
	if (!options.enabled || stdin.isTTY !== true || !stdin.setRawMode) return undefined;

	const state: EarlyInputState = { text: "", submissions: [] };
	const wasRaw = stdin.isRaw === true;
	let consumed = false;
	let onData: (chunk: Buffer | string) => void;
	const registeredProcessListeners: Array<{ event: EarlyInputProcessEvent; listener: EarlyInputProcessListener }> = [];
	let pendingEscapeTimer: ReturnType<typeof setTimeout> | undefined;
	const clearPendingEscapeTimer = () => {
		if (pendingEscapeTimer === undefined) return;
		clearTimeout(pendingEscapeTimer);
		pendingEscapeTimer = undefined;
	};
	const schedulePendingEscapeClear = () => {
		clearPendingEscapeTimer();
		if (state.pendingEscape === undefined) return;
		pendingEscapeTimer = setTimeout(() => {
			state.pendingEscape = undefined;
			pendingEscapeTimer = undefined;
		}, PENDING_ESCAPE_CLEAR_MS);
	};
	const cleanup = () => {
		if (consumed) return;
		consumed = true;
		if (stdin.off) stdin.off("data", onData);
		else stdin.removeListener("data", onData);
		for (const { event, listener } of registeredProcessListeners) {
			removeProcessListener(processLike, event, listener);
		}
		clearPendingEscapeTimer();
		state.pendingEscape = undefined;
		stdin.setRawMode?.(wasRaw);
	};
	const forwardSignal = (signal: NodeJS.Signals) => {
		cleanup();
		processLike.kill(processLike.pid, signal);
	};
	const registerProcessListener = (event: EarlyInputProcessEvent, listener: EarlyInputProcessListener) => {
		registeredProcessListeners.push({ event, listener });
		processLike.on(event, listener);
	};
	onData = (chunk: Buffer | string) => {
		const text = chunk.toString();
		if (text.includes("\x03")) {
			forwardSignal("SIGINT");
			return;
		}
		clearPendingEscapeTimer();
		applyEarlyInputChunk(state, text);
		schedulePendingEscapeClear();
	};

	stdin.setRawMode(true);
	stdin.setEncoding?.("utf8");
	stdin.on("data", onData);
	registerProcessListener("exit", cleanup);
	registerProcessListener("SIGINT", () => forwardSignal("SIGINT"));
	registerProcessListener("SIGTERM", () => forwardSignal("SIGTERM"));
	if (processLike.platform !== "win32") {
		registerProcessListener("SIGHUP", () => forwardSignal("SIGHUP"));
	}
	registerProcessListener("uncaughtException", (error) => {
		cleanup();
		throw error ?? new Error("Uncaught exception during startup input capture");
	});
	stdin.resume();

	return {
		consume() {
			cleanup();
			state.pendingEscape = undefined;
			return { text: state.text, submissions: [...state.submissions] };
		},
	};
}
