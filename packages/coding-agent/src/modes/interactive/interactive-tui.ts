import {
	type Component,
	isKeyRelease,
	ProcessTerminal,
	type Terminal,
	type TUI,
	TuiAltScreen,
	type TuiInputListener,
	TuiMainScreen,
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
	showHardwareCursor: boolean;
	logDirectory: string;
	terminal?: Terminal;
	onRightClickPaste?: () => void;
	/**
	 * Return false to let a focused overlay receive viewport input first.
	 * Mouse input is deferred only while the focused component belongs to an
	 * overlay; non-overlay focus keeps pi-tui's transcript selection path.
	 */
	shouldHandleViewportInput?: (data: string, isMouseInput: boolean, focusedIsOverlay: boolean) => boolean;
	/** Handle an unconsumed overlay input before replaying it to the viewport. */
	onOverlayUnhandledInput?: (data: string) => boolean;
}

const viewportInputListeners = new WeakSet<AtomicTuiAltScreen>();

const viewportInputGates = new WeakMap<
	AtomicTuiAltScreen,
	(data: string, isMouseInput: boolean, focusedIsOverlay: boolean) => boolean
>();
const overlayUnhandledInputHandlers = new WeakMap<AtomicTuiAltScreen, (data: string) => boolean>();
interface ViewportInputSubscription {
	viewportUnsubscribe: () => void;
	routeListener: TuiInputListener;
	routeUnsubscribe: () => void;
}

const viewportInputSubscriptions = new WeakMap<AtomicTuiAltScreen, ViewportInputSubscription>();

/** Whether a mouse sequence belongs to the left-button selection gesture. */
function isLeftMouseSequence(data: string): boolean {
	const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1]!, 10);
		return (button & 64) === 0 && (button & 3) === 0;
	}
	// X10 release is encoded as button 3. pi-tui's selection handler rejects
	// that mask too, so only left press/motion codes are mirrored here.
	if (!data.startsWith("\x1b[M") || data.length !== 6) return false;
	const button = data.charCodeAt(3) - 32;
	return button >= 0 && (button & 64) === 0 && (button & 3) === 0;
}
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
		viewportInputGate?: (data: string, isMouseInput: boolean, focusedIsOverlay: boolean) => boolean,
		onOverlayUnhandledInput?: (data: string) => boolean,
	) {
		super(terminal, showHardwareCursor, logDirectory, options);
		if (viewportInputGate) viewportInputGates.set(this, viewportInputGate);
		if (onOverlayUnhandledInput) overlayUnhandledInputHandlers.set(this, onOverlayUnhandledInput);
	}

	/**
	 * Use pi-tui's own private predicate rather than duplicating its SGR/X10
	 * grammar. The dependency exposes this runtime method even though its
	 * declaration is private (`tui-alt-screen.d.ts:93`).
	 */
	private isPiTuiMouseSequence(data: string): boolean {
		const predicate = (this as unknown as Partial<TuiAltScreenMouseInternals>).isMouseSequence;
		return typeof predicate === "function" ? predicate.call(this, data) : false;
	}

	private isFocusedOverlay(): boolean {
		const tui = this as unknown as TuiOverlayInternals;
		return tui.overlayStack.some((entry) => entry.component === this.getFocusedComponent());
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
				if (gate && !gate(data, isMouseInput, this.isFocusedOverlay())) return undefined;
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

	/** Keep pi-tui's selection state in sync while an overlay handles a click. */
	private forwardSelectionMouseInput(viewportListener: TuiInputListener, data: string, focused: Component): void {
		if (isLeftMouseSequence(data) && this.getFocusedComponent() === focused) viewportListener(data);
	}
	private routeViewportInput(viewportListener: TuiInputListener, data: string): ReturnType<TuiInputListener> {
		const gate = viewportInputGates.get(this);
		const isMouseInput = gate ? this.isPiTuiMouseSequence(data) : false;
		if (!gate || gate(data, isMouseInput, this.isFocusedOverlay())) return undefined;

		// Returning `consume` below skips pi-tui's post-listener phase. Mirror its
		// overlay-focus repair before reading the focused component so a resize
		// cannot send a gated key to an invisible overlay.
		this.repairOverlayFocus();
		const focused = this.getFocusedComponent();
		const tui = this as unknown as TuiOverlayInternals;
		const handleOverlayUnhandledInput = (): boolean => {
			if (this.getFocusedComponent() !== focused || !this.isFocusedOverlay()) return false;
			return overlayUnhandledInputHandlers.get(this)?.(data) === true;
		};
		if (focused?.handleInput && (!isKeyRelease(data) || focused.wantsKeyRelease === true)) {
			const handleInput = focused.handleInput as (
				data: string,
			) => boolean | undefined | Promise<boolean | undefined>;
			const result = handleInput.call(focused, data);
			if (result instanceof Promise) {
				void result.then(
					(handled) => {
						if (handled === true) {
							this.forwardSelectionMouseInput(viewportListener, data, focused);
							tui.requestImmediateRender();
						} else if (handled === false && this.getFocusedComponent() === focused) {
							if (handleOverlayUnhandledInput()) tui.requestImmediateRender();
							else viewportListener(data);
						}
					},
					() => {
						if (this.getFocusedComponent() === focused) {
							if (handleOverlayUnhandledInput()) tui.requestImmediateRender();
							else viewportListener(data);
						}
					},
				);
				return { consume: true };
			}
			if (result === true) {
				this.forwardSelectionMouseInput(viewportListener, data, focused);
				tui.requestImmediateRender();
				return { consume: true };
			}
		}

		if (handleOverlayUnhandledInput()) {
			tui.requestImmediateRender();
			return { consume: true };
		}
		viewportListener(data);
		return { consume: true };
	}
}

/**
 * CI detection follows the convention CI providers actually use: the variable
 * is SET AND NONEMPTY, with any value. GitHub Actions sets `CI=true`, but
 * other providers and users export arbitrary values (`CI=github-actions`,
 * `CI=circleci`); an allowlist of truthy spellings let those reach the
 * alternate screen and write escape sequences into CI logs (Greptile P1 on
 * PR #2308). Only explicit opt-outs (`0`, `false`, empty) read as not-CI.
 */
function isCiEnvironment(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function shouldUseFullscreenTui(usesInjectedTerminal: boolean): boolean {
	if (process.env.TERM?.toLowerCase() === "dumb") return false;
	if (usesInjectedTerminal) return true;
	return process.stdin.isTTY === true && process.stdout.isTTY === true && !isCiEnvironment(process.env.CI);
}

/** Creates the fullscreen renderer for interactive TTY sessions. */
export function createInteractiveTui(options: InteractiveTuiOptions): InteractiveTui {
	const usesInjectedTerminal = options.terminal !== undefined;
	const terminal = options.terminal ?? new ProcessTerminal();
	if (!shouldUseFullscreenTui(usesInjectedTerminal)) {
		// The normal CLI never reaches the interactive mode without a TTY. Keep a
		// main-screen renderer for internal harnesses and guarded fallback paths.
		return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
	}
	return new AtomicTuiAltScreen(
		terminal,
		options.showHardwareCursor,
		options.logDirectory,
		{
			openUrl: openBrowser,
			onRightClickPaste: options.onRightClickPaste,
		},
		options.shouldHandleViewportInput,
		options.onOverlayUnhandledInput,
	);
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
