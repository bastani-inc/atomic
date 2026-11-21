import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import lockfile from "proper-lockfile";
import { normalizePath } from "./paths.ts";

/**
 * Process-global state shared with the bundled packages that warn about the same removed options (settings,
 * subagents): the warnings already shown, so each message shows once between them, and where they are shown.
 */
const EMITTED_KEY = "__atomicDeprecationWarnings";
const SINK_KEY = "__atomicDeprecationSink";
const UI_PENDING_KEY = "__atomicDeprecationWarningsForUi";
const HELD_KEY = "__atomicDeprecationWarningsHeld";
/** Set in a process whose warnings go only to a sink installed later, such as the interactive engine's host. */
const DEFERRED_KEY = "__atomicDeprecationWarningsDeferred";
/** {@link warnDeprecation} itself, for the bundled packages, so their warnings take the same path as the host's. */
const WARN_KEY = "__atomicWarnDeprecation";
const SHOWN_STORE_KEY = "__atomicShownNotices";

/** The file in Atomic's agent directory that records which notices about settings files were already shown. */
const SHOWN_NOTICES_FILE = "shown-notices.json";
/** How many shown notices the record keeps, the most recent first to go last. */
const SHOWN_NOTICES_LIMIT = 500;
/** The record names which settings files Atomic read: readable by its owner only. */
const SHOWN_NOTICES_MODE = 0o600;
/**
 * How long a process waits, as it exits, for another one to finish saving the record, 10 ms apart. Each holds the lock
 * for one small read and rename; a process that cannot have it in time leaves the record as it is, and its notices are
 * shown once more on the next start.
 */
const SHOWN_NOTICES_LOCK_WAIT_MS = 2000;
const SHOWN_NOTICES_LOCK_POLL_MS = 10;
/** How old a record lock must be to be judged left by a process that died while saving. */
const SHOWN_NOTICES_LOCK_STALE_MS = 10_000;
const lockPoll = new Int32Array(new SharedArrayBuffer(4));

export interface DeprecationOptions {
	showInUi?: boolean;
	/** Hold the warning while {@link holdDeprecationWarnings} holds this key. */
	hold?: string;
	/**
	 * What the warning is about, such as a file and the value it ignores: shown once across starts while it stays the
	 * same, once {@link loadShownDeprecationNotices} has loaded the record. It is recorded as shown when it is delivered.
	 */
	once?: string;
}

/** Where warnings are shown while a UI owns the terminal. `once` identifies a notice shown once across starts. */
export type DeprecationWarningSink = (message: string, notice: { once?: string }) => void;

interface ShownNotices {
	path: string;
	shown: Set<string>;
	added: string[];
}

type DeprecationRegistry = typeof globalThis & {
	[EMITTED_KEY]?: Set<string>;
	[SINK_KEY]?: DeprecationWarningSink;
	/** Warnings written to stderr (or deferred) that the next sink shows again; `once` is recorded when it does. */
	[UI_PENDING_KEY]?: { message: string; once?: string; printed: boolean }[];
	[HELD_KEY]?: Map<string, { message: string; options: DeprecationOptions }[]>;
	[DEFERRED_KEY]?: boolean;
	[WARN_KEY]?: (message: string, options?: DeprecationOptions) => void;
	[SHOWN_STORE_KEY]?: ShownNotices;
};

function registry(): DeprecationRegistry {
	return globalThis as DeprecationRegistry;
}

/**
 * Show a deprecation warning once per process: through the installed sink (the interactive UI renders it as a warning
 * in the chat), or on stderr when no UI owns the terminal. With `showInUi`, a warning written to stderr is shown again
 * by the next sink installed, because the interactive UI clears what was printed before it started; use it for a
 * warning only this process can give, such as a change it made to a file.
 */
