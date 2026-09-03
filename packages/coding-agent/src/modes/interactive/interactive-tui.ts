import {
	type Component,
	compositeTuiLine,
	isKeyRelease,
	ProcessTerminal,
	type Terminal,
	type TUI,
	TuiAltScreen,
	type TuiInputListener,
	TuiMainScreen,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { stripOverlayActiveRowMarker } from "../../core/extensions/ui-types.ts";
import { isLifecycleTimingEnabled, markLifecycleTiming } from "../../core/lifecycle-timings.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { keyDisplayText } from "./components/keybinding-hints.ts";
import { TRANSCRIPT_JUMP_TO_END_URL } from "./components/transcript-follow-indicator.ts";
import { theme } from "./theme/theme.ts";

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

interface TuiAltScreenSelectionInternals {
	selectionAnchor?: unknown;
	selectionFocus?: unknown;
	selectionInitialRange?: unknown;
	selectionPressActive: boolean;
	selectionDragged: boolean;
	lastClick?: unknown;
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
	copyOnSelect?: boolean;
	onRightClickPaste?: () => void;
	onOverlayInternalUiAction?: (url: string) => InternalUiActionResult;
	onInternalUiAction?: (url: string) => InternalUiActionResult;
	/**
	 * Return false to let a focused overlay receive viewport input first.
	 * Mouse input is deferred only while the focused component belongs to an
	 * overlay; non-overlay focus keeps pi-tui's transcript selection path.
	 */
	shouldHandleViewportInput?: (
		data: string,
		isMouseInput: boolean,
		focusedIsOverlay: boolean,
		_focusedIsViewportSearch: boolean,
	) => boolean;
	/** Handle an unconsumed overlay input before replaying it to the viewport. */
	onOverlayUnhandledInput?: (data: string) => boolean;
	/**
	 * Copy selected text to the system clipboard; resolve false when the host
	 * clipboard never received it. Defaults to Atomic's `copyToClipboard` with
	 * its platform fallbacks, so pi-tui flashes "Copy failed" on a terminal
	 * whose clipboard stayed untouched (upstream #8110) instead of the old
	 * unconditional "Copied!". Injectable so hosts and tests observe the write.
	 */
	copySelection?: (text: string) => Promise<boolean>;
}

/** The default selection-copy route: Atomic's host clipboard write. */
async function copySelectionToHostClipboard(text: string): Promise<boolean> {
	try {
		await copyToClipboard(text);
		return true;
	} catch {
		return false;
	}
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
	_focusedIsViewportSearch: boolean,
) => boolean;

const viewportInputGates = new WeakMap<AtomicTuiAltScreen, ViewportInputGate>();
const overlayUnhandledInputHandlers = new WeakMap<AtomicTuiAltScreen, (data: string) => boolean>();
/** Instances currently replaying overlay-declined input into pi-tui's viewport listener. */
const viewportInputReplays = new WeakSet<AtomicTuiAltScreen>();
/** Selections begun over Atomic overlays must never trigger or survive into main-chat clipboard actions. */
const overlayOwnedSelections = new WeakSet<AtomicTuiAltScreen>();
interface ViewportInputSubscription {
	viewportUnsubscribe: () => void;
	routeListener: TuiInputListener;
	routeUnsubscribe: () => void;
}

const viewportInputSubscriptions = new WeakMap<AtomicTuiAltScreen, ViewportInputSubscription>();

interface ParsedMouseSequence {
	readonly data: string;
	readonly button: number;
	readonly x: number;
	readonly y: number;
	readonly isRelease: boolean;
}

interface ScrollToEndIndicatorRect {
	readonly row: number;
	readonly column: number;
	readonly width: number;
}

interface ScrollViewLayoutState {
	readonly followEnd?: boolean;
	readonly isFollowingEnd: boolean;
	readonly viewportHeight: number;
}

interface TuiLayoutBox {
	readonly clip: { x: number; y: number; width: number; height: number };
	readonly children: readonly TuiLayoutBox[];
	readonly scrollView?: ScrollViewLayoutState;
}

interface TuiLayoutFrame {
	readonly root: TuiLayoutBox;
	readonly width: number;
	readonly height: number;
	readonly primaryScrollView?: ScrollViewLayoutState;
}

interface TuiAltScreenLayoutInternals {
	readonly currentLayout?: TuiLayoutFrame;
}

const KITTY_IMAGE_PREFIX = "\x1b_G";
const ITERM2_IMAGE_PREFIX = "\x1b]1337;File=";

function isImageLine(line: string): boolean {
	return line.includes(KITTY_IMAGE_PREFIX) || line.includes(ITERM2_IMAGE_PREFIX);
}
const SGR_MOUSE_SEQUENCE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
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
			sequences.push({
				data: sequence,
				button: Number.parseInt(sgr[1]!, 10),
				x: Number.parseInt(sgr[2]!, 10) - 1,
				y: Number.parseInt(sgr[3]!, 10) - 1,
				isRelease: sgr[4] === "m",
			});
			offset += sequence.length;
			continue;
		}
		if (remaining.startsWith("\x1b[M") && remaining.length >= 6) {
			const sequence = remaining.slice(0, 6);
			sequences.push({
				data: sequence,
				button: sequence.charCodeAt(3) - 32,
				x: sequence.charCodeAt(4) - 33,
				y: sequence.charCodeAt(5) - 33,
				isRelease: false,
			});
			offset += 6;
			continue;
		}
		return undefined;
	}
	return sequences;
}

