/**
 * The early editor: an interactive session paints its editor and takes typing while the rest of Atomic still loads,
 * then hands the same screen, the terminal and what was typed to the session's own interface once that is ready.
 *
 * States, in order (`StartupShellState`):
 * - `painting`: the editor is shown and edits the prompt as typed. Keys that only edit the prompt act at once.
 * - `holding`: a key that means more than an edit arrived (Enter, a command key, Esc, an arrow that can also move
 *   between views, a mouse event...). It and every key after it wait, in order, for the session; the prompt shows
 *   what was typed before it. Nothing is run before the session is ready.
 * - `handedOver`: the session's interface took the terminal, still set up, on the same screen: it restores the prompt
 *   (text, cursor, pastes, undo) and then receives the held keys first, in the order they were typed.
 * - `aborted`: something had to use the terminal before the session was ready (a startup question, a message, a
 *   failure): the editor leaves the screen as it found it, and what was typed goes to the startup input capture, as
 *   if the early editor had never run.
 * - `quitting`: Ctrl+C twice on an empty prompt, or Ctrl+D on one, as in the session: the screen is restored and
 *   Atomic exits.
 */
import {
	isKeyRelease,
	type ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	type TuiAltScreen,
	VStack,
} from "@bastani/atomic-tui";
import { ENV_HARDWARE_CURSOR, getEnvValue } from "../../config.js";
import { KEYBINDINGS, KeybindingsManager } from "../../core/keybindings.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { applyEarlyInputChunk, type EarlyInputState, linkStartupShell } from "../../main-early-input.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { isPhysicalCtrlC } from "./interactive-key-identity.ts";
import { createFullscreenTui, createProcessTerminal } from "./interactive-tui.ts";
import type { StartupShellPlan } from "./startup-shell-eligibility.ts";
import { getEditorTheme, initTheme, theme } from "./theme/theme.js";

export type StartupShellState = "painting" | "holding" | "handedOver" | "aborted" | "quitting";

/** What the session's interface takes over from the early editor. */
export interface StartupShellHandover {
	/** The prompt as the early editor left it, for `Editor.restoreDraft`. */
	readonly draft: ReturnType<CustomEditor["snapshotDraft"]>;
	/** When a first Ctrl+C on the empty prompt asked to exit, still counting toward the second; 0 when none. */
	readonly ctrlCAt: number;
}

/** Keys the early editor applies itself: they only edit the prompt, here and in the session alike. */
const PROMPT_EDIT_ACTIONS: ReadonlySet<string> = new Set([
	"tui.editor.cursorLeft",
	"tui.editor.cursorRight",
	"tui.editor.cursorWordLeft",
	"tui.editor.cursorWordRight",
	"tui.editor.cursorLineStart",
	"tui.editor.cursorLineEnd",
	"tui.editor.deleteCharBackward",
	"tui.editor.deleteCharForward",
	"tui.editor.deleteWordBackward",
	"tui.editor.deleteWordForward",
	"tui.editor.deleteToLineStart",
	"tui.editor.deleteToLineEnd",
	"tui.editor.yank",
	"tui.editor.yankPop",
	"tui.editor.undo",
	"tui.input.newLine",
]);

/**
 * Actions the session never takes on a key the prompt receives: a list's or a selection's keys, which act only in a
 * focused list (the agent panel) or an open menu.
 */
const OUTSIDE_THE_PROMPT_PREFIXES = ["app.list.", "tui.select."];
/** Actions the session takes from the prompt only while it is empty; with text, their keys edit the prompt. */
const EMPTY_PROMPT_ACTIONS: ReadonlySet<string> = new Set([
	"app.nav.back",
	"app.agents.focus",
	"app.keys.help",
	"app.exit",
]);

const BRACKETED_PASTE_START = "\x1b[200~";
/** Within this long of a first Ctrl+C on an empty prompt, a second one exits, as in the session. */
const CTRL_C_EXIT_WINDOW_MS = 800;
const CTRL_C_EXIT_HINT = "Press Ctrl+C again to exit";

