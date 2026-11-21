import { recordTimeSinceReset } from "./core/timings.ts";
import { createModuleRequire } from "./utils/module-require.js";

export interface EarlyInputState {
	text: string;
	submissions: string[];
	pendingEscape?: string;
}

export interface EarlyInputSnapshot {
	text: string;
	submissions: string[];
	heldForStartupDecision?: true;
}

export interface EarlyInputCapture {
	consume(): EarlyInputSnapshot;
}

interface ActiveEarlyInputCapture {
	pause(): boolean;
	resume(): void;
	keepDraft(text: string): void;
	readonly pendingInput?: PendingInput;
}

/** How much input the OS holds unread for the capture's stdin, or null where it cannot tell. */
export type PendingInput = () => number | null;

/**
 * How long a startup dialog also waits for input already read to arrive before it takes stdin: long enough for the
 * event loop to poll stdin and for a runtime's read thread to hand over what it read, short enough not to be seen.
 */
const STARTUP_DIALOG_INPUT_GRACE_MS = 25;
/**
 * The longest a startup dialog waits for input the OS already holds to reach the capture, which a busy machine can
 * delay far past the grace above. Input still unread then goes to the dialog.
 */
const STARTUP_DIALOG_INPUT_DRAIN_MAX_MS = 2_000;
/** How often a startup dialog asks the OS whether that input has been read. */
const STARTUP_DIALOG_INPUT_DRAIN_POLL_MS = 5;

let nativePendingInput: PendingInput | null | undefined;

/** How much input waits unread on this process's standard input, from the native module; null without it. */
export function osStdinPendingInput(): number | null {
	if (nativePendingInput === undefined) {
		try {
			const binding = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
				pendingStdinInput?: () => number | null;
			};
			const read = binding.pendingStdinInput;
			nativePendingInput = typeof read === "function" ? () => read() ?? null : null;
		} catch {
			nativePendingInput = null;
		}
	}
	return nativePendingInput?.() ?? null;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Lets the capture receive what was typed before a dialog takes stdin: all the OS still holds, when it can say how
 * much, then what a runtime's read thread may already have taken from it.
 */
async function receiveInputAlreadyTyped(capture: ActiveEarlyInputCapture): Promise<void> {
	const pending = capture.pendingInput;
	if (pending !== undefined && pending() !== null) {
		const deadline = performance.now() + STARTUP_DIALOG_INPUT_DRAIN_MAX_MS;
		while ((pending() ?? 0) > 0 && performance.now() < deadline) await delay(STARTUP_DIALOG_INPUT_DRAIN_POLL_MS);
	}
	// A timer that is not yet due makes the event loop wait in its I/O poll, so input a read thread already holds
	// reaches the capture. A zero-delay timer and an immediate can both run before that poll.
	await delay(STARTUP_DIALOG_INPUT_GRACE_MS);
	await new Promise<void>((resolve) => setImmediate(resolve));
}

let activeCapture: ActiveEarlyInputCapture | undefined;

/** The early editor, while it holds the terminal: see `modes/interactive/startup-shell.ts`. */
export interface StartupShellLink {
	/** Whether the early editor still shows the prompt and takes the keys. */
	readonly active: boolean;
	/** Ends the early editor, the screen restored, and returns what was typed as startup input. */
	abort(): EarlyInputState;
}

let startupShell: StartupShellLink | undefined;
/** What an early editor that ended before the session's interface was ready handed back, for the capture. */
let startupShellInput: EarlyInputState | undefined;
/** Starts the capture behind an early editor once that editor ends; set while such a capture exists. */
let onStartupShellEnded: ((typed: EarlyInputState) => void) | undefined;

/**
 * Links the early editor to the startup input capture, or unlinks it. `typed` is what it handed back when it ended
 * before the session's interface: the capture continues from it, as if the keys had reached the capture.
 */
