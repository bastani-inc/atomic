/**
 * A key typed into a view the isolated engine draws (an attached stage chat, a subagent chat, /tasks) paints within a
 * small factor of a key typed into the main chat, under the same load.
 *
 * The real host renderer and the real engine bridge (`RemoteComponentController` on the host, `EngineCustomUiService`
 * in the engine) run in one process here, joined by a message pump that delivers every message on a later turn of
 * the event loop, as the child's pipes do. Both views are composers over a long transcript. While keys arrive, a
 * stand-in for the engine's agents blocks the event loop in short bursts and streams into both views, so each key
 * may wait behind the same work whichever view it was typed into. Each key is timed from the terminal input to the
 * terminal write that shows it.
 */

import assert from "node:assert/strict";
import {
	type Component,
	Container,
	type OverlayHandle,
	ScrollView,
	stripTerminalSequences,
	Text,
	type TUI,
	type TuiAltScreen,
	VStack,
} from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import { shouldHandleFullscreenViewportInput } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { createFullscreenTui } from "../../packages/coding-agent/src/modes/interactive/interactive-tui.ts";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";
import { sleep } from "../helpers/runtime.js";

/** Keys per view: enough that the slow end is not the slowest keys alone, few enough to type in about three seconds. */
const KEYS_PER_VIEW = 200;
/**
 * The slow end of each view's latencies is read with this many keys slower than it. On a loaded machine the system can
 * stop the process for tens of milliseconds at any moment, and a key typed then is slow in whichever view it was typed;
 * a key in an engine-drawn view crosses the pipe twice, so it is caught by such a stop more often. One or two keys must
 * not decide the comparison: it takes more than this many slow keys to fail it.
 */
const TAIL_KEYS = 5;
const KEY_INTERVAL_MS = 15;
/** Keys per word: a word stays on one row of the 100-column composer, so its prefix is found whole. */
const WORD_LENGTH = 40;
const CLEAR_LINE = "\x15";
/** The agents' stand-in blocks the event loop this long, this often: a model turn's request preparation in bursts. */
const LOAD_BLOCK_MS = 2;
const LOAD_PERIOD_MS = 10;
const STREAM_PERIOD_MS = 30;
const TRANSCRIPT_LINES = 300;
/** The renderer's frame pacing: a repaint already paced when a key arrives finishes within one interval. */
const FRAME_INTERVAL_MS = 16;
/**
 * A key in an engine-drawn view crosses the pipe twice, and each crossing is a turn of the event loop that may wait
 * behind one burst of the load; the engine also renders the view, and either side may be painting streamed text when
 * the key arrives. Its budget is the main chat's latency doubled, plus a burst for each crossing and one frame
 * interval for that paint. A path that waits for a paced frame on both sides of the bridge, as it used to, takes two
 * frame intervals more than the main chat; the timer-free test above pins that path down exactly.
 */
const KEY_LATENCY_FACTOR = 2;
const KEY_LATENCY_SLACK_MS = 2 * LOAD_BLOCK_MS + FRAME_INTERVAL_MS;
/** Long enough for every key's paint to land under a loaded CI host; a missing paint fails the test outright. */
const PAINT_TIMEOUT_MS = 5_000;

