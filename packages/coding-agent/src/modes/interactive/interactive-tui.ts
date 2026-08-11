import {
	type Component,
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

interface TuiOverlayEntry {
	component: Component;
	preFocus: Component | null;
}

type TuiOverlayFocusRestore =
	| { status: "inactive" }
	| { status: "eligible"; overlay: TuiOverlayEntry }
	| {
			status: "blocked";
			overlay: TuiOverlayEntry;
			blockedBy: Component;
			resume: { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
	  };

interface TuiOverlayInternals {
	overlayStack: TuiOverlayEntry[];
	isOverlayVisible(entry: TuiOverlayEntry): boolean;
	getTopmostVisibleOverlay(): TuiOverlayEntry | undefined;
	setFocusInternal(options: { component: Component | null; overlayFocusRestore: "preserve" }): void;
	getVisibleOverlayFocusRestore(): TuiOverlayFocusRestore;
	clearOverlayFocusRestore(): void;
	requestImmediateRender(): void;
}
/** pi-tui 0.84.1 keeps this canonical mouse predicate private (tui-alt-screen.d.ts:93). */
interface TuiAltScreenMouseInternals {
	isMouseSequence(data: string): boolean;
}

export type InteractiveTui = TuiMainScreen | TuiAltScreen;

export interface InteractiveTuiOptions {
	tuiMode: TuiMode;
	showHardwareCursor: boolean;
	logDirectory: string;
	terminal?: Terminal;
	onRightClickPaste?: () => void;
	/**
	 * Return false to let a focused non-main component receive viewport input.
	 * The second argument is pi-tui's mouse classification.
	 */
	shouldHandleViewportInput?: (data: string, isMouseInput: boolean) => boolean;
}

const viewportInputListeners = new WeakSet<AtomicTuiAltScreen>();
const viewportInputGates = new WeakMap<AtomicTuiAltScreen, (data: string, isMouseInput: boolean) => boolean>();
interface ViewportInputSubscription {
	viewportUnsubscribe: () => void;
	routeListener: TuiInputListener;
	routeUnsubscribe: () => void;
}

const viewportInputSubscriptions = new WeakMap<AtomicTuiAltScreen, ViewportInputSubscription>();

/**
 * The first `addInputListener` call is load-bearing: pi-tui 0.84.1 registers
 * its viewport listener from `TuiAltScreen`'s constructor
 * (`dist/tui-alt-screen.js:77`). Keep the viewport wrapper first so mouse,
 * selection, and focus cleanup retain pi-tui's ordering. Put the focused-input
 * route last so application listeners still receive deferred viewport keys.
 */
class AtomicTuiAltScreen extends TuiAltScreen {
	constructor(
		terminal: Terminal,
		showHardwareCursor: boolean,
		logDirectory: string,
		options: ConstructorParameters<typeof TuiAltScreen>[3],
		viewportInputGate?: (data: string, isMouseInput: boolean) => boolean,
	) {
		super(terminal, showHardwareCursor, logDirectory, options);
		if (viewportInputGate) viewportInputGates.set(this, viewportInputGate);
	}

	/**
	 * Use pi-tui's own private predicate rather than duplicating its SGR/X10
	 * grammar. The dependency exposes this runtime method even though its
	 * declaration is private (`tui-alt-screen.d.ts:93`).
	 */
	private isPiTuiMouseSequence(data: string): boolean {
		return (this as unknown as TuiAltScreenMouseInternals).isMouseSequence(data);
	}

	override addInputListener(listener: TuiInputListener): () => void {
		if (!viewportInputListeners.has(this)) {
			viewportInputListeners.add(this);
			const subscription: ViewportInputSubscription = {
				viewportUnsubscribe: () => {},
				routeListener: (data) => this.routeViewportInput(listener, data),
				routeUnsubscribe: () => {},
			};
			viewportInputSubscriptions.set(this, subscription);
			subscription.viewportUnsubscribe = super.addInputListener((data) => {
				const gate = viewportInputGates.get(this);
				const isMouseInput = gate ? this.isPiTuiMouseSequence(data) : false;
				if (gate && !gate(data, isMouseInput)) return undefined;
				return listener(data);
			});
			subscription.routeUnsubscribe = super.addInputListener(subscription.routeListener);
			return () => {
				subscription.viewportUnsubscribe();
				subscription.routeUnsubscribe();
				viewportInputSubscriptions.delete(this);
				viewportInputListeners.delete(this);
			};
		}

		const subscription = viewportInputSubscriptions.get(this);
		if (!subscription) return super.addInputListener(listener);
		subscription.routeUnsubscribe();
		const unsubscribe = super.addInputListener(listener);
		subscription.routeUnsubscribe = super.addInputListener(subscription.routeListener);
		return unsubscribe;
	}

	private repairOverlayFocus(): void {
		const tui = this as unknown as TuiOverlayInternals;
		const focused = this.getFocusedComponent();
		const focusedOverlay = tui.overlayStack.find((entry) => entry.component === focused);
		if (focusedOverlay && !tui.isOverlayVisible(focusedOverlay)) {
			const topVisible = tui.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				tui.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		const focusIsOverlay = tui.overlayStack.some((entry) => entry.component === this.getFocusedComponent());
		if (focusIsOverlay) return;

		const restoreState = tui.getVisibleOverlayFocusRestore();
		if (restoreState.status === "eligible") {
			this.setFocus(restoreState.overlay.component);
		} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.getFocusedComponent()) {
			if (restoreState.resume.status === "restore-overlay") {
				this.setFocus(restoreState.overlay.component);
			} else {
				tui.clearOverlayFocusRestore();
				this.setFocus(restoreState.resume.target);
			}
		}
	}

	private routeViewportInput(viewportListener: TuiInputListener, data: string): ReturnType<TuiInputListener> {
		const gate = viewportInputGates.get(this);
		const isMouseInput = gate ? this.isPiTuiMouseSequence(data) : false;
		if (!gate || gate(data, isMouseInput)) return undefined;

		// Returning `consume` below skips pi-tui's post-listener phase. Mirror its
		// overlay-focus repair before reading the focused component so a resize
		// cannot send a gated key to an invisible overlay.
		this.repairOverlayFocus();
		const focused = this.getFocusedComponent();
		const tui = this as unknown as TuiOverlayInternals;
		if (focused?.handleInput && (!isKeyRelease(data) || focused.wantsKeyRelease === true)) {
			const handleInput = focused.handleInput as (
				data: string,
			) => boolean | undefined | Promise<boolean | undefined>;
			const result = handleInput.call(focused, data);
			if (result instanceof Promise) {
				void result.then(
					(handled) => {
						if (handled === true) tui.requestImmediateRender();
						else if (handled === false && this.getFocusedComponent() === focused) viewportListener(data);
					},
					() => {
						if (this.getFocusedComponent() === focused) viewportListener(data);
					},
				);
				return { consume: true };
			}
			if (result === true) {
				tui.requestImmediateRender();
				return { consume: true };
			}
		}

		viewportListener(data);
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