/** Text a key inserts as typed: no control character, no escape sequence. */
function isTypedText(data: string): boolean {
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) return false;
	}
	return data.length > 0;
}

class StartupShell {
	state: StartupShellState = "painting";
	readonly terminal: ProcessTerminal;
	private readonly tui: TuiAltScreen;
	private readonly editor: CustomEditor;
	private readonly keybindings: KeybindingsManager;
	private readonly keybindingIds: readonly string[];
	private readonly status: Text;
	/** The last Ctrl+C, here or held: a second one within the window exits. */
	private lastCtrlC = 0;
	/**
	 * The last Ctrl+C this editor answered itself on the empty prompt, for the session to count toward its own second
	 * press. A held Ctrl+C is not: the session counts that one itself when it receives it.
	 */
	private armedCtrlC = 0;
	private readonly restoreOutput: () => void;
	/** Stops taking SIGINT, SIGTERM and SIGHUP, once the session's interface has its own handlers. */
	releaseSignals: () => void = () => {};

	constructor(plan: StartupShellPlan) {
		// The session's interface starts the theme file watcher; the early editor draws only Atomic's own themes.
		initTheme(plan.theme);
		this.keybindings = KeybindingsManager.create(plan.agentDir);
		setKeybindings(this.keybindings);
		this.keybindingIds = Object.keys(KEYBINDINGS);
		this.terminal = createProcessTerminal();
		// As the session draws them where no setting changes them (the plan admits none that would).
		this.tui = createFullscreenTui({
			showHardwareCursor: getEnvValue(ENV_HARDWARE_CURSOR) === "1",
			logDirectory: plan.agentDir,
			terminal: this.terminal,
		});
		this.editor = new CustomEditor(this.tui, getEditorTheme(), this.keybindings, {
			paddingX: SETTINGS_DEFAULTS.editorPaddingX,
			autocompleteMaxVisible: SETTINGS_DEFAULTS.autocompleteMaxVisible,
		});
		this.status = new Text("", 0, 0);
		const root = new VStack([
			{ component: new Spacer(0), basis: 0, grow: 1, shrink: 1, minSize: 0 },
			{ component: this.status, shrink: 1, minSize: 1 },
			{ component: this.editor, shrink: 1, minSize: 3 },
			{ component: new Spacer(1), shrink: 1, minSize: 1 },
		]);
		this.tui.addChild(root);
		this.tui.setLayoutRoot(root);
		this.tui.setFocus(this.editor);
		this.tui.addInputListener((data) => this.route(data));
		this.restoreOutput = this.guardOutput();
		try {
			this.tui.start();
			// The first frame now, before the rest of Atomic loads: loading it can keep a scheduled frame waiting.
			this.tui.renderNow();
		} catch (error) {
			this.restoreOutput();
			try {
				this.tui.stop();
			} catch {
				// The terminal never started.
			}
			throw error;
		}
	}

	/** Decides, for each key, whether the prompt takes it now, it waits for the session, or it is Ctrl+C/Ctrl+D. */
	private route(data: string): { consume: true } | undefined {
		if (this.state !== "painting" && this.state !== "holding") return { consume: true };
		// Enter typed before the terminal was set up arrives as a line feed, which the terminal's line discipline made
		// of it; the startup input capture always read a line feed as Enter, and so does the early editor.
		if (!data.startsWith("\x1b") && data.includes("\n")) data = data.replaceAll("\n", "\r");
		if (isPhysicalCtrlC(data)) return this.ctrlC(data);
		if (this.state === "holding") return this.hold(data);
		if (isKeyRelease(data)) return undefined;
		if (this.keybindings.matches(data, "app.exit") && this.editor.getText().length === 0) {
			this.quit();
			return { consume: true };
		}
		if (data.startsWith(BRACKETED_PASTE_START)) return undefined;
		const promptEmpty = this.editor.getText().length === 0;
		const actions = this.keybindingIds.filter(
			(id) =>
				!OUTSIDE_THE_PROMPT_PREFIXES.some((prefix) => id.startsWith(prefix)) &&
				!(EMPTY_PROMPT_ACTIONS.has(id) && !promptEmpty) &&
				this.keybindings.matches(data, id as never),
		);
		// A sequence no key of Atomic's means anything to (some terminals send one as they start) is not kept, as the
		// startup input capture keeps no sequence; holding it would hold every key after it.
		if (actions.length === 0 && data.startsWith("\x1b")) return { consume: true };
		const promptEdit = actions.length === 0 ? isTypedText(data) : actions.every((id) => PROMPT_EDIT_ACTIONS.has(id));
		if (promptEdit) {
			this.lastCtrlC = 0;
			this.armedCtrlC = 0;
			this.showStatus("");
			return undefined;
		}
		return this.hold(data);
	}