class TimedTerminal extends RecordingTerminal {
	private readonly listeners = new Set<(text: string, at: number) => void>();
	override write(data: string): void {
		super.write(data);
		const text = stripTerminalSequences(data);
		const at = performance.now();
		for (const listener of this.listeners) listener(text, at);
	}
	onWrite(listener: (text: string, at: number) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

/** A composer under a transcript that grows while the agent streams: the shape of the main chat and a stage chat. */
class ChatPane implements Component {
	readonly editor: CustomEditor;
	renders = 0;
	private readonly transcript: Text;
	private readonly rows: () => number;
	private streamed = 0;

	constructor(tui: TUI, keybindings: KeybindingsManager, rows: () => number) {
		this.editor = new CustomEditor(tui, getEditorTheme(), keybindings);
		this.transcript = new Text(transcriptText(0), 0, 0);
		this.rows = rows;
	}

	stream(): void {
		this.streamed += 1;
		this.transcript.setText(transcriptText(this.streamed));
	}

	render(width: number): string[] {
		this.renders += 1;
		const editor = this.editor.render(width);
		const body = this.transcript.render(width);
		const visible = Math.max(0, this.rows() - editor.length);
		return [...body.slice(Math.max(0, body.length - visible)), ...editor];
	}

	/** Consumes every key, as the stage chat, the subagent chat and the task pages report a key they took. */
	handleInput(data: string): boolean {
		this.editor.handleInput(data);
		return true;
	}

	invalidate(): void {
		this.transcript.invalidate();
		this.editor.invalidate();
	}
}

function transcriptText(streamed: number): string {
	const lines = Array.from({ length: TRANSCRIPT_LINES }, (_, index) => `transcript line ${index}`);
	for (let index = 0; index < streamed; index++) lines.push(`streamed chunk ${index}`);
	return lines.join("\n");
}

function busy(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until) {
		// Stand-in for an agent's synchronous work.
	}
}

function quantile(samples: readonly number[], q: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? Number.NaN;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Types `keys` keys in words short enough for one composer row, clearing the composer between words. */
async function typeAndTime(terminal: TimedTerminal, keys: number): Promise<number[]> {
	const latencies: number[] = [];
	while (latencies.length < keys) {
		const word = randomWord(Math.min(WORD_LENGTH, keys - latencies.length));
		for (let index = 1; index <= word.length; index++) {
			const prefix = word.slice(0, index);
			const sent = performance.now();
			const painted = new Promise<number>((resolve, reject) => {
				const timer = setTimeout(() => {
					stop();
					reject(new Error(`the key that typed "${prefix}" never painted`));
				}, PAINT_TIMEOUT_MS);
				const stop = terminal.onWrite((text, at) => {
					if (!text.includes(prefix)) return;
					clearTimeout(timer);
					stop();
					resolve(at - sent);
				});
			});
			terminal.input(word[index - 1] ?? "");
			latencies.push(await painted);
			await sleep(KEY_INTERVAL_MS);
		}
		terminal.input(CLEAR_LINE);
		await sleep(KEY_INTERVAL_MS);
	}
	return latencies;
}

function randomWord(length: number): string {
	const alphabet = "bcdfghjkmnpqrstvwxz";
	let word = "q";
	while (word.length < length) word += alphabet[Math.floor(Math.random() * alphabet.length)];
	return word;
}

interface MountedViews {
	readonly tui: TuiAltScreen;
	readonly terminal: TimedTerminal;
	readonly main: ChatPane;
	readonly remote: ChatPane;
	readonly remoteTui: TUI;
	readonly overlay: OverlayHandle | undefined;
}

/** A full-screen overlay, as a stage or subagent chat opens; or inline under the main chat, as the task list opens. */
type Placement = "overlay" | "inline";

/** Rows of an inline engine-drawn view, so the main chat above it stays on screen. */
const INLINE_ROWS = 4;

/**
 * The main chat in the host's layout, and an engine-drawn chat in a full-screen overlay over it, joined through the
 * real bridge. Every message crosses the pump on a later turn of the event loop, as the child's pipes deliver them.
 */
async function mountViews(placement: Placement = "overlay"): Promise<MountedViews> {
	initTheme("dark", false);
	const keybindings = new KeybindingsManager();
	const terminal = new TimedTerminal();
	terminal.columns = 100;
	terminal.rows = 30;
	let mainEditor: Component = { render: () => [], invalidate: () => {} };
	// The interactive mode's own routing: typed keys reach the focused composer, the main one or an overlay's.
	const tui = createFullscreenTui({
		showHardwareCursor: false,
		logDirectory: "/tmp",
		terminal,
		shouldHandleViewportInput: (data, mouse, overlay) =>
			shouldHandleFullscreenViewportInput(tui.getFocusedComponent(), mainEditor, data, mouse, overlay, keybindings),
	}) as TuiAltScreen;
	const main = new ChatPane(tui, keybindings, () => terminal.rows);
	mainEditor = main.editor;
	const document = new Container();
	document.addChild(main);
	const inlineSlot = new Container();
	tui.setLayoutRoot(
		new VStack([
			{ component: new ScrollView(document, { follow: "end", primary: true }), grow: 1 },
			{ component: inlineSlot, shrink: 0 },
		]),
	);
	tui.setFocus(main);
	tui.start();
	cleanups.push(() => tui.stop());

	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	const service = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		setImmediate(() => {
			for (const listener of listeners) listener(message);
		});
	}, keybindings);
	cleanups.push(() => service.dispose());
	let overlay: OverlayHandle | undefined;
	const runtime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			const line = serializeInteractiveEngineFrame(command);
			setImmediate(() => service.handleLine(line));
		},
	} as unknown as IsolatedInteractiveRuntime;
	const controller = new RemoteComponentController(
		runtime,
		{
			requestRender: () => tui.requestRender(),
			setWidget: () => {},
			custom: ((factory, options) =>
				new Promise((resolve) => {
					const component = factory(tui, {} as never, keybindings, resolve) as Component;
					if (options?.overlay === true) {
						overlay = tui.showOverlay(component, options.overlayOptions as never);
						return;
					}
					inlineSlot.addChild(component);
					tui.setFocus(component);
				})) as ExtensionUIContext["custom"],
		},
		{ isFullscreen: () => true, onRendererReplaced: () => () => {} },
	);
	cleanups.push(() => controller.dispose());

	let remote: ChatPane | undefined;
	let remoteTui: TUI | undefined;
	void service.custom(
		(engineTui) => {
			remoteTui = engineTui;
			remote = new ChatPane(engineTui, keybindings, () =>
				placement === "overlay" ? engineTui.terminal.rows : INLINE_ROWS,
			);
			return remote;
		},
		placement === "overlay"
			? { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } }
			: {},
	);
	const mounted = () => remote !== undefined && (placement === "inline" || overlay !== undefined);
	for (let turn = 0; turn < 20 && !mounted(); turn++) await settleTurn();
	assert.ok(remote && remoteTui && mounted(), "the engine-drawn view did not mount");
	cleanups.push(() => overlay?.hide());
	// The renderer enters the alternate screen asynchronously; nothing is timed before it painted a frame.
	const deadline = performance.now() + PAINT_TIMEOUT_MS;
	while (!terminal.writes.some((data) => stripTerminalSequences(data).includes("transcript line"))) {
		assert.ok(performance.now() < deadline, "the renderer never painted its first frame");
		await sleep(5);
	}
	return { tui, terminal, main, remote, remoteTui, overlay };
}

function settleTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Runs pending ticks and pipe turns, but no timer: what paints now paints without waiting for a paced frame. */
async function paintsWithoutTimers(terminal: TimedTerminal, prefix: string): Promise<boolean> {
	let painted = false;
	const stop = terminal.onWrite((text) => {
		if (text.includes(prefix)) painted = true;
	});
	for (let turn = 0; turn < 20 && !painted; turn++) await settleTurn();
	stop();
	return painted;
}

test("a key in an engine-drawn view paints without waiting for a paced frame, as a key in the main chat does", async () => {
	const views = await mountViews();
	const overlay = views.overlay;
	assert.ok(overlay);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	cleanups.push(() => vi.useRealTimers());

	overlay.setHidden(true);
	views.tui.setFocus(views.main);
	views.terminal.input("q");
	views.terminal.input("w");
	assert.equal(await paintsWithoutTimers(views.terminal, "qw"), true, "the main chat paints a key at once");

	overlay.setHidden(false);
	overlay.focus();
	await vi.advanceTimersByTimeAsync(100);
	views.terminal.input("z");
	views.terminal.input("x");
	assert.equal(
		await paintsWithoutTimers(views.terminal, "zx"),
		true,
		"the engine-drawn view paints a key once its frame crosses the pipe, without a paced render on either side",
	);
});

test("a key in an engine-drawn view paints within a small factor of a key in the main chat under the same load", async () => {
	const views = await mountViews();
	const overlay = views.overlay;
	assert.ok(overlay);
	const load = setInterval(() => busy(LOAD_BLOCK_MS), LOAD_PERIOD_MS);
	const stream = setInterval(() => {
		views.main.stream();
		views.tui.requestRender();
		views.remote.stream();
		views.remoteTui.requestRender();
	}, STREAM_PERIOD_MS);
	cleanups.push(() => {
		clearInterval(load);
		clearInterval(stream);
	});

	// The overlay covers the main chat, so the main chat is timed with it hidden, under the same load.
	overlay.setHidden(true);
	views.tui.setFocus(views.main);
	const mainLatencies = await typeAndTime(views.terminal, KEYS_PER_VIEW);
	overlay.setHidden(false);
	overlay.focus();
	await sleep(100);
	const remoteLatencies = await typeAndTime(views.terminal, KEYS_PER_VIEW);

	const tail = 1 - TAIL_KEYS / KEYS_PER_VIEW;
	for (const [label, percentile] of [
		["p50", 0.5],
		[`p${tail * 100}`, tail],
	] as const) {
		const mainLatency = quantile(mainLatencies, percentile);
		const remoteLatency = quantile(remoteLatencies, percentile);
		assert.ok(
			remoteLatency <= mainLatency * KEY_LATENCY_FACTOR + KEY_LATENCY_SLACK_MS,
			`engine-drawn view key ${label} ${remoteLatency.toFixed(1)} ms exceeds ${KEY_LATENCY_FACTOR}x the main chat's ${mainLatency.toFixed(1)} ms + ${KEY_LATENCY_SLACK_MS} ms`,
		);
	}
});

test("a key in an inline engine-drawn view lays out the screen once, when the frame that shows it arrives", async () => {
	const views = await mountViews("inline");
	await sleep(100);
	// The layout measures the main chat and then paints it: an idle frame shows how many renders one frame costs.
	const idle = views.main.renders;
	views.tui.requestRender();
	await sleep(50);
	const rendersPerFrame = views.main.renders - idle;
	assert.ok(rendersPerFrame > 0);
	for (const key of "qwertyuiop") {
		const before = views.main.renders;
		const typed = views.remote.editor.getText() + key;
		const painted = new Promise<void>((resolve) => {
			const stop = views.terminal.onWrite((text) => {
				if (!text.includes(typed)) return;
				stop();
				resolve();
			});
		});
		views.terminal.input(key);
		await painted;
		await sleep(40);
		assert.equal(
			(views.main.renders - before) / rendersPerFrame,
			1,
			`the key "${key}" laid out the main chat in ${(views.main.renders - before) / rendersPerFrame} frames`,
		);
	}
});