function findScrollViewBox(box: TuiLayoutBox, scrollView: ScrollViewLayoutState): TuiLayoutBox | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children) {
		const found = findScrollViewBox(child, scrollView);
		if (found) return found;
	}
	return undefined;
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
	private scrollToEndIndicatorRect: ScrollToEndIndicatorRect | undefined;

	private renderScrollToEndIndicator(): string {
		const shortcut = keyDisplayText("tui.altScreen.bottom");
		const label = ` ↓ Jump to latest message${shortcut ? ` · ${shortcut}` : ""} `;
		return theme.bg("selectedBg", theme.fg("text", label));
	}

	private compositeScrollToEndIndicator(screen: string[], width: number, height: number): string[] {
		const previousRect = this.scrollToEndIndicatorRect;
		this.scrollToEndIndicatorRect = undefined;
		const layout = (this as unknown as TuiAltScreenLayoutInternals).currentLayout;
		if (this.isFocusedOverlay()) return screen;
		if (!layout || layout.width !== width || layout.height !== height) {
			// pi-tui assigns currentLayout after compositing. If a detached view was
			// visible before its geometry changed, render once more with the new frame.
			if (previousRect) this.requestRender();
			return screen;
		}
		const scrollView = layout.primaryScrollView;
		if (!scrollView || scrollView.followEnd === false || scrollView.isFollowingEnd) return screen;

		const clip = findScrollViewBox(layout.root, scrollView)?.clip;
		if (!clip || clip.width <= 0 || clip.height <= 0) return screen;
		if (clip.height !== scrollView.viewportHeight) {
			// The layout belongs to the prior frame, but the shared ScrollView already
			// has the current dock-adjusted viewport height. Do not paint stale geometry.
			if (previousRect) this.requestRender();
			return screen;
		}
		const row = clip.y + clip.height - 1;
		if (row < 0 || row >= screen.length || isImageLine(screen[row] ?? "")) return screen;
		const text = truncateToWidth(this.renderScrollToEndIndicator(), clip.width, "");
		const textWidth = visibleWidth(text);
		if (textWidth === 0) return screen;
		const column = clip.x + Math.floor((clip.width - textWidth) / 2);
		const result = [...screen];
		result[row] = compositeTuiLine(result[row] ?? "", text, column, textWidth, width);
		if (result[row] === screen[row]) return screen;

		this.scrollToEndIndicatorRect = { row, column, width: textWidth };
		return result;
	}

	private handleScrollToEndIndicatorMouseInput(data: string): string | undefined {
		const rect = this.scrollToEndIndicatorRect;
		if (!rect) return undefined;
		const sequences = parseMouseSequences(data);
		const pressedIndex = sequences?.findIndex(
			(sequence) =>
				!sequence.isRelease &&
				(sequence.button & 32) === 0 &&
				isLeftMouseButton(sequence) &&
				sequence.y === rect.row &&
				sequence.x >= rect.column &&
				sequence.x < rect.column + rect.width,
		);
		if (pressedIndex === undefined || pressedIndex < 0 || !sequences) return undefined;

		this.scrollToEndIndicatorRect = undefined;
		this.scrollToBottom();
		return sequences
			.filter((_, index) => index !== pressedIndex)
			.map((sequence) => sequence.data)
			.join("");
	}

	protected override compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		return super.compositeOverlays(
			this.compositeScrollToEndIndicator(lines, termWidth, termHeight),
			termWidth,
			termHeight,
		);
	}

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
		// gate never routed through the overlay keeps pi-tui's routing and its
		// own deferral.
		const deferral = this as unknown as TuiAltScreenViewportDeferral;
		const deferToOverlay = deferral.shouldDeferViewportInputToOverlay?.bind(this);
		deferral.shouldDeferViewportInputToOverlay = () => !viewportInputReplays.has(this) && deferToOverlay?.() === true;
	}

	/**
	 * Last stop before pi-tui turns the composited screen into bytes, and where
	 * it already removes its own `CURSOR_MARKER`. Every component tree that this
	 * renderer paints converges here, so one strip covers the overlay, inline,
	 * widget, and workflows stage-chat mounts at once — including hosts that
	 * never call `ReservedBottomOverlay.takeActiveRow`. The mark is zero-width,
	 * so removing it after cursor extraction cannot move a column.
	 */
	protected override applyLineResets(lines: string[]): string[] {
		if (overlayOwnedSelections.has(this) && !this.isFocusedOverlay()) this.clearOverlayOwnedSelection();
		return stripOverlayActiveRowMarker(super.applyLineResets(lines));
	}

	private clearOverlayOwnedSelection(): void {
		const selection = this as unknown as TuiAltScreenSelectionInternals;
		selection.selectionAnchor = undefined;
		selection.selectionFocus = undefined;
		selection.selectionInitialRange = undefined;
		selection.selectionPressActive = false;
		selection.selectionDragged = false;
		selection.lastClick = undefined;
		overlayOwnedSelections.delete(this);
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
				if (gate && !gate(data, isMouseInput, this.isFocusedOverlay(), false)) return undefined;
				const remainingInput = this.handleScrollToEndIndicatorMouseInput(data);
				if (remainingInput !== undefined) {
					if (remainingInput.length > 0) listener(remainingInput);
					return { consume: true };
				}
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
		overlayOwnedSelections.add(this);
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
		if (!gate || gate(data, isMouseInput, this.isFocusedOverlay(), false)) return undefined;

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

class LifecycleTimingTerminal extends ProcessTerminal {
	override write(data: string): void {
		markLifecycleTiming("first-terminal-write");
		super.write(data);
	}
}

function createProcessTerminal(): ProcessTerminal {
	return isLifecycleTimingEnabled() ? new LifecycleTimingTerminal() : new ProcessTerminal();
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
		options.terminal ?? createProcessTerminal(),
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
			copyOnSelect: options.copyOnSelect,
			copySelection: options.copySelection ?? copySelectionToHostClipboard,
		},
		options.shouldHandleViewportInput,
		options.onOverlayUnhandledInput,
	);
}

/** Main-screen fallback renderer, carrying the same central mark strip as the fullscreen one. */
class AtomicTuiMainScreen extends TuiMainScreen {
	protected override applyLineResets(lines: string[]): string[] {
		return stripOverlayActiveRowMarker(super.applyLineResets(lines));
	}
}

/** Creates the fullscreen renderer for interactive TTY sessions. */
export function createInteractiveTui(options: InteractiveTuiOptions): InteractiveTui {
	const usesInjectedTerminal = options.terminal !== undefined;
	const terminal = options.terminal ?? createProcessTerminal();
	if (!shouldUseFullscreenTui(usesInjectedTerminal)) {
		// The normal CLI never reaches the interactive mode without a TTY. Keep a
		// main-screen renderer for internal harnesses and guarded fallback paths.
		return new AtomicTuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
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
