import {
	isKeyRelease,
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
interface ViewportInputSubscription {
	gatedListener: TuiInputListener;
	unsubscribe?: () => void;
}

const viewportInputSubscriptions = new WeakMap<AtomicTuiAltScreen, ViewportInputSubscription>();

/**
 * The first `addInputListener` call is load-bearing: pi-tui 0.84.1 registers
 * its viewport listener from `TuiAltScreen`'s constructor
 * (`dist/tui-alt-screen.js:77`). Capture that listener so application
 * listeners can run before the focused-component gate.
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
			const subscription: ViewportInputSubscription = {
				gatedListener: (data) => this.routeViewportInput(listener, data),
			};
			viewportInputSubscriptions.set(this, subscription);
			return () => {
				subscription.unsubscribe?.();
				subscription.unsubscribe = undefined;
				// Keep the record and restore the internal listener if it was mounted;
				// pi-tui discards this constructor disposer, but later listeners may
				// still rely on the viewport listener remaining last in the chain.
				this.appendViewportInputListener();
			};
		}

		const subscription = viewportInputSubscriptions.get(this);
		subscription?.unsubscribe?.();
		if (subscription) subscription.unsubscribe = undefined;
		const unsubscribe = super.addInputListener(listener);
		this.appendViewportInputListener();
		return unsubscribe;
	}

	override start(): void {
		this.appendViewportInputListener();
		super.start();
	}

	private appendViewportInputListener(): void {
		const subscription = viewportInputSubscriptions.get(this);
		if (!subscription || subscription.unsubscribe) return;
		subscription.unsubscribe = super.addInputListener(subscription.gatedListener);
	}

	private routeViewportInput(listener: TuiInputListener, data: string): ReturnType<TuiInputListener> {
		const gate = viewportInputGates.get(this);
		if (!gate || gate(data)) return listener(data);

		const focused = this.getFocusedComponent();
		if (focused?.handleInput && (!isKeyRelease(data) || focused.wantsKeyRelease)) {
			const handleInput = focused.handleInput as (data: string) => boolean | undefined;
			if (handleInput.call(focused, data) === true) {
				// Match pi-tui's latency-sensitive focused-input path, which uses
				// its immediate render branch for keyboard input.
				this.requestRender(true);
				return { consume: true };
			}
		}

		listener(data);
		return { consume: true };
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