export function linkStartupShell(link: StartupShellLink | undefined, typed?: EarlyInputState): void {
	startupShell = link;
	if (typed === undefined) return;
	if (onStartupShellEnded) onStartupShellEnded(typed);
	else startupShellInput = typed;
}
let startupDialogDrafts: string[] = [];
let startupDialogQueue: Promise<void> | undefined;

export async function withEarlyInputHeldForStartupDialog<T>(
	run: (state: { hasUnfinishedInput: boolean }) => Promise<T>,
): Promise<T> {
	const previous = startupDialogQueue;
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	startupDialogQueue = current;
	let capture: ActiveEarlyInputCapture | undefined;
	try {
		if (previous) await previous;
		if (activeCapture) {
			activeCapture.resume();
			await receiveInputAlreadyTyped(activeCapture);
		}
		capture = activeCapture;
		const hasUnfinishedInput = capture?.pause() ?? startupDialogDrafts.length > 0;
		return await run({ hasUnfinishedInput });
	} finally {
		if (startupDialogQueue === current) {
			startupDialogQueue = undefined;
			if (capture !== undefined && activeCapture === capture) capture.resume();
		}
		release();
	}
}

export function keepStartupDialogDraft(text: string): void {
	if (text.length === 0) return;
	if (activeCapture) activeCapture.keepDraft(text);
	else startupDialogDrafts.push(text);
}

export function consumeStartupInput(
	capture: EarlyInputCapture | undefined,
	options: { readonly startupDecisionPending?: boolean } = {},
): EarlyInputSnapshot {
	const snapshot = capture?.consume() ?? { text: "", submissions: [] };
	const dialogDrafts = startupDialogDrafts;
	startupDialogDrafts = [];
	const held = snapshot.heldForStartupDecision || options.startupDecisionPending === true || dialogDrafts.length > 0;
	if (!held) return snapshot;
	const parts = [...snapshot.submissions, snapshot.text, ...dialogDrafts].filter((part) => part.length > 0);
	return { text: parts.join("\n"), submissions: [], heldForStartupDecision: true };
}