	/** This key and every one after it wait, in order, for the session's interface. */
	private hold(data: string): { consume: true } {
		this.state = "holding";
		this.held.push(data);
		return { consume: true };
	}

	/** Keys waiting for the session's interface, in the order they were typed. */
	private readonly held: string[] = [];

	private ctrlC(data: string): { consume: true } {
		// As in the session: Ctrl+C clears a prompt that has text; on an empty one, a second press exits.
		if (this.state === "painting" && this.editor.getText() !== "") {
			this.editor.setText("");
			this.lastCtrlC = 0;
			this.armedCtrlC = 0;
			this.tui.requestRender();
			return { consume: true };
		}
		const now = Date.now();
		if (now - this.lastCtrlC < CTRL_C_EXIT_WINDOW_MS) {
			this.quit();
			return { consume: true };
		}
		this.lastCtrlC = now;
		if (this.state === "holding") {
			this.armedCtrlC = 0;
			return this.hold(data);
		}
		this.armedCtrlC = now;
		this.showStatus(CTRL_C_EXIT_HINT);
		return { consume: true };
	}

	private showStatus(text: string): void {
		this.status.setText(text === "" ? "" : theme.fg("dim", text));
		this.tui.requestRender();
	}

	/**
	 * Lets the session's interface take the terminal: drawing stops with the screen as it is, and keys that arrive
	 * from now on wait for that interface. Returns the prompt to restore; the held keys come to it through the
	 * terminal, first.
	 */
	handOver(): StartupShellHandover | undefined {
		if (this.state !== "painting" && this.state !== "holding") return undefined;
		this.state = "handedOver";
		this.restoreOutput();
		linkStartupShell(undefined);
		const draft = this.editor.snapshotDraft();
		this.tui.handOffTerminal(this.held);
		return { draft, ctrlCAt: this.armedCtrlC };
	}

	/**
	 * Gives the terminal back as it was before the early editor, and what was typed as startup input: the prompt's
	 * text, then every held key as the startup input capture reads keys.
	 */
	abort(): EarlyInputState {
		const typed: EarlyInputState = { text: "", submissions: [] };
		if (this.state !== "painting" && this.state !== "holding") return typed;
		this.state = "aborted";
		this.restoreOutput();
		typed.text = this.editor.getExpandedText();
		this.tui.stop();
		for (const key of this.held) applyEarlyInputChunk(typed, key);
		return typed;
	}

	private quit(): void {
		this.state = "quitting";
		this.restoreOutput();
		this.tui.stop();
		process.exit(0);
	}

