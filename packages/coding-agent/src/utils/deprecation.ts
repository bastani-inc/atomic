import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { normalizePath } from "./paths.ts";

/**
 * Process-global state shared with the bundled packages that warn about the same removed options (settings, subagents,
 * workflows): the warnings already shown, so each message shows once between them, and where they are shown.
 */
const EMITTED_KEY = "__atomicDeprecationWarnings";
const SINK_KEY = "__atomicDeprecationSink";
const UI_PENDING_KEY = "__atomicDeprecationWarningsForUi";
const HELD_KEY = "__atomicDeprecationWarningsHeld";
/** Shared with the bundled packages: whether a notice about a file's content was never shown before (see below). */
const SHOW_ONCE_KEY = "__atomicShowNoticeOnce";
const SHOWN_STORE_KEY = "__atomicShownNotices";

/** The file in Atomic's agent directory that records which notices about settings files were already shown. */
const SHOWN_NOTICES_FILE = "shown-notices.json";
/** How many shown notices the record keeps, the most recent first to go last. */
const SHOWN_NOTICES_LIMIT = 500;
/** The record names which settings files Atomic read: readable by its owner only. */
const SHOWN_NOTICES_MODE = 0o600;

interface DeprecationOptions {
	showInUi?: boolean;
	/** Hold the warning while {@link holdDeprecationWarnings} holds this key. */
	hold?: string;
	/**
	 * What the warning is about, such as a file and the value it ignores: shown once across starts while it stays the
	 * same, once {@link loadShownDeprecationNotices} has loaded the record.
	 */
	once?: string;
}

interface ShownNotices {
	path: string;
	shown: Set<string>;
	added: string[];
}

type DeprecationRegistry = typeof globalThis & {
	[EMITTED_KEY]?: Set<string>;
	[SINK_KEY]?: (message: string) => void;
	/** Warnings written to stderr that the next UI shows again; `once` is recorded as shown when it does. */
	[UI_PENDING_KEY]?: { message: string; once?: string }[];
	[HELD_KEY]?: Map<string, { message: string; options: DeprecationOptions }[]>;
	[SHOW_ONCE_KEY]?: (identity: string) => boolean;
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
	const once = options.once === undefined ? undefined : `${options.once}\0${message}`;
	if (once !== undefined && state[SHOWN_STORE_KEY]?.shown.has(noticeHash(once))) return;
	state[EMITTED_KEY] ??= new Set<string>();
	if (state[EMITTED_KEY].has(message)) return;
	state[EMITTED_KEY].add(message);
	const sink = state[SINK_KEY];
	if (sink !== undefined) {
		sink(message);
		recordShown(once);
		return;
	}
	console.warn(chalk.yellow(`Deprecation warning: ${message}`));
	// A notice shown once across starts must reach the UI too, which clears what was printed before it started.
	if (options.showInUi || once !== undefined) {
		state[UI_PENDING_KEY] ??= [];
		state[UI_PENDING_KEY].push({ message, once });
	}
}

/** Record a notice shown once across starts as shown, now that it was delivered. */
function recordShown(once: string | undefined): void {
	const store = registry()[SHOWN_STORE_KEY];
	if (once === undefined || store === undefined) return;
	const hash = noticeHash(once);
	if (store.shown.has(hash)) return;
	store.shown.add(hash);
	store.added.push(hash);
}

/**
 * Route deprecation warnings to a UI while it owns the terminal, instead of writing over it. Warnings kept for a UI
 * (`showInUi`) are shown through it first. Returns the function that restores the previous destination.
 */
export function setDeprecationWarningSink(sink: (message: string) => void): () => void {
	const state = registry();
	const previous = state[SINK_KEY];
	state[SINK_KEY] = sink;
	for (const { message, once } of state[UI_PENDING_KEY]?.splice(0) ?? []) {
		sink(message);
		recordShown(once);
	}
	return () => {
		if (state[SINK_KEY] === sink) state[SINK_KEY] = previous;
	};
}

/** Clear deprecation warning state. Exported for tests. */
export function clearDeprecationWarningsForTests(): void {
	const state = registry();
	state[EMITTED_KEY]?.clear();
	state[UI_PENDING_KEY]?.splice(0);
	state[HELD_KEY]?.clear();
	delete state[SHOW_ONCE_KEY];
	delete state[SHOWN_STORE_KEY];
}

/** The key that holds warnings about one settings file, however its path is spelled. */
export function settingsFileNoticeKey(path: string): string {
	return normalizePath(resolve(path));
}

let flushHeldAtExit = false;

/**
 * Hold the warnings raised with this `hold` key until {@link releaseDeprecationWarnings} decides whether they still
 * apply, such as a settings file's ignored setting while a removal of that setting is retried. Held warnings are shown
 * as the process exits when nothing released them.
 */
export function holdDeprecationWarnings(key: string): void {
	const state = registry();
	state[HELD_KEY] ??= new Map();
	if (!state[HELD_KEY].has(key)) state[HELD_KEY].set(key, []);
	if (flushHeldAtExit) return;
	flushHeldAtExit = true;
	process.once("exit", showHeldDeprecationWarnings);
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

/** A short hash of `text` that needs no synchronous crypto. */
function noticeHash(text: string): string {
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

let saveShownAtExit = false;

/**
 * Load which notices about settings files Atomic already showed, from its agent directory, so a notice raised with
 * `once` is shown once across starts until what it is about changes. The record is saved as the process exits.
 */
export function loadShownDeprecationNotices(agentDir: string): void {
	const state = registry();
	const path = join(agentDir, SHOWN_NOTICES_FILE);
	const store: ShownNotices = { path, shown: new Set(readShownNotices(path)), added: [] };
	state[SHOWN_STORE_KEY] = store;
	state[SHOW_ONCE_KEY] = (identity) => {
		if (store.shown.has(noticeHash(identity))) return false;
		recordShown(identity);
		return true;
	};
	if (saveShownAtExit) return;
	saveShownAtExit = true;
	process.once("exit", () => {
		// The warnings still held are shown first, so the record includes them.
		showHeldDeprecationWarnings();
		saveShownDeprecationNotices();
	});
}

/** Save the notices shown since {@link loadShownDeprecationNotices}, keeping what other processes saved meanwhile. */
export function saveShownDeprecationNotices(): void {
	const state = registry();
	const store = state[SHOWN_STORE_KEY];
	if (store === undefined) return;
	// Written to stderr by a process no UI took over (print, JSON or RPC mode): the user saw them there.
	for (const { once } of state[UI_PENDING_KEY] ?? []) recordShown(once);
	if (store.added.length === 0) return;
	const added = new Set(store.added);
	const shown = [...readShownNotices(store.path).filter((hash) => !added.has(hash)), ...store.added].slice(
		-SHOWN_NOTICES_LIMIT,
	);
	const temporary = `${store.path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ shown }, null, 2)}\n`, {
			encoding: "utf-8",
			mode: SHOWN_NOTICES_MODE,
		});
		chmodSync(temporary, SHOWN_NOTICES_MODE);
		renameSync(temporary, store.path);
		store.added = [];
	} catch {
		if (existsSync(temporary)) rmSync(temporary, { force: true });
	}
}