export function warnDeprecation(message: string, options: DeprecationOptions = {}): void {
	const state = registry();
	const held = options.hold === undefined ? undefined : state[HELD_KEY]?.get(options.hold);
	if (held !== undefined) {
		if (!held.some((warning) => warning.message === message)) held.push({ message, options });
		return;
	}
	const once = options.once;
	if (once !== undefined && state[SHOWN_STORE_KEY]?.shown.has(noticeHash(once, message))) return;
	state[EMITTED_KEY] ??= new Set<string>();
	if (state[EMITTED_KEY].has(message)) return;
	state[EMITTED_KEY].add(message);
	const sink = state[SINK_KEY];
	if (sink !== undefined) {
		sink(message, { once });
		recordShown(once, message);
		return;
	}
	const deferred = state[DEFERRED_KEY] === true;
	if (!deferred) console.warn(chalk.yellow(`Deprecation warning: ${message}`));
	// A notice shown once across starts must reach the UI too, which clears what was printed before it started.
	if (deferred || options.showInUi || once !== undefined) {
		state[UI_PENDING_KEY] ??= [];
		state[UI_PENDING_KEY].push({ message, once, printed: !deferred });
	}
}

registry()[WARN_KEY] = warnDeprecation;

/** Record a notice shown once across starts as shown, now that it was delivered. */
function recordShown(once: string | undefined, message: string): void {
	const store = registry()[SHOWN_STORE_KEY];
	if (once === undefined || store === undefined) return;
	const hash = noticeHash(once, message);
	if (store.shown.has(hash)) return;
	store.shown.add(hash);
	store.added.push(hash);
}

/**
 * Route deprecation warnings to a UI while it owns the terminal, instead of writing over it. Warnings kept for a UI
 * (`showInUi`, a notice shown once across starts, or every warning of a deferred process) are shown through it first.
 * Returns the function that restores the previous destination.
 */
export function setDeprecationWarningSink(sink: DeprecationWarningSink): () => void {
	const state = registry();
	const previous = state[SINK_KEY];
	state[SINK_KEY] = sink;
	for (const { message, once } of state[UI_PENDING_KEY]?.splice(0) ?? []) {
		sink(message, { once });
		recordShown(once, message);
	}
	return () => {
		if (state[SINK_KEY] === sink) state[SINK_KEY] = previous;
	};
}

/**
 * Keep this process's deprecation warnings off stderr until a sink is installed, which then shows them: the
 * interactive engine, whose stderr its host shows as diagnostics, sends them to the host instead. Warnings no sink
 * took are written to stderr as the process exits.
 */
export function deferDeprecationWarnings(): void {
	registry()[DEFERRED_KEY] = true;
	registerExitHandler();
}

/** Clear deprecation warning state. Exported for tests. */
export function clearDeprecationWarningsForTests(): void {
	const state = registry();
	state[EMITTED_KEY]?.clear();
	state[UI_PENDING_KEY]?.splice(0);
	state[HELD_KEY]?.clear();
	delete state[DEFERRED_KEY];
	delete state[SHOWN_STORE_KEY];
}

/** The key that holds warnings about one settings file, however its path is spelled. */
export function settingsFileNoticeKey(path: string): string {
	return normalizePath(resolve(path));
}

/**
 * Hold the warnings raised with this `hold` key until {@link releaseDeprecationWarnings} decides whether they still
 * apply, such as a settings file's ignored setting while a removal of that setting is retried. Held warnings are shown
 * as the process exits when nothing released them.
 */
export function holdDeprecationWarnings(key: string): void {
	const state = registry();
	state[HELD_KEY] ??= new Map();
	if (!state[HELD_KEY].has(key)) state[HELD_KEY].set(key, []);
	registerExitHandler();
}

/** Show every warning still held, as the process exits before anything released it (an early-exiting command). */
export function showHeldDeprecationWarnings(): void {
	for (const key of [...(registry()[HELD_KEY]?.keys() ?? [])]) releaseDeprecationWarnings(key, true);
}