	/**
	 * Output written before the session's interface is ready belongs on the screen the user sees: the first console
	 * message, error or uncaught failure ends the early editor before it is written. A signal that ends the process
	 * (SIGINT, SIGTERM, SIGHUP from outside) also ends it first, so the terminal is given back as it was found.
	 */
	private guardOutput(): () => void {
		// The wrappers outlive the early editor where something wrapped them in turn: once it has ended they only pass
		// output on, and hold nothing of it.
		let guarded: StartupShell | undefined = this;
		const abort = () => {
			if (guarded !== undefined && (guarded.state === "painting" || guarded.state === "holding"))
				abortStartupShell();
		};
		const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
		const originals = consoleMethods.map((name) => console[name]);
		const wrappers = originals.map((original) => (...args: unknown[]) => {
			abort();
			original.apply(console, args);
		});
		for (const [index, name] of consoleMethods.entries()) console[name] = wrappers[index]!;
		const stderrWrite = process.stderr.write;
		const stderrWrapper = ((...args: Parameters<typeof process.stderr.write>) => {
			abort();
			return stderrWrite.apply(process.stderr, args);
		}) as typeof process.stderr.write;
		process.stderr.write = stderrWrapper;
		process.on("uncaughtExceptionMonitor", abort);
		const signals: NodeJS.Signals[] =
			process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
		// Until the session's own handlers take signals over (`releaseStartupShellSignals`): the terminal is given back,
		// and the signal is sent again, to what would have handled it without the early editor (the startup input
		// capture, or the runtime's default, which ends the process).
		const onSignal = (signal: NodeJS.Signals) => {
			abort();
			releaseSignals();
			process.kill(process.pid, signal);
		};
		const releaseSignals = () => {
			for (const signal of signals) process.off(signal, onSignal);
		};
		for (const signal of signals) process.on(signal, onSignal);
		this.releaseSignals = releaseSignals;
		return () => {
			guarded = undefined;
			releaseSignals();
			// What replaced a wrapper since stays: it is someone else's now.
			for (const [index, name] of consoleMethods.entries())
				if (console[name] === wrappers[index]) console[name] = originals[index]!;
			if (process.stderr.write === stderrWrapper) process.stderr.write = stderrWrite;
			process.off("uncaughtExceptionMonitor", abort);
		};
	}
}

let shell: StartupShell | undefined;

/** Shows the early editor for the session this process starts. */
export function startStartupShell(plan: StartupShellPlan): void {
	if (shell !== undefined) return;
	try {
		shell = new StartupShell(plan);
	} catch {
		shell = undefined;
		return;
	}
	const started = shell;
	linkStartupShell({
		get active() {
			return started.state === "painting" || started.state === "holding";
		},
		abort: () => {
			if (shell === started) shell = undefined;
			return started.abort();
		},
	});
}

/** The terminal the early editor is drawing on, for the session's interface to take over; undefined without one. */
export function startupShellTerminal(): ProcessTerminal | undefined {
	return shell !== undefined && (shell.state === "painting" || shell.state === "holding") ? shell.terminal : undefined;
}

/** The longest the session's interface waits for a paste into the early editor to arrive in full. */
const PASTE_END_WAIT_MS = 2_000;

/**
 * Resolves when the early editor may hand over: once no paste into it is still arriving, since the session's
 * interface asks the terminal questions as it starts, and a terminal answers in the middle of a paste it is still
 * sending. Waits at most {@link PASTE_END_WAIT_MS}.
 */
export async function whenStartupShellCanHandOver(): Promise<void> {
	const terminal = startupShellTerminal();
	if (terminal === undefined) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		terminal.whenPasteEnds(),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, PASTE_END_WAIT_MS);
		}),
	]);
	clearTimeout(timer);
}

/** The session's interface handles signals from here on, while the early editor may still draw. */
export function releaseStartupShellSignals(): void {
	shell?.releaseSignals();
}

/** Ends the early editor for the session's interface, which takes the terminal and the prompt (see `handOver`). */
export function handOverStartupShell(): StartupShellHandover | undefined {
	const handover = shell?.handOver();
	if (handover !== undefined) shell = undefined;
	return handover;
}

/** Ends the early editor and gives what was typed to the startup input capture (see `abort`). */
export function abortStartupShell(): void {
	const ended = shell;
	if (ended === undefined || (ended.state !== "painting" && ended.state !== "holding")) return;
	shell = undefined;
	linkStartupShell(undefined, ended.abort());
}
