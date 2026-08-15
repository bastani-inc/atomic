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
import { TRANSCRIPT_JUMP_TO_END_URL } from "./components/transcript-follow-indicator.ts";

interface TuiOverlayEntry {
	component: Component;
	preFocus: Component | null;
}

interface InternalUiActionOverlay extends Component {
	handlesInternalUiAction?: boolean;
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
/** pi-tui 0.84.2 keeps this canonical mouse predicate private (tui-alt-screen.d.ts:114). */
interface TuiAltScreenMouseInternals {
	isMouseSequence(data: string): boolean;
}

/** pi-tui 0.84.2 keeps its overlay-deferral predicate private (tui-alt-screen.d.ts:84). */
interface TuiAltScreenViewportDeferral {
	shouldDeferViewportInputToOverlay?(): boolean;
}

/**
 * pi-tui 0.84.2 keeps its transcript-search state private
 * (tui-alt-screen.d.ts:50). Only the focus question is read here: pi-tui's own
 * `shouldDeferViewportInputToOverlay` asks it the same way
 * (`dist/tui-alt-screen.js:379`), and a missing field reads as "no find box".
 */
interface TuiAltScreenSearchInternals {
	activeSearch?: { overlay?: { isFocused(): boolean } };
}

export type InteractiveTui = TuiMainScreen | TuiAltScreen;

export function isOverlayMounted(tui: TUI, component: Component): boolean {
	const internals = tui as unknown as Partial<TuiOverlayInternals>;
	return (
		Array.isArray(internals.overlayStack) && internals.overlayStack.some((entry) => entry.component === component)
	);
}
export function getFocusedOverlay(tui: InteractiveTui): Component | undefined {
	const focused = tui.getFocusedComponent();
	if (!focused) return undefined;
	const internals = tui as unknown as Partial<TuiOverlayInternals>;
	if (!Array.isArray(internals.overlayStack) || typeof internals.isOverlayVisible !== "function") return undefined;
	const entry = internals.overlayStack.find((candidate) => candidate.component === focused);
	return entry && internals.isOverlayVisible(entry) ? focused : undefined;
}

export function handleFocusedOverlayInternalUiAction(tui: InteractiveTui, url: string): InternalUiActionResult {
	const overlay = getFocusedOverlay(tui);
	if (!overlay || (overlay as InternalUiActionOverlay).handlesInternalUiAction !== true) return undefined;
	const handleInput = overlay.handleInput as
		| ((data: string) => boolean | undefined | Promise<boolean | undefined>)
		| undefined;
	return handleInput?.call(overlay, url);
}

export type InternalUiActionResult = boolean | undefined | Promise<boolean | undefined>;

export interface InteractiveTuiOptions {
	showHardwareCursor: boolean;
	logDirectory: string;
	terminal?: Terminal;
	onRightClickPaste?: () => void;
	onOverlayInternalUiAction?: (url: string) => InternalUiActionResult;
	onInternalUiAction?: (url: string) => InternalUiActionResult;
	/**
	 * Return false to let a focused overlay receive viewport input first.
	 * Mouse input is deferred only while the focused component belongs to an
	 * overlay; non-overlay focus keeps pi-tui's transcript selection path.
	 * `focusedIsViewportSearch` marks the one overlay pi-tui mounts itself — its
	 * find box — which is exempt so the transcript still scrolls while a search
	 * is open.
	 */
	shouldHandleViewportInput?: (
		data: string,
		isMouseInput: boolean,
		focusedIsOverlay: boolean,
		focusedIsViewportSearch: boolean,
	) => boolean;
	/** Handle an unconsumed overlay input before replaying it to the viewport. */
	onOverlayUnhandledInput?: (data: string) => boolean;
}

export interface UrlActivationHandlers {
	onOverlayInternalUiAction?: (url: string) => InternalUiActionResult;
	onInternalUiAction?: (url: string) => InternalUiActionResult;
	openUrl: (url: string) => void;
}

function fallbackInternalUiAction(url: string, handlers: UrlActivationHandlers): void {
	handlers.onInternalUiAction?.(url);
}

function routeInternalUiAction(url: string, handlers: UrlActivationHandlers): void {
	let result: InternalUiActionResult;
	try {
		result = handlers.onOverlayInternalUiAction?.(url);
	} catch {
		fallbackInternalUiAction(url, handlers);
		return;
	}
	if (result instanceof Promise) {
		void result.then(
			(handled) => {
				if (handled !== true) fallbackInternalUiAction(url, handlers);
			},
			() => fallbackInternalUiAction(url, handlers),
		);
		return;
	}
	if (result !== true) fallbackInternalUiAction(url, handlers);
}

/** Route OSC 8 activation without allowing unknown internal URLs to escape to a browser. */
export function handleUrlActivation(url: string, handlers: UrlActivationHandlers): void {
	const internalUiScheme = "atomic-ui:";
	if (url.slice(0, internalUiScheme.length).toLowerCase() === internalUiScheme) {
		const schemeEnd = url.indexOf(":");
		const normalizedInternalUrl = `${url.slice(0, schemeEnd).toLowerCase()}${url.slice(schemeEnd)}`;
		// Forward the normalized URL: overlay-side matching is exact, so a
		// mixed-case scheme must not reach an overlay as an unrecognized string.
		if (normalizedInternalUrl === TRANSCRIPT_JUMP_TO_END_URL) routeInternalUiAction(normalizedInternalUrl, handlers);
		return;
	}

	handlers.openUrl(url);
}

const viewportInputListeners = new WeakSet<AtomicTuiAltScreen>();

type ViewportInputGate = (
	data: string,
	isMouseInput: boolean,
	focusedIsOverlay: boolean,
	focusedIsViewportSearch: boolean,
) => boolean;

const viewportInputGates = new WeakMap<AtomicTuiAltScreen, ViewportInputGate>();
const overlayUnhandledInputHandlers = new WeakMap<AtomicTuiAltScreen, (data: string) => boolean>();
/** Instances currently replaying overlay-declined input into pi-tui's viewport listener. */
const viewportInputReplays = new WeakSet<AtomicTuiAltScreen>();
interface ViewportInputSubscription {
	viewportUnsubscribe: () => void;
	routeListener: TuiInputListener;
	routeUnsubscribe: () => void;
}

const viewportInputSubscriptions = new WeakMap<AtomicTuiAltScreen, ViewportInputSubscription>();

/** A complete SGR or X10 mouse report extracted from an input chunk. */
interface ParsedMouseSequence {
	readonly data: string;
	readonly button: number;
	readonly isRelease: boolean;
}

const SGR_MOUSE_SEQUENCE = /^\x1b\[<(\d+);\d+;\d+([Mm])/;
const LEFT_MOUSE_MODIFIER_MASK = 4 | 8 | 16;

function parseMouseSequences(data: string): ParsedMouseSequence[] | undefined {
	if (data.length === 0) return undefined;
	const sequences: ParsedMouseSequence[] = [];
	let offset = 0;
	while (offset < data.length) {
		const remaining = data.slice(offset);
		const sgr = SGR_MOUSE_SEQUENCE.exec(remaining);
		if (sgr) {
			const sequence = sgr[0]!;
			sequences.push({ data: sequence, button: Number.parseInt(sgr[1]!, 10), isRelease: sgr[2] === "m" });
			offset += sequence.length;
			continue;
		}
		if (remaining.startsWith("\x1b[M") && remaining.length >= 6) {
			const sequence = remaining.slice(0, 6);
			sequences.push({ data: sequence, button: sequence.charCodeAt(3) - 32, isRelease: false });
			offset += 6;
			continue;
		}
		return undefined;
	}
	return sequences;
}

/** Whether every report in a mouse chunk is a vertical wheel event. */
export function isMouseWheelInput(data: string): boolean {
	const sequences = parseMouseSequences(data);
	return (
		sequences !== undefined &&
		sequences.length > 0 &&
		sequences.every(({ button }) => {
			const direction = button & 3;
			return (button & 64) !== 0 && (direction === 0 || direction === 1);
		})
	);
}

function isLeftMouseButton(sequence: ParsedMouseSequence): boolean {
	const { button } = sequence;
	if ((button & 64) !== 0) return false;
	const held = button & 3;
	// A release carries no button identity on the terminals upstream #7963
	// describes: they report the generic SGR code 3 rather than 0. pi-tui 0.84.2
	// ends a selection on `release && (button & 3) === 3`
	// (`dist/tui-alt-screen.js:796`), so a release Atomic drops here leaves the
	// press it already forwarded open — the selection never closes and the OSC 8
	// link under the press never activates. Shift, Meta/Option, and Ctrl are
	// application-bypass gestures on press and motion, but a release can retain
	// those bits and still has to close a selection.
	if (sequence.isRelease) return held === 0 || held === 3;
	return held === 0 && (button & LEFT_MOUSE_MODIFIER_MASK) === 0;
}

/** Whether a mouse chunk contains a left-button selection gesture. */
function isLeftMouseSequence(data: string): boolean {
	return parseMouseSequences(data)?.some((sequence) => isLeftMouseButton(sequence)) ?? false;
}

/**
 * Replay a chunk one report at a time because pi-tui parses one report per
 * call. Only a chunk whose every byte is a mouse report is split; anything else
 * is replayed verbatim.
 *
 * **Probe, pi 0.84.2 (upstream `2a95ef70`, `06ed8716`):** neither the
 * lone-ESC timeout scope nor the split-`Alt+Enter` reassembly is affected by
 * this replay. Both land in `StdinBuffer`/`ProcessTerminal`
 * (`dist/stdin-buffer.js:process`, `dist/terminal.js:48`), which assemble
 * complete sequences before any listener runs; Atomic builds pi-tui's own
 * `ProcessTerminal` in `createFullscreenTui`/`createInteractiveTui` below and
 * overrides neither the buffer nor its escape timeout. A reassembled `\x1b` or
 * `\x1b\r` reaches this function as one chunk, fails `parseMouseSequences`, and
 * is handed on unsplit — so a viewport action bound to `escape` or `alt+enter`
 * still matches after a decline.
 * Outcome: no breakage, no fix needed — covered by the replay probes in
 * `test/pi-0.84.2-overlay-viewport-deferral.test.ts`.
 */
function replayMouseInput(viewportListener: TuiInputListener, data: string): void {
	const sequences = parseMouseSequences(data);
	if (!sequences) {
		viewportListener(data);
		return;
	}
	for (const sequence of sequences) viewportListener(sequence.data);
}

/**
 * The first `addInputListener` call is load-bearing: pi-tui 0.84.2 registers
 * its viewport listener from `TuiAltScreen`'s constructor
 * (`dist/tui-alt-screen.js:85`). Keep the viewport wrapper first so mouse,
 * selection, and focus cleanup retain pi-tui's ordering. Put the focused-input
 * route last so application listeners still receive deferred viewport keys.
 */
class AtomicTuiAltScreen extends TuiAltScreen {
	constructor(
		terminal: Terminal,
		showHardwareCursor: boolean,
		logDirectory: string,
		options: ConstructorParameters<typeof TuiAltScreen>[3],
		viewportInputGate?: ViewportInputGate,
		onOverlayUnhandledInput?: (data: string) => boolean,
	) {
		super(terminal, showHardwareCursor, logDirectory, options);
		if (viewportInputGate) viewportInputGates.set(this, viewportInputGate);
		if (onOverlayUnhandledInput) overlayUnhandledInputHandlers.set(this, onOverlayUnhandledInput);
		// pi-tui 0.84.2 added `shouldDeferViewportInputToOverlay()`, which drops
		// viewport keys and wheel reports while an overlay holds focus (upstream
		// #7894). Atomic's gate offers that input to the focused overlay first and
		// replays only what the overlay declined (#2378 / PR #2381); pi-tui then
		// defers the replay a second time and the transcript freezes behind an
		// open dialog. Suppress the native answer for the replay alone. Input the
		// gate never routed through the overlay — every action outside
		// `FULLSCREEN_VIEWPORT_ACTIONS`, including a user-bound
		// `tui.altScreen.lineUp` — keeps pi-tui's own routing and still reaches
		// the focused component first.
		const deferral = this as unknown as TuiAltScreenViewportDeferral;
		const deferToOverlay = deferral.shouldDeferViewportInputToOverlay?.bind(this);
		deferral.shouldDeferViewportInputToOverlay = () => !viewportInputReplays.has(this) && deferToOverlay?.() === true;
	}

	/**
	 * Keep pi-tui's private predicate as the fallback for its single-report
	 * grammar. Injected terminals can deliver coalesced reports, so parse those
	 * chunks locally before asking pi-tui about an unparsed value.
	 */
	private isPiTuiMouseSequence(data: string): boolean {
		if (parseMouseSequences(data)) return true;
		const predicate = (this as unknown as Partial<TuiAltScreenMouseInternals>).isMouseSequence;
		return typeof predicate === "function" ? predicate.call(this, data) : false;
	}

	private isFocusedOverlay(): boolean {
		const tui = this as unknown as TuiOverlayInternals;
		return tui.overlayStack.some((entry) => entry.component === this.getFocusedComponent());
	}

	/**
	 * Whether the focused overlay is pi-tui's own transcript find box. That
	 * overlay is viewport chrome, so it is exempt from Atomic's gate: pi-tui
	 * exempts it from native deferral too (`dist/tui-alt-screen.js:379`), which
	 * is what keeps the transcript scrolling while a search is open.
	 */
	private isFocusedViewportSearch(): boolean {
		const { activeSearch } = this as unknown as TuiAltScreenSearchInternals;
		return activeSearch?.overlay?.isFocused() === true;
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
				if (gate && !gate(data, isMouseInput, this.isFocusedOverlay(), this.isFocusedViewportSearch()))
					return undefined;
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

	/** Keep pi-tui's selection state in sync while an overlay handles a left gesture. */
	private forwardSelectionMouseInput(viewportListener: TuiInputListener, data: string, focused: Component): void {
		if (this.getFocusedComponent() !== focused || !isLeftMouseSequence(data)) return;
		for (const sequence of parseMouseSequences(data) ?? []) {
			if (isLeftMouseButton(sequence)) viewportListener(sequence.data);
		}
	}
	/**
	 * Replay input the focused overlay declined. pi-tui's native overlay
	 * deferral is suppressed for the duration, because this chunk has already
	 * been offered to the overlay it would defer to.
	 */
	private replayViewportInput(viewportListener: TuiInputListener, data: string): void {
		viewportInputReplays.add(this);
		try {
			replayMouseInput(viewportListener, data);
		} finally {
			viewportInputReplays.delete(this);
		}
	}
	/** Dispatch a declined chunk to the host action the gated route owns. */
	private handleOverlayUnhandledInput(data: string, focused: Component | null): boolean {
		if (this.getFocusedComponent() !== focused || !this.isFocusedOverlay()) return false;
		return overlayUnhandledInputHandlers.get(this)?.(data) === true;
	}

	/**
	 * Finish a chunk a focused overlay's asynchronous handler declined.
	 *
	 * Every settled result other than `true` is a decline. The component
	 * contract is `boolean | undefined | Promise<boolean | undefined>`
	 * (`ExtensionCustomComponent`), and both `docs/tui.md` and
	 * `docs/extensions.md` document `false` *and* `undefined` as viewport
	 * fallthrough, so a promise resolving `undefined` has to replay exactly like
	 * one resolving `false` — matching only literal `false` consumed the key and
	 * froze the transcript. A rejection is a decline for the same reason: the
	 * overlay produced no answer.
	 *
	 * The focus guard stays: input that moved focus while the promise was
	 * pending belongs to whatever holds focus now, not to the transcript.
	 */
	private declineAsyncViewportInput(viewportListener: TuiInputListener, data: string, focused: Component): void {
		if (this.getFocusedComponent() !== focused) return;
		if (this.handleOverlayUnhandledInput(data, focused)) {
			(this as unknown as TuiOverlayInternals).requestImmediateRender();
			return;
		}
		this.replayViewportInput(viewportListener, data);
	}

	private routeViewportInput(viewportListener: TuiInputListener, data: string): ReturnType<TuiInputListener> {
		const gate = viewportInputGates.get(this);
		const isMouseInput = gate ? this.isPiTuiMouseSequence(data) : false;
		if (!gate || gate(data, isMouseInput, this.isFocusedOverlay(), this.isFocusedViewportSearch())) return undefined;

		// Returning `consume` below skips pi-tui's post-listener phase. Mirror its
		// overlay-focus repair before reading the focused component so a resize
		// cannot send a gated key to an invisible overlay.
		this.repairOverlayFocus();
		const focused = this.getFocusedComponent();
		const tui = this as unknown as TuiOverlayInternals;
		// pi-tui's find box is exempt from the gate for everything except a host
		// action, so a chunk that reaches here while it holds focus is a host
		// action by construction. Dispatch it before the query sees it: the
		// binding is user-remappable to a bare letter (`docs/keybindings.md`),
		// and pi-tui's `Input` inserts a printable character rather than
		// rejecting it the way it rejects `ctrl+t` — so offering it first typed
		// the key into the query and then ran the action. This is scoped to
		// pi-tui's own chrome; an application overlay keeps first refusal on
		// every key it is offered, host actions included.
		if (this.isFocusedViewportSearch() && this.handleOverlayUnhandledInput(data, focused)) {
			tui.requestImmediateRender();
			return { consume: true };
		}
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
							return;
						}
						this.declineAsyncViewportInput(viewportListener, data, focused);
					},
					() => this.declineAsyncViewportInput(viewportListener, data, focused),
				);
				return { consume: true };
			}
			if (result === true) {
				this.forwardSelectionMouseInput(viewportListener, data, focused);
				tui.requestImmediateRender();
				return { consume: true };
			}
		}

		if (this.handleOverlayUnhandledInput(data, focused)) {
			tui.requestImmediateRender();
			return { consume: true };
		}
		this.replayViewportInput(viewportListener, data);
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

/**
 * Build Atomic's fullscreen renderer, `viewportInputGate` included, without
 * consulting the environment. `createInteractiveTui` calls this whenever
 * fullscreen applies; fixtures that assert fullscreen behavior call it
 * directly, because `shouldUseFullscreenTui` returns the main-screen fallback
 * under `TERM=dumb` even for an injected terminal and would otherwise hand
 * those tests a renderer with no layout and no gate.
 */
export function createFullscreenTui(options: InteractiveTuiOptions): TuiAltScreen {
	return new AtomicTuiAltScreen(
		options.terminal ?? new ProcessTerminal(),
		options.showHardwareCursor,
		options.logDirectory,
		{
			openUrl: (url) =>
				handleUrlActivation(url, {
					onOverlayInternalUiAction: options.onOverlayInternalUiAction,
					onInternalUiAction: options.onInternalUiAction,
					openUrl: openBrowser,
				}),
			onRightClickPaste: options.onRightClickPaste,
		},
		options.shouldHandleViewportInput,
		options.onOverlayUnhandledInput,
	);
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
	return createFullscreenTui({ ...options, terminal });
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