interface EarlyInputStream {
	isTTY?: boolean;
	isRaw?: boolean;
	setRawMode?(mode: boolean): void;
	setEncoding?(encoding: BufferEncoding): void;
	resume(): void;
	pause?(): void;
	read?(size?: number): unknown;
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
	/** What was typed before the capture started, as the capture would have read it. */
	initialState?: EarlyInputState;
	stdin?: EarlyInputStream;
	process?: EarlyInputProcess;
	/** How much input the OS holds unread for `stdin`; for this process's own stdin, the native module tells. */
	pendingInput?: PendingInput;
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
	// The Linux console and libuv on Windows send F1-F5 as ESC [ [ A..E: the second "[" opens the sequence.
	const start = next === "[" && chars[2] === "[" ? 3 : 2;
	for (let index = start; index < chars.length; index += 1) {
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
	for (let index = 0; index < chars.length; ) {
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
	if (options.enabled && startupShell?.active) return captureBehindStartupShell(options);
	const handedBack = startupShellInput;
	startupShellInput = undefined;
	return startRawEarlyInputCapture({ ...options, initialState: options.initialState ?? handedBack });
}

/**
 * The startup input capture while the early editor holds the terminal. The editor's prompt reaches the session's
 * interface directly, so this captures nothing until the editor ends early: a startup question that needs the terminal
 * ends it, and so does a message it writes. From then on it is the capture that would have run without the editor,
 * starting from what was typed.
 */
function captureBehindStartupShell(options: StartEarlyInputCaptureOptions): EarlyInputCapture {
	let inner: EarlyInputCapture | undefined;
	let innerControl: ActiveEarlyInputCapture | undefined;
	const startInner = (typed: EarlyInputState) => {
		if (inner !== undefined) return;
		onStartupShellEnded = undefined;
		inner = startRawEarlyInputCapture({ ...options, initialState: typed });
		innerControl = activeCapture;
		activeCapture = control;
	};
	const ensureInner = () => {
		if (inner === undefined && startupShell?.active) startInner(startupShell.abort());
	};
	onStartupShellEnded = startInner;
	const control: ActiveEarlyInputCapture = {
		pause() {
			ensureInner();
			return innerControl?.pause() ?? false;
		},
		resume() {
			innerControl?.resume();
		},
		keepDraft(text) {
			ensureInner();
			innerControl?.keepDraft(text);
		},
	};
	activeCapture = control;
	return {
		consume() {
			if (activeCapture === control) activeCapture = undefined;
			onStartupShellEnded = undefined;
			// Still drawing: the session's interface takes the prompt from the editor itself.
			return inner?.consume() ?? { text: "", submissions: [] };
		},
	};
}

function startRawEarlyInputCapture(options: StartEarlyInputCaptureOptions): EarlyInputCapture | undefined {
	const stdin = options.stdin ?? process.stdin;
	const processLike = options.process ?? process;
	if (!options.enabled || stdin.isTTY !== true || !stdin.setRawMode) return undefined;

	const state: EarlyInputState = {
		text: options.initialState?.text ?? "",
		submissions: [...(options.initialState?.submissions ?? [])],
	};
	const draftParts: string[] = [];
	const wasRaw = stdin.isRaw === true;
	let consumed = false;
	let paused = false;
	let heldForStartupDecision = false;
	let firstRawKeyRecorded = false;
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
	const detach = () => {
		if (stdin.off) stdin.off("data", onData);
		else stdin.removeListener("data", onData);
	};
	const cleanup = () => {
		if (consumed) return;
		consumed = true;
		if (activeCapture === control) activeCapture = undefined;
		if (!paused) detach();
		for (const { event, listener } of registeredProcessListeners) {
			removeProcessListener(processLike, event, listener);
		}
		clearPendingEscapeTimer();
		state.pendingEscape = undefined;
		if (!paused) stdin.setRawMode?.(wasRaw);
	};
	const control: ActiveEarlyInputCapture = {
		pendingInput: options.pendingInput ?? (options.stdin === undefined ? osStdinPendingInput : undefined),
		pause() {
			const hasUnfinishedInput = state.text.length > 0 || (draftParts.at(-1)?.length ?? 0) > 0;
			if (consumed || paused) return hasUnfinishedInput;
			paused = true;
			heldForStartupDecision = true;
			detach();
			// Without a reader a flowing stream drops what arrives: keep it for the dialog's reader instead.
			stdin.pause?.();
			clearPendingEscapeTimer();
			state.pendingEscape = undefined;
			stdin.setRawMode?.(wasRaw);
			return hasUnfinishedInput;
		},
		resume() {
			if (consumed || !paused) return;
			paused = false;
			stdin.setRawMode?.(true);
			stdin.setEncoding?.("utf8");
			stdin.on("data", onData);
			stdin.resume();
		},
		keepDraft(text) {
			heldForStartupDecision = true;
			for (const submission of state.submissions) draftParts.push(submission);
			draftParts.push(state.text, text);
			state.submissions = [];
			state.text = "";
		},
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
		if (!firstRawKeyRecorded) {
			firstRawKeyRecorded = true;
			recordTimeSinceReset("startup-input-first-raw-key");
		}
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
	recordTimeSinceReset("startup-input-raw-mode-enabled");
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
	activeCapture = control;
	stdin.resume();
	// Start the OS read now rather than on the next tick: keys typed while startup runs without yielding must already
	// be on their way when a startup dialog takes stdin. On Windows a read completes through a helper thread, so a
	// read started only when startup yields can miss the dialog's handoff.
	stdin.read?.(0);

	return {
		consume() {
			cleanup();
			state.pendingEscape = undefined;
			const snapshot: EarlyInputSnapshot =
				draftParts.length > 0
					? {
							text: [...draftParts, ...state.submissions, state.text]
								.filter((part) => part.length > 0)
								.join("\n"),
							submissions: [],
						}
					: { text: state.text, submissions: [...state.submissions] };
			if (heldForStartupDecision) snapshot.heldForStartupDecision = true;
			return snapshot;
		},
	};
}
