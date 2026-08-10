import {
	ProcessTerminal,
	type Terminal,
	type TUI,
	TuiAltScreen,
	type TuiInputListener,
	TuiMainScreen,
	type TuiMode,
} from "@earendil-works/pi-tui";
import { openBrowser } from "../../utils/open-browser.ts";

export type InteractiveTui = TuiMainScreen | TuiAltScreen;

export interface InteractiveTuiOptions {
	tuiMode: TuiMode;
	showHardwareCursor: boolean;
	logDirectory: string;
	terminal?: Terminal;
	onRightClickPaste?: () => void;
	/** Return false to let a focused non-main component receive viewport keys. */
	shouldHandleViewportInput?: (data: string) => boolean;
}

const viewportInputListeners = new WeakSet<AtomicTuiAltScreen>();
const viewportInputGates = new WeakMap<AtomicTuiAltScreen, (data: string) => boolean>();

/**
 * Keeps fullscreen viewport navigation behind the host's focus policy while
 * retaining pi-tui's mouse, selection, and right-click paste handling.
 */
class AtomicTuiAltScreen extends TuiAltScreen {
	constructor(
		terminal: Terminal,
		showHardwareCursor: boolean,
		logDirectory: string,
		options: ConstructorParameters<typeof TuiAltScreen>[3],
		viewportInputGate?: (data: string) => boolean,
	) {
		super(terminal, showHardwareCursor, logDirectory, options);
		if (viewportInputGate) viewportInputGates.set(this, viewportInputGate);
	}

	override addInputListener(listener: TuiInputListener): () => void {
		if (!viewportInputListeners.has(this)) {
			viewportInputListeners.add(this);
			const gatedListener: TuiInputListener = (data) => {
				const gate = viewportInputGates.get(this);
				if (gate && !gate(data)) return undefined;
				return listener(data);
			};
			return super.addInputListener(gatedListener);
		}
		return super.addInputListener(listener);
	}
}

/** Creates the selected host-side renderer for an interactive session. */
export function createInteractiveTui(options: InteractiveTuiOptions): InteractiveTui {
	const terminal = options.terminal ?? new ProcessTerminal();
	if (options.tuiMode === "fullscreen") {
		return new AtomicTuiAltScreen(
			terminal,
			options.showHardwareCursor,
			options.logDirectory,
			{
				openUrl: openBrowser,
				onRightClickPaste: options.onRightClickPaste,
			},
			options.shouldHandleViewportInput,
		);
	}
	return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
}

/** Keeps existing components pointed at the renderer selected at runtime. */
export function createInteractiveTuiReference(getTui: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: unknown[]) => {
				const currentTui = getTui();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`TUI property ${String(property)} is not callable`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => Reflect.has(getTui(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	});
}