/** Stop holding `key`: show the warnings it held, or drop them when they no longer apply. */
export function releaseDeprecationWarnings(key: string, show: boolean): void {
	const state = registry();
	const held = state[HELD_KEY]?.get(key);
	if (held === undefined) return;
	state[HELD_KEY]?.delete(key);
	if (!show) return;
	for (const { message, options } of held) warnDeprecation(message, { ...options, hold: undefined });
}

let exitHandlerRegistered = false;

/** One exit handler, in order: show what is still held, print what no sink took, then save the shown-notice record. */
function registerExitHandler(): void {
	if (exitHandlerRegistered) return;
	exitHandlerRegistered = true;
	process.once("exit", finishDeprecationWarningsAtExit);
}

/** What the exit handler does. Exported for tests, which cannot let their process exit. */
export function finishDeprecationWarningsAtExit(): void {
	const state = registry();
	showHeldDeprecationWarnings();
	if (state[DEFERRED_KEY] === true && state[SINK_KEY] === undefined) {
		for (const pending of state[UI_PENDING_KEY] ?? []) {
			if (pending.printed) continue;
			console.warn(chalk.yellow(`Deprecation warning: ${pending.message}`));
			pending.printed = true;
		}
	}
	saveShownDeprecationNotices();
}

/** A short hash of what a notice is about and what it says, that needs no synchronous crypto. */
function noticeHash(once: string, message: string): string {
	const text = `${once}\0${message}`;
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

function readShownNotices(path: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { shown?: unknown };
		return Array.isArray(parsed.shown) ? parsed.shown.filter((entry) => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Load which notices about settings files Atomic already showed, from its agent directory, so a notice raised with
 * `once` is shown once across starts until what it is about changes. The record is saved as the process exits.
 */
export function loadShownDeprecationNotices(agentDir: string): void {
	const path = join(agentDir, SHOWN_NOTICES_FILE);
	registry()[SHOWN_STORE_KEY] = { path, shown: new Set(readShownNotices(path)), added: [] };
	registerExitHandler();
}

/** Save the notices shown since {@link loadShownDeprecationNotices}, keeping what other processes saved meanwhile. */
export function saveShownDeprecationNotices(): void {
	const state = registry();
	const store = state[SHOWN_STORE_KEY];
	if (store === undefined) return;
	// Written to stderr by a process no UI took over (print, JSON or RPC mode): the user saw them there.
	for (const { message, once, printed } of state[UI_PENDING_KEY] ?? []) if (printed) recordShown(once, message);
	if (store.added.length === 0) return;
	// Other Atomic processes save the record too: read, merge and replace it under its lock, so none loses another's.
	const release = lockShownNotices(store.path);
	if (release === undefined) return;
	const temporary = `${store.path}.${process.pid}.tmp`;
	try {
		const added = new Set(store.added);
		const shown = [...readShownNotices(store.path).filter((hash) => !added.has(hash)), ...store.added].slice(
			-SHOWN_NOTICES_LIMIT,
		);
		writeFileSync(temporary, `${JSON.stringify({ shown }, null, 2)}\n`, {
			encoding: "utf-8",
			mode: SHOWN_NOTICES_MODE,
		});
		chmodSync(temporary, SHOWN_NOTICES_MODE);
		renameSync(temporary, store.path);
		store.added = [];
	} catch {
		if (existsSync(temporary)) rmSync(temporary, { force: true });
	} finally {
		try {
			release();
		} catch {}
	}
}

/** Take the record's lock, waiting {@link SHOWN_NOTICES_LOCK_WAIT_MS} for another process to finish with it. */
function lockShownNotices(path: string): (() => void) | undefined {
	const deadline = Date.now() + SHOWN_NOTICES_LOCK_WAIT_MS;
	for (;;) {
		try {
			return lockfile.lockSync(path, { realpath: false, stale: SHOWN_NOTICES_LOCK_STALE_MS });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) return undefined;
			// The process is exiting and nothing else runs on its event loop: wait without spinning the CPU.
			Atomics.wait(lockPoll, 0, 0, SHOWN_NOTICES_LOCK_POLL_MS);
		}
	}
}
