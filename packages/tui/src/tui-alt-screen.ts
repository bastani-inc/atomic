import {
	AltScreenSearchComponent,
	AltScreenSearchIndex,
	type AltScreenSearchMatch,
	getAltScreenSearchMatchKey,
} from "./alt-screen-search.ts";
import { type HintAction, type HintSpan, hintActionAt, readHintSpans } from "./clickable-hints.ts";
import { AltScreenFlashContainer } from "./components/alt-screen-flash.ts";
import { ScrollView } from "./components/scroll-view.ts";
import { WindowedContainer, type WindowRows } from "./components/windowed-container.ts";
import { getKeybindings } from "./keybindings.ts";
import { isKeyRelease } from "./keys.ts";
import {
	getLayoutBoxesAt,
	getScrollbarGeometry,
	getScrollContentRows,
	getScrollViewBox,
	getScrollViewsAt,
	type LayoutFrame,
	renderLayoutFrame,
	type ScrollbarGeometry,
} from "./layout.ts";
import { getLayoutNode } from "./layout-node.ts";
import type { Terminal } from "./terminal.ts";
import {
	deleteAllKittyImages,
	deleteAllKittyPlacements,
	deleteKittyImage,
	getCapabilities,
	getKittyImagePlacement,
	getKittyImagePlacementRows,
	type ImageProtocol,
	isImageLine,
	setCapabilities,
	type TerminalCapabilities,
} from "./terminal-image.ts";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	compositeTuiLine,
	dispatchMouseEvent,
	type OverlayHandle,
	retargetMouseEvent,
	TuiBase,
	type TuiMouseButton,
	type TuiMouseDispatchResult,
	type TuiMouseDispatchTarget,
	type TuiMouseEvent,
	type TuiStopOptions,
	VIEWPORT_TUI,
	type ViewportTUI,
} from "./tui.ts";
import {
	extractAnsiCode,
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	getWordSegmenter,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "./utils.ts";
import { WheelScrollAccelerator, type WheelScrollLines } from "./wheel-scroll.ts";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
const ENABLE_ALL_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
/** The Shift, Alt and Ctrl bits of an SGR mouse report's button. */
const MODIFIER_BUTTON_BITS = 4 | 8 | 16;
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
const EXIT_TRANSCRIPT_START = `${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}`;
const EXIT_TRANSCRIPT_END = `\x1b[0m${ENABLE_AUTOWRAP}\r\n\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
const EXIT_TRANSCRIPT_RESTORE = `\x1b[0m${ENABLE_AUTOWRAP}\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:;[^\x07\x1b]*)?(?:\x07|\x1b\\))+/;
const OSC133_PROMPT_START = /^\x1b\]133;A(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/;
const PAGE_SCROLL_OVERLAP = 4;
const ALT_WHEEL_SCROLL_MULTIPLIER = 5;
const MAX_CACHED_OFFSCREEN_KITTY_IMAGES = 16;
const MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES = 64 * 1024 * 1024;
const EXIT_WRITE_CHARACTERS = 16 * 1024;
const EXIT_PREPARE_ROWS = 512;
const EXIT_SLICE_BUDGET_MS = 8;
/** How soon a second press on the same spot must follow the first to make a double- or triple-click. */
export const MULTI_CLICK_INTERVAL_MS = 500;

/** Whole elapsed milliseconds: clock corrections must not move an outstanding click's deadline. */
function clickTime(): number {
	return Math.floor(performance.now());
}

const COPY_ERROR_FLASH_DURATION_MS = 5000;
// Regular mode delegates double-click selection to the terminal emulator. Fullscreen owns mouse selection,
// so it uses iTerm2's default "characters considered part of a word" set:
// https://github.com/gnachman/iTerm2/blob/7f4ff739721f95d0b93003d8701c4523a7edf261/sources/Settings/iTermPreferences.m#L743
const TERMINAL_WORD_SELECTION_JOINERS = new Set(["/", "-", "+", "\\", "~", "_", "."]);
const wordSegmenter = getWordSegmenter();

interface CachedKittyImage {
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
}

interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: ScrollView;
	/** Whether this point lies between terminal cells rather than on a cell. */
	boundary?: boolean;
}

interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

type SelectionGranularity = "character" | "word" | "line";

interface ClickTarget {
	timestamp: number;
	count: number;
	button: number;
	/** The handler that took the press, if it did not go to text selection. */
	component?: Component;
	/** The screen row, so clicks count alike whether or not an overlay changed how the press was located. */
	row: number;
	/** The screen columns of the word under the click, or of the clicked cell when no word is there. */
	wordStart: number;
	wordEnd: number;
	/** The screen column of the click. */
	col: number;
	/**
	 * What was drawn under the click: a click on another item drawn there since counts from one again. A click a
	 * component acted on, such as one that expanded a block, takes what the next paint draws there instead.
	 */
	drawn: readonly unknown[];
	/** Whether a component acted on the click, so the next paint shows what the click itself drew. */
	awaitingPaint: boolean;
}

/** What the screen showed at a pointer position: the painted row and the components drawn there. */
interface PointerFrame {
	readonly line: string | undefined;
	readonly hint: HintAction | undefined;
	/** Before the text selection was painted, including the row's original styling and links. */
	readonly unselectedLine: string | undefined;
	readonly highlighted: boolean;
	readonly boxes: readonly { readonly component: Component; readonly x: number; readonly y: number }[];
	/** The overlay drawn at the pointer and the rectangle it was drawn in, or undefined. */
	readonly overlay:
		| {
				readonly component: Component;
				readonly row: number;
				readonly col: number;
				readonly width: number;
				readonly height: number;
		  }
		| undefined;
	readonly decorated: boolean;
	/** The components drawn at the pointer, outermost first, then what the innermost reports for its row. */
	readonly drawn: readonly unknown[];
}

/** Whether the same components are drawn at the pointer in the same places: the frame's geometry there. */
function samePointerGeometry(a: PointerFrame | undefined, b: PointerFrame): boolean {
	return (
		a !== undefined &&
		a.overlay?.component === b.overlay?.component &&
		a.overlay?.row === b.overlay?.row &&
		a.overlay?.col === b.overlay?.col &&
		a.overlay?.width === b.overlay?.width &&
		a.overlay?.height === b.overlay?.height &&
		a.decorated === b.decorated &&
		a.boxes.length === b.boxes.length &&
		a.boxes.every(
			(box, index) =>
				box.component === b.boxes[index]?.component && box.x === b.boxes[index]?.x && box.y === b.boxes[index]?.y,
		)
	);
}

/**
 * The same geometry at the pointer, drawn by the same components naming the same item there. What a target that took
 * the press needs for its click: its own rows may repaint, as a pressed button's do, but it must still be drawn there.
 */
function sameDrawnAtPointer(a: PointerFrame | undefined, b: PointerFrame): boolean {
	return (
		a !== undefined &&
		(a.hint === b.hint ||
			(a.hint?.kind === "key" && b.hint?.kind === "key" && a.hint.key === b.hint.key) ||
			(a.hint?.kind === "command" && b.hint?.kind === "command" && a.hint.command === b.hint.command)) &&
		a.drawn.length === b.drawn.length &&
		a.drawn.every((item, index) => item === b.drawn[index]) &&
		samePointerGeometry(a, b)
	);
}

/** The same geometry at the pointer, and the same painted row under it, drawn by the same components. */
function samePointerFrame(a: PointerFrame | undefined, b: PointerFrame): boolean {
	return a !== undefined && a.line === b.line && sameDrawnAtPointer(a, b);
}

/** Bounds the walk into nested containers when recording what a frame drew at the pointer. */
const MAX_DRAWN_DEPTH = 32;

/** A component that stacks children, as `Container` does, and can say which child it drew on a row. */
type ChildRows = Component & Pick<Container, "childAtRow">;

function stacksChildren(component: Component): component is ChildRows {
	return typeof (component as Partial<ChildRows>).childAtRow === "function";
}

/**
 * The components a frame drew at `row` of `component`, laid out `width` wide, from `component` itself inward, then
 * the innermost one's row key. A root that draws the row itself is the only component named.
 */
function drawnAt(component: Component, width: number, row: number): unknown[] {
	const drawn: unknown[] = [component];
	let current: Component = component;
	let at = row;
	for (let depth = 0; depth < MAX_DRAWN_DEPTH && stacksChildren(current); depth++) {
		const hit = current.childAtRow(width, at);
		if (!hit) break;
		drawn.push(hit.component);
		current = hit.component;
		at = hit.row;
	}
	const innermost: Component = current;
	drawn.push(innermost.paintedRowKey?.(at));
	return drawn;
}

interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
	button: number;
}

interface ScrollbarDrag {
	scrollView: ScrollView;
	grabOffset: number;
}

interface ScrollbarTarget {
	scrollView: ScrollView;
	geometry: ScrollbarGeometry;
}

interface ScrollToEndIndicatorRect {
	row: number;
	column: number;
	width: number;
}

type SearchSelectionMode = "query" | "retain" | "next" | "previous";

interface ActiveSearch {
	component: AltScreenSearchComponent;
	index: AltScreenSearchIndex;
	overlay?: OverlayHandle;
	query: string;
	matches: AltScreenSearchMatch[];
	selectedIndex: number;
	selectedKey?: string;
	anchorRow: number;
	selectionMode: SearchSelectionMode;
}

interface SearchHighlightRange {
	startCol: number;
	endCol: number;
	current: boolean;
}

export interface TuiAltScreenOptions {
	/**
	 * Logical lines moved for each mouse-wheel event (default: 1). `"auto"` accelerates fast wheel
	 * spins on terminals that send one event per notch. Alt+wheel moves five times as far.
	 */
	wheelScrollLines?: WheelScrollLines;
	/** Capture mouse events for viewport scrolling and application-owned text selection. */
	mouse?: boolean;
	/** Style a non-current transcript search match. */
	searchMatchStyle?: (text: string) => string;
	/** Style the current transcript search match. */
	searchCurrentMatchStyle?: (text: string) => string;
	/** Style a transcript search navigation button. */
	searchNavigationButtonStyle?: (text: string, hovered: boolean) => string;
	/**
	 * Render a clickable jump-to-end label. It is centered on the last row of a follow-end
	 * primary scroll view while that view is scrolled away from its end.
	 */
	scrollToEndIndicator?: () => string;
	scrollPinnedPrompt?: { isPrompt: (row: string) => boolean; render: (promptRow: string) => string };
	/** Open an OSC 8 hyperlink activated with a primary-button click. */
	openUrl?: (url: string) => void;
	/** Handle an unmodified secondary-button press for clipboard paste. Currently enabled on Windows only. */
	onRightClickPaste?: () => void;
	/** Automatically copy selected text to the clipboard on mouse release (default: true). */
	copyOnSelect?: boolean;
	/**
	 * Copy selected text to the system clipboard. Return `true` on success, an error message to
	 * display on failure, or `false` for a generic error. When omitted, the selection is copied
	 * via an OSC 52 write.
	 */
	copySelection?: (text: string) => Promise<boolean | string>;
}

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
export class TuiAltScreen extends TuiBase implements ViewportTUI {
	readonly mode = "fullscreen" as const;
	readonly [VIEWPORT_TUI] = true as const;
	private previousScreen: string[] = [];
	private unselectedScreen: readonly string[] = [];
	private readonly highlightedRows = new Set<number>();
	private lastDocument: string[] = [];
	private exitWrites = 0;
	private previousScreenWidth = 0;
	private previousScreenHeight = 0;
	/** The last layout drawn had image lines, which an overlay does not cover. */
	private coveredLayoutHasImages = false;
	private layoutRoot: Component | undefined;
	private currentLayout: LayoutFrame | undefined;
	private readonly implicitDocument: Component;
	private readonly implicitScrollView: ScrollView;
	private readonly flashes: AltScreenFlashContainer;
	private altScreenActive = false;
	private imageProtocol: ImageProtocol = null;
	private savedCapabilities?: TerminalCapabilities;
	private readonly uploadedKittyImages = new Map<number, CachedKittyImage>();
	private selectionAnchor?: SelectionPoint;
	private selectionFocus?: SelectionPoint;
	private readonly selectedFragments = new Map<
		number,
		{ renderer: symbol; start: number; end: number; text: string }
	>();
	private selectionGranularity: SelectionGranularity = "character";
	private selectionInitialRange?: SelectionRange;
	private lastClick?: ClickTarget;
	private selectionDragPointer?: { x: number; y: number };
	private selectionAutoScrollDirection: -1 | 0 | 1 = 0;
	private selectionAutoScrollTimer?: NodeJS.Timeout;
	private selectionPressActive = false;
	private scrollbarDrag?: ScrollbarDrag;
	private scrollbarHover?: ScrollView;
	private scrollToEndIndicatorRect?: ScrollToEndIndicatorRect;
	private activeSearch?: ActiveSearch;
	private pressedUrl?: string;
	/** The key hint under the press, which the click that releases there runs. */
	private pressedHint?: HintAction;
	/** A press on a key hint is down: its drag and release go to the text selection. */
	private hintGestureActive = false;
	/** The key hints the last frame painted, by screen row. */
	private paintedHints: (readonly HintSpan[] | undefined)[] = [];
	/** What the screen showed under the pointer when the left button went down. */
	private pressFrame?: PointerFrame;
	/** Rows of the primary transcript that a drawn-over row covers: the pinned prompt and the jump-to-latest row. */
	private decoratedRows = new Map<number, { readonly x: number; readonly width: number }>();
	private selectionDragged = false;
	private mouseCapture?: TuiMouseDispatchTarget;
	private mousePressTarget?: TuiMouseDispatchTarget;
	private mousePressPoint?: { x: number; y: number };
	/** What the screen showed at a press a component took: its click needs the same geometry at the release. */
	private mousePressFrame?: PointerFrame;
	private mousePressMoved = false;
	/** Single clicks whose action waits until a second press can no longer continue them. */
	private readonly waitingSingleClicks = new Map<ClickTarget, TuiMouseDispatchResult>();
	private singleClickTimer?: NodeJS.Timeout;
	private readonly wheelScroll: WheelScrollAccelerator;
	private readonly mouseEnabled: boolean;
	private readonly searchMatchStyle: (text: string) => string;
	private readonly searchCurrentMatchStyle: (text: string) => string;
	private readonly searchNavigationButtonStyle: (text: string, hovered: boolean) => string;
	private readonly scrollToEndIndicator?: () => string;
	private readonly scrollPinnedPrompt?: TuiAltScreenOptions["scrollPinnedPrompt"];
	private readonly openUrl?: (url: string) => void;
	private readonly onRightClickPaste?: () => void;
	private copyOnSelect: boolean;
	private readonly copySelection?: (text: string) => Promise<boolean | string>;

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: TuiAltScreenOptions = {},
	) {
		super(terminal, showHardwareCursor, logDirectory);
		const implicitDocument: ChildRows = {
			render: (width) => super.render(width),
			handleMouse: (event) => super.handleMouse(event),
			childAtRow: (width, row) => super.childAtRow(width, row),
			invalidate: () => {
				for (const child of this.children) child.invalidate();
			},
		};
		this.implicitDocument = implicitDocument;
		this.implicitScrollView = new ScrollView(this.implicitDocument, { follow: "end", primary: true });
		this.flashes = new AltScreenFlashContainer(() => this.requestRender());
		this.wheelScroll = new WheelScrollAccelerator(options.wheelScrollLines ?? 1);
		this.mouseEnabled = options.mouse ?? true;
		this.searchMatchStyle = options.searchMatchStyle ?? ((text) => `\x1b[4m${text}\x1b[24m`);
		this.searchCurrentMatchStyle = options.searchCurrentMatchStyle ?? ((text) => `\x1b[1;7m${text}\x1b[22;27m`);
		this.searchNavigationButtonStyle = options.searchNavigationButtonStyle ?? ((text) => text);
		this.scrollToEndIndicator = options.scrollToEndIndicator;
		this.scrollPinnedPrompt = options.scrollPinnedPrompt;
		this.openUrl = options.openUrl;
		this.onRightClickPaste = options.onRightClickPaste;
		this.copyOnSelect = options.copyOnSelect ?? true;
		this.copySelection = options.copySelection;
		this.addInputListener((data) => this.handleViewportInput(data));
	}

	get viewportTop(): number {
		return this.getPrimaryScrollView().scrollTop;
	}

	get isFollowingOutput(): boolean {
		return this.getPrimaryScrollView().isFollowingEnd;
	}

	setWheelScrollLines(lines: WheelScrollLines): void {
		this.wheelScroll.setLines(lines);
	}

	getCopyOnSelect(): boolean {
		return this.copyOnSelect;
	}

	setCopyOnSelect(enabled: boolean): void {
		this.copyOnSelect = enabled;
	}

	/** Whether the fullscreen viewport has a non-empty active text selection. */
	hasActiveSelection(): boolean {
		return this.getSelectionBounds() !== undefined;
	}

	/** Copy the active fullscreen text selection, if any, using the configured selection clipboard path. */
	async copyActiveSelectionToClipboard(): Promise<boolean> {
		const text = this.getActiveSelectionText();
		if (!text) return false;
		return this.copyTextToClipboard(text);
	}

	/** Drop the text selection and multi-click history, e.g. before the host replaces the transcript. */
	resetTextSelection(): void {
		this.dropWaitingSingleClicks();
		this.clearComponentMouseGesture();
		this.clearTextSelection();
		this.lastClick = undefined;
	}

	/** The lines of the last rendered frame, one per terminal row, as written to the terminal. */
	getScreenLines(): string[] {
		return [...this.previousScreen];
	}

	setLayoutRoot(component: Component | undefined): void {
		if (this.layoutRoot === component) return;
		this.layoutRoot = component;
		this.currentLayout = undefined;
		this.requestRender();
	}

	override render(width: number): string[] {
		return this.layoutRoot?.render(width) ?? super.render(width);
	}

	protected override getMountedRoots(): readonly Component[] {
		return this.layoutRoot ? [this.layoutRoot] : this.children;
	}

	private getPrimaryScrollView(): ScrollView {
		return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
	}

	protected override beforeTerminalStart(): void {
		this.exitWrites++;
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.flashes.dispose();
		this.altScreenActive = true;
		const capabilities = getCapabilities();
		this.imageProtocol = capabilities.images;
		this.uploadedKittyImages.clear();
		if (capabilities.images === "iterm2") {
			this.savedCapabilities = capabilities;
			setCapabilities({ ...capabilities, images: null });
			this.invalidate();
		}
		this.lastDocument = [];
		this.selectedFragments.clear();
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.pressedHint = undefined;
		this.hintGestureActive = false;
		this.paintedHints = [];
		this.selectionDragged = false;
		this.clearComponentMouseGesture();
		this.resetRenderState();
		const term = process.env.TERM?.toLowerCase() ?? "";
		// Multiplexers can lag when every pointer movement is forwarded. Button-motion
		// tracking preserves clicks, wheel events, selections, and scrollbar dragging.
		const mouseSequence =
			process.env.TMUX !== undefined ||
			process.env.ZELLIJ !== undefined ||
			process.env.STY !== undefined ||
			term.startsWith("tmux") ||
			term.startsWith("screen")
				? ENABLE_BUTTON_MOTION_MOUSE
				: ENABLE_ALL_MOTION_MOUSE;
		this.terminal.write(
			`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? mouseSequence : ""}\x1b[2J\x1b[H\x1b[?25l`,
		);
	}

	protected override beforeTerminalStop(_options: TuiStopOptions): void {
		this.selectedFragments.clear();
		this.closeSearch();
		this.dropWaitingSingleClicks();
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.clearComponentMouseGesture();
		this.flashes.dispose();
		if (!this.altScreenActive) return;
		this.terminal.write(
			`${BEGIN_SYNCHRONIZED_OUTPUT}${this.deleteKittyImages()}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${END_SYNCHRONIZED_OUTPUT}`,
		);
		this.uploadedKittyImages.clear();
	}

	protected override afterTerminalStop(options: TuiStopOptions): void {
		if (!this.altScreenActive) return;
		this.altScreenActive = false;
		const savedCapabilities = this.savedCapabilities;
		this.savedCapabilities = undefined;
		const restoreCapabilities = () => {
			if (savedCapabilities) setCapabilities(savedCapabilities);
		};
		if (options.preserveScreen) {
			this.terminal.write(`${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`);
		} else if (options.writeInSlices) {
			const restoreOnExit = (): void => {
				try {
					this.terminal.restoreOnExit?.(EXIT_TRANSCRIPT_RESTORE, "");
				} catch {}
			};
			process.on("exit", restoreOnExit);
			this.stopOutput = this.writeTranscriptInSlices(++this.exitWrites).then(
				() => {
					process.off("exit", restoreOnExit);
					restoreCapabilities();
				},
				async (error: unknown) => {
					restoreCapabilities();
					try {
						this.terminal.write(EXIT_TRANSCRIPT_RESTORE);
						await this.terminal.flush?.();
						process.off("exit", restoreOnExit);
					} catch {}
					throw error;
				},
			);
			return;
		} else {
			const width = Math.max(1, this.terminal.columns);
			this.lastDocument = this.prepareExitRows(this.render(width), width);
			let buffer = EXIT_TRANSCRIPT_START;
			for (let row = 0; row < this.lastDocument.length; row++) {
				if (row > 0) buffer += "\r\n";
				buffer += `\r\x1b[2K${this.lastDocument[row] ?? ""}`;
			}
			buffer += EXIT_TRANSCRIPT_END;
			this.terminal.write(buffer);
		}
		restoreCapabilities();
	}

	private prepareExitRows(lines: string[], width: number): string[] {
		const documentLines = this.resolveFakeCursors(lines).map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
		return this.applyLineResets(documentLines.map((line) => line.replaceAll(CURSOR_MARKER, ""))).map((line) =>
			isImageLine(line) || visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true),
		);
	}

	private async writeTranscriptInSlices(write: number): Promise<void> {
		const width = Math.max(1, this.terminal.columns);
		const lines =
			this.layoutRoot instanceof WindowedContainer
				? await this.layoutRoot.renderInSlices(width)
				: this.render(width);
		let deadline = performance.now() + EXIT_SLICE_BUDGET_MS;
		const proceed = async (): Promise<boolean> => {
			if (performance.now() >= deadline) {
				await new Promise((resolve) => setImmediate(resolve));
				deadline = performance.now() + EXIT_SLICE_BUDGET_MS;
			}
			return write === this.exitWrites;
		};
		let buffer = EXIT_TRANSCRIPT_START;
		const writeBuffer = async (minimum: number): Promise<boolean> => {
			while (buffer.length > 0 && buffer.length >= minimum) {
				let end = Math.min(buffer.length, EXIT_WRITE_CHARACTERS);
				const last = buffer.charCodeAt(end - 1);
				if (end < buffer.length && end > 1 && last >= 0xd800 && last <= 0xdbff) end--;
				this.terminal.write(buffer.slice(0, end));
				buffer = buffer.slice(end);
				await this.terminal.flush?.();
				if (!(await proceed())) return false;
			}
			return true;
		};
		for (let start = 0; start < lines.length; start += EXIT_PREPARE_ROWS) {
			const rows = this.prepareExitRows(lines.slice(start, start + EXIT_PREPARE_ROWS), width);
			for (let index = 0; index < rows.length; index++) {
				if (start + index > 0) buffer += "\r\n";
				buffer += `\r\x1b[2K${rows[index] ?? ""}`;
			}
			if (!(await writeBuffer(EXIT_WRITE_CHARACTERS)) || !(await proceed())) return;
		}
		buffer += EXIT_TRANSCRIPT_END;
		await writeBuffer(0);
	}

	protected override getExitRestorePrefix(): string {
		const prefix = super.getExitRestorePrefix();
		if (!this.altScreenActive) return prefix;
		return `${END_SYNCHRONIZED_OUTPUT}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${prefix}`;
	}

	protected override getExitRestoreSuffix(): string {
		// Kitty keyboard flags are per screen, so the terminal pops them before the alternate screen is left.
		return `${super.getExitRestoreSuffix()}${this.altScreenActive ? `${EXIT_ALT_SCREEN}\x1b[?25h` : ""}`;
	}

	private deleteKittyImages(): string {
		return this.imageProtocol === "kitty" ? deleteAllKittyImages() : "";
	}

	private prepareKittyScreen(screen: string[]): { lines: string[]; evictedImageDeletion: string } {
		const visibleImageIds = new Set<number>();
		const lines = screen.map((line) => {
			const placement = getKittyImagePlacement(line);
			if (!placement) return line;
			visibleImageIds.add(placement.imageId);

			const cachedImage = this.uploadedKittyImages.get(placement.imageId);
			const nextCachedImage = {
				transmissionGeneration: placement.transmissionGeneration,
				transmissionBytes: placement.transmissionBytes,
				estimatedDecodedBytes: placement.estimatedDecodedBytes,
			};
			if (cachedImage) this.uploadedKittyImages.delete(placement.imageId);
			this.uploadedKittyImages.set(placement.imageId, nextCachedImage);

			return cachedImage?.transmissionGeneration === placement.transmissionGeneration
				? placement.replacementLine
				: line;
		});

		let cachedOffscreenImageCount = 0;
		let cachedOffscreenTransmissionBytes = 0;
		let cachedOffscreenDecodedBytes = 0;
		for (const [imageId, cachedImage] of this.uploadedKittyImages) {
			if (visibleImageIds.has(imageId)) continue;
			cachedOffscreenImageCount += 1;
			cachedOffscreenTransmissionBytes += cachedImage.transmissionBytes;
			cachedOffscreenDecodedBytes += cachedImage.estimatedDecodedBytes;
		}

		let evictedImageDeletion = "";
		for (const [imageId, cachedImage] of this.uploadedKittyImages) {
			if (
				cachedOffscreenImageCount <= MAX_CACHED_OFFSCREEN_KITTY_IMAGES &&
				cachedOffscreenTransmissionBytes <= MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES &&
				cachedOffscreenDecodedBytes <= MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES
			) {
				break;
			}
			if (visibleImageIds.has(imageId)) continue;
			evictedImageDeletion += deleteKittyImage(imageId);
			this.uploadedKittyImages.delete(imageId);
			cachedOffscreenImageCount -= 1;
			cachedOffscreenTransmissionBytes -= cachedImage.transmissionBytes;
			cachedOffscreenDecodedBytes -= cachedImage.estimatedDecodedBytes;
		}
		return { lines, evictedImageDeletion };
	}

	protected override resetRenderState(): void {
		this.previousScreen = [];
		this.previousScreenWidth = 0;
		this.previousScreenHeight = 0;
		this.currentLayout = undefined;
	}

	scrollBy(lines: number): void {
		this.getPrimaryScrollView().scrollBy(lines);
		this.requestRender();
	}

	scrollToTop(): void {
		this.getPrimaryScrollView().scrollToStart();
		this.requestRender();
	}

	scrollToBottom(): void {
		this.getPrimaryScrollView().scrollToEnd();
		this.requestRender();
	}

	private scrollToPrompt(direction: -1 | 1): void {
		if (!this.currentLayout) return;
		const scrollView = this.getPrimaryScrollView();
		if (this.settleScrollContent(scrollView)) this.currentLayout = this.layoutFrame();
		const lines = getScrollContentRows(getScrollViewBox(this.currentLayout, scrollView));
		if (!lines) return;

		for (let row = scrollView.scrollTop + direction; row >= 0 && row < lines.length; row += direction) {
			if (!OSC133_PROMPT_START.test(lines.at(row) ?? "")) continue;
			scrollView.scrollTo(row);
			this.requestRender();
			return;
		}
	}

	private toggleSearch(): void {
		if (this.activeSearch) {
			this.closeSearch();
			return;
		}
		const component = new AltScreenSearchComponent(
			(query) => this.updateSearchQuery(query),
			this.searchNavigationButtonStyle,
		);
		const search: ActiveSearch = {
			component,
			index: new AltScreenSearchIndex(),
			query: "",
			matches: [],
			selectedIndex: -1,
			anchorRow: this.getPrimaryScrollView().scrollTop,
			selectionMode: "query",
		};
		this.activeSearch = search;
		search.overlay = this.showOverlay(component, {
			anchor: "top-right",
			width: "40%",
			minWidth: 32,
			margin: 1,
		});
	}

	private closeSearch(): void {
		const search = this.activeSearch;
		if (!search) return;
		this.activeSearch = undefined;
		search.overlay?.hide();
		this.requestRender();
	}

	private updateSearchQuery(query: string): void {
		const search = this.activeSearch;
		if (!search || query === search.query) return;
		const selected = search.matches[search.selectedIndex];
		search.anchorRow = selected?.segments[0]?.row ?? this.getPrimaryScrollView().scrollTop;
		search.query = query;
		search.selectionMode = "query";
		search.component.setResult(-1, 0);
		this.requestRender();
	}

	private navigateSearch(direction: -1 | 1): void {
		const search = this.activeSearch;
		if (!search?.query) return;
		search.selectionMode = direction < 0 ? "previous" : "next";
		this.requestRender();
	}

	private getSearchNavigationDirectionAt(x: number, y: number): -1 | 1 | undefined {
		const search = this.activeSearch;
		const bounds = search?.overlay?.getBounds();
		if (!search || !bounds) return undefined;
		if (x < bounds.col || x >= bounds.col + bounds.width || y < bounds.row || y >= bounds.row + bounds.height) {
			return undefined;
		}
		return search.component.getNavigationDirectionAt(y - bounds.row, x - bounds.col);
	}

	private handleSearchMouseEvent(event: SgrMouseEvent): boolean {
		const search = this.activeSearch;
		if (!search) return false;
		const direction = this.getSearchNavigationDirectionAt(event.x, event.y);
		if (search.component.setHoveredNavigationDirection(direction)) this.requestRender();
		if (direction === undefined || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) {
			return false;
		}
		this.navigateSearch(direction);
		return true;
	}

	private refreshSearch(layout: LayoutFrame): boolean {
		const search = this.activeSearch;
		if (!search) return false;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		const box = getScrollViewBox(layout, scrollView);
		const rows = getScrollContentRows(box);
		if (!rows || !search.query.trim()) {
			search.matches = [];
			search.selectedIndex = -1;
			search.selectedKey = undefined;
			search.selectionMode = "retain";
			search.component.setResult(-1, 0);
			return false;
		}

		const shouldRevealSelection = search.selectionMode !== "retain";
		const lines = Array.isArray(rows) ? rows : Array.from({ length: rows.length }, (_, row) => rows.at(row) ?? "");
		const result = search.index.search(lines, search.query);
		const matches = result.matches;
		search.matches = matches;
		if (!result.changed && search.selectionMode === "retain") return false;

		const exactIndex = result.changed
			? search.selectedKey
				? matches.findIndex((match) => getAltScreenSearchMatchKey(match) === search.selectedKey)
				: -1
			: search.selectedIndex;
		let selectedIndex = -1;
		if (matches.length > 0) {
			if (search.selectionMode === "query") {
				let low = 0;
				let high = matches.length;
				while (low < high) {
					const middle = low + Math.floor((high - low) / 2);
					if ((matches[middle]!.segments[0]?.row ?? 0) < search.anchorRow) low = middle + 1;
					else high = middle;
				}
				selectedIndex = low < matches.length ? low : 0;
			} else if (search.selectionMode === "next") {
				const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
				selectedIndex = baseIndex < 0 ? 0 : (baseIndex + 1) % matches.length;
			} else if (search.selectionMode === "previous") {
				const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
				selectedIndex = baseIndex < 0 ? matches.length - 1 : (baseIndex - 1 + matches.length) % matches.length;
			} else {
				selectedIndex =
					exactIndex >= 0 ? exactIndex : Math.min(Math.max(0, search.selectedIndex), matches.length - 1);
			}
		}

		search.selectedIndex = selectedIndex;
		search.selectedKey = selectedIndex >= 0 ? getAltScreenSearchMatchKey(matches[selectedIndex]!) : undefined;
		search.selectionMode = "retain";
		search.component.setResult(selectedIndex, matches.length);
		if (!shouldRevealSelection) return false;

		const selected = matches[selectedIndex];
		const firstSegment = selected?.segments[0];
		const lastSegment = selected?.segments[selected.segments.length - 1];
		if (!box || !firstSegment || !lastSegment || scrollView.viewportHeight <= 0) return false;
		const before = scrollView.scrollTop;
		const visibleBottom = before + scrollView.viewportHeight - 1;
		let target = before;
		if (firstSegment.row < before || lastSegment.row > visibleBottom) {
			target = firstSegment.row - Math.floor(scrollView.viewportHeight / 3);
		}
		scrollView.scrollTo(target, { disableFollow: true });
		return scrollView.scrollTop !== before;
	}

	private isCurrentSearchMatchOnRow(row: number): boolean {
		const search = this.activeSearch;
		const selected = search && search.selectedIndex >= 0 ? search.matches[search.selectedIndex] : undefined;
		return selected?.segments.some((segment) => segment.row === row) ?? false;
	}

	/** Show a transient message in the alternate-screen flash stack. */
	flash(message: string, durationMs?: number): void {
		this.flashes.flash(message, durationMs);
	}

	/** Focused overlays and components that capture viewport input receive viewport keys instead of the transcript. */
	private shouldDeferViewportInput(): boolean {
		if (this.getFocusedComponent()?.capturesViewportInput) return true;
		return this.isOverlayFocused() && this.activeSearch?.overlay?.isFocused() !== true;
	}

	private clearComponentMouseGesture(): void {
		this.mouseCapture = undefined;
		this.mousePressTarget = undefined;
		this.mousePressPoint = undefined;
		this.mousePressFrame = undefined;
		this.mousePressMoved = false;
	}

	private handleViewportInput(data: string): { consume?: boolean } | undefined {
		if (data === FOCUS_OUT) {
			this.dropWaitingSingleClicks();
			const hadActiveSelection = this.selectionPressActive;
			const hadNonEmptyActiveSelection = hadActiveSelection && this.getSelectionBounds() !== undefined;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			this.stopScrollbarHover();
			if (this.activeSearch?.component.setHoveredNavigationDirection(undefined)) this.requestRender();
			this.stopScrollbarDrag();
			this.pressedUrl = undefined;
			this.pressedHint = undefined;
			this.hintGestureActive = false;
			this.selectionDragged = false;
			this.clearComponentMouseGesture();
			if (hadActiveSelection) {
				this.selectedFragments.clear();
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				this.selectionGranularity = "character";
				this.selectionInitialRange = undefined;
				if (hadNonEmptyActiveSelection) this.requestRender();
			}
			this.lastClick = undefined;
			return { consume: true };
		}
		if (data === FOCUS_IN) return { consume: true };

		const wheelEvent = this.parseWheelEvent(data);
		if (wheelEvent) {
			this.lastClick = undefined;
			const lines = this.wheelScroll.next(wheelEvent.direction, performance.now());
			// SGR mouse button codes use bit 3 (value 8) for the Alt modifier.
			const wheelDelta =
				wheelEvent.direction * ((wheelEvent.button & 8) !== 0 ? lines * ALT_WHEEL_SCROLL_MULTIPLIER : lines);
			const event = this.createMouseEvent("wheel", wheelEvent.button, wheelEvent.x, wheelEvent.y, { wheelDelta });
			const overlay = this.dispatchMouseToOverlay(event);
			const result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(event));
			if (result) {
				if (this.applyMouseDispatchResult(event, result)) this.requestRender();
				return { consume: true };
			}
			this.routeWheel(wheelEvent, wheelDelta);
			return { consume: true };
		}
		const mouseEvent = this.parseSgrMouseEvent(data);
		if (mouseEvent) {
			this.handleMouseEvent(mouseEvent);
			return { consume: true };
		}
		if (this.isMouseSequence(data)) return { consume: true };

		const keybindings = getKeybindings();
		const isRelease = isKeyRelease(data);
		if (keybindings.matches(data, "tui.altScreen.search")) {
			if (!isRelease) this.toggleSearch();
			return { consume: true };
		}
		if (this.activeSearch?.overlay?.isFocused()) {
			if (keybindings.matches(data, "tui.altScreen.searchNext")) {
				if (!isRelease) this.navigateSearch(1);
				return { consume: true };
			}
			if (keybindings.matches(data, "tui.altScreen.searchPrevious")) {
				if (!isRelease) this.navigateSearch(-1);
				return { consume: true };
			}
			if (keybindings.matches(data, "tui.altScreen.searchClose")) {
				if (!isRelease) this.closeSearch();
				return { consume: true };
			}
		}
		if (this.shouldDeferViewportInput()) return undefined;
		if (keybindings.matches(data, "tui.altScreen.pageUp")) {
			if (!isRelease) {
				this.scrollBy(-Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.pageDown")) {
			if (!isRelease) {
				this.scrollBy(Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.halfPageUp")) {
			if (!isRelease) this.scrollBy(-Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.halfPageDown")) {
			if (!isRelease) this.scrollBy(Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.lineUp")) {
			if (!isRelease) this.scrollBy(-1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.lineDown")) {
			if (!isRelease) this.scrollBy(1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.previousPrompt")) {
			if (!isRelease) this.scrollToPrompt(-1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.nextPrompt")) {
			if (!isRelease) this.scrollToPrompt(1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.top")) {
			if (!isRelease) this.scrollToTop();
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.bottom")) {
			if (!isRelease) this.scrollToBottom();
			return { consume: true };
		}
		return undefined;
	}

	private decodeMouseButton(button: number): TuiMouseButton {
		switch (button & 3) {
			case 0:
				return "left";
			case 1:
				return "middle";
			case 2:
				return "right";
			default:
				return "none";
		}
	}

	private createMouseEvent(
		type: TuiMouseEvent["type"],
		button: number,
		x: number,
		y: number,
		extra: Partial<Pick<TuiMouseEvent, "wheelDelta" | "clickCount">> = {},
	): TuiMouseEvent {
		return {
			type,
			button: type === "wheel" ? "none" : this.decodeMouseButton(button),
			x,
			y,
			screenX: x,
			screenY: y,
			width: Math.max(1, this.terminal.columns),
			height: Math.max(1, this.terminal.rows),
			shift: (button & 4) !== 0,
			alt: (button & 8) !== 0,
			ctrl: (button & 16) !== 0,
			...(extra.wheelDelta === undefined ? {} : { wheelDelta: extra.wheelDelta }),
			...(extra.clickCount === undefined ? {} : { clickCount: extra.clickCount }),
		};
	}

	private dispatchMouseToLayout(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (!this.currentLayout) return undefined;
		const visited = new Set<Component>();
		const boxes = getLayoutBoxesAt(this.currentLayout, event.screenX, event.screenY);
		for (const box of boxes) {
			if (visited.has(box.component)) continue;
			if (getLayoutNode(box.component) && box.component.handleMouse === Container.prototype.handleMouse) continue;
			visited.add(box.component);
			const result = dispatchMouseEvent(box.component, {
				...event,
				x: event.screenX - box.rect.x,
				y: event.screenY - box.rect.y,
				width: box.rect.width,
				height: box.rect.height,
			});
			if (result) return result;
		}
		return undefined;
	}

	private applyMouseDispatchResult(event: TuiMouseEvent, result: TuiMouseDispatchResult): boolean {
		const focusTarget = this.resolveMouseFocusTarget(result.focusTarget ?? result.target.component);
		const focusChanged = result.focus === true && this.getFocusedComponent() !== focusTarget;
		if (result.focus) this.setFocus(focusTarget);
		if (result.capture) this.mouseCapture = result.target;
		return (
			result.render ??
			(focusChanged ||
				event.type === "press" ||
				event.type === "click" ||
				event.type === "drag" ||
				event.type === "wheel")
		);
	}

	private dispatchMouseToTarget(
		event: TuiMouseEvent,
		target: TuiMouseDispatchTarget,
	): TuiMouseDispatchResult | undefined {
		return dispatchMouseEvent(target.component, retargetMouseEvent(event, target));
	}

	/** Run an action only if its press stays single. */
	private waitForSingleClick(result: TuiMouseDispatchResult, start: ClickTarget): void {
		const action = result.whenSingleClick;
		if (action === undefined) return;
		if (start.count !== 1 || !this.altScreenActive) {
			result.onSingleClickCancel?.();
			return;
		}
		this.waitingSingleClicks.set(start, result);
		this.scheduleSingleClickTimer();
	}

	private scheduleSingleClickTimer(): void {
		const first = this.waitingSingleClicks.keys().next().value;
		if (!first || this.singleClickTimer) return;
		// One past the interval: a second press exactly at its end still counts. Deliver tied deadlines in press order.
		this.singleClickTimer = setTimeout(
			() => {
				this.singleClickTimer = undefined;
				try {
					for (const [press, result] of this.waitingSingleClicks) {
						if (clickTime() - press.timestamp <= MULTI_CLICK_INTERVAL_MS) break;
						this.waitingSingleClicks.delete(press);
						result.whenSingleClick?.();
						this.requestRender();
					}
				} finally {
					this.scheduleSingleClickTimer();
				}
			},
			Math.max(0, first.timestamp + MULTI_CLICK_INTERVAL_MS + 1 - clickTime()),
		);
		this.singleClickTimer.unref?.();
	}

	/** A second click continued the clicks begun at `start`: they are a double- or triple-click, not single clicks. */
	private cancelWaitingSingleClicks(start: ClickTarget): void {
		const waiting = this.waitingSingleClicks.get(start);
		if (!waiting) return;
		this.waitingSingleClicks.delete(start);
		if (this.waitingSingleClicks.size === 0) {
			clearTimeout(this.singleClickTimer);
			this.singleClickTimer = undefined;
		}
		waiting.onSingleClickCancel?.();
	}

	private dropWaitingSingleClicks(): void {
		for (const start of this.waitingSingleClicks.keys()) this.cancelWaitingSingleClicks(start);
	}

	private clearTextSelection(): void {
		this.selectedFragments.clear();
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.pressedUrl = undefined;
		this.pressedHint = undefined;
		this.selectionDragged = false;
	}

	private handleMouseEvent(raw: SgrMouseEvent): void {
		const isMotion = (raw.button & 32) !== 0;
		const type: TuiMouseEvent["type"] = raw.release
			? "release"
			: isMotion
				? this.decodeMouseButton(raw.button) === "none"
					? "move"
					: "drag"
				: "press";
		const timestamp = clickTime();
		const previous = this.lastClick;
		// A press taken by a scrollbar, search button or another gesture also breaks the click sequence.
		if (type === "press") this.lastClick = undefined;
		const event = this.createMouseEvent(type, raw.button, raw.x, raw.y);

		if (this.mouseCapture || this.mousePressTarget) {
			const target = this.mouseCapture ?? this.mousePressTarget!;
			if (this.mousePressPoint && (raw.x !== this.mousePressPoint.x || raw.y !== this.mousePressPoint.y)) {
				this.mousePressMoved = true;
				this.lastClick = undefined;
			}
			let render = false;
			const targetResult = this.dispatchMouseToTarget(event, target);
			if (targetResult) render = this.applyMouseDispatchResult(event, targetResult);
			if (raw.release) {
				// The release always reaches the target, so it can end what its press started. The click needs the
				// same target still drawn where it was pressed, not another that took its place.
				const click = this.lastClick;
				if (
					click &&
					!this.mousePressMoved &&
					this.mousePressPoint?.x === raw.x &&
					this.mousePressPoint.y === raw.y &&
					sameDrawnAtPointer(this.mousePressFrame, this.pointerFrame(raw.x, raw.y))
				) {
					const clickEvent = this.createMouseEvent("click", raw.button, raw.x, raw.y, {
						clickCount: click.count,
					});
					const clickResult = this.dispatchMouseToTarget(clickEvent, target);
					if (clickResult) {
						render = this.applyMouseDispatchResult(clickEvent, clickResult) || render;
						this.waitForSingleClick(clickResult, click);
					}
				} else this.lastClick = undefined;
				this.clearComponentMouseGesture();
			}
			if (render) this.requestRender();
			return;
		}

		if (this.handleSearchMouseEvent(raw)) return;

		// A press on a key hint, and the drag or release that follows it, belong to the text selection: a click runs the
		// hint and a drag selects text, whatever component drew the hint.
		if (this.hintGestureActive || (type === "press" && this.isHintPress(raw))) {
			this.hintGestureActive = !raw.release;
			this.handleSelectionMouseEvent(raw, timestamp, previous);
			return;
		}

		const overlay = this.dispatchMouseToOverlay(event);
		if (!overlay.hit) {
			if (this.handleScrollToEndIndicatorMouseEvent(raw)) return;
			const scrollbarHandled = this.handleScrollbarMouseEvent(raw);
			if (!this.scrollbarDrag) this.updateScrollbarHover(raw.x, raw.y);
			if (scrollbarHandled) return;
		} else {
			this.stopScrollbarHover();
		}

		const result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(event));
		if (result) {
			const render = this.applyMouseDispatchResult(event, result);
			if (type === "press") {
				this.clearTextSelection();
				this.mousePressTarget = result.target;
				this.mousePressPoint = { x: raw.x, y: raw.y };
				this.mousePressFrame = this.pointerFrame(raw.x, raw.y);
				this.recordPress(previous, {
					timestamp,
					button: raw.button,
					row: raw.y,
					col: raw.x,
					wordStart: raw.x,
					wordEnd: raw.x,
					drawn: this.mousePressFrame.drawn,
					component: result.target.component,
				});
				this.mousePressMoved = false;
			}
			if (render) this.requestRender();
			return;
		}

		if (this.handleRightClickPaste(raw)) return;
		this.handleSelectionMouseEvent(raw, timestamp, previous);
	}

	private parseWheelEvent(data: string): WheelEvent | undefined {
		const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
		if (sgr) {
			const button = Number.parseInt(sgr[1], 10);
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: Number.parseInt(sgr[2], 10) - 1,
				y: Number.parseInt(sgr[3], 10) - 1,
				button,
			};
		}
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const button = data.charCodeAt(3) - 32;
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: data.charCodeAt(4) - 33,
				y: data.charCodeAt(5) - 33,
				button,
			};
		}
		return undefined;
	}

	private routeWheel(event: WheelEvent, delta: number): void {
		let remaining = delta;
		const seen = new Set<ScrollView>();
		for (const scrollView of this.currentLayout ? getScrollViewsAt(this.currentLayout, event.x, event.y) : []) {
			seen.add(scrollView);
			remaining = scrollView.scrollBy(remaining);
			if (remaining === 0 || scrollView.overscroll === "contain") break;
		}
		const primary = this.getPrimaryScrollView();
		if (remaining !== 0 && !seen.has(primary)) primary.scrollBy(remaining);
		this.updateScrollbarHover(event.x, event.y);
		this.requestRender();
	}

	private parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		if (!match) return undefined;
		return {
			button: Number.parseInt(match[1], 10),
			x: Number.parseInt(match[2], 10) - 1,
			y: Number.parseInt(match[3], 10) - 1,
			release: match[4] === "m",
		};
	}

	private handleRightClickPaste(event: SgrMouseEvent): boolean {
		if (
			!this.onRightClickPaste ||
			process.platform !== "win32" ||
			process.env.TERM_PROGRAM?.toLowerCase() === "vscode" ||
			event.release ||
			event.button !== 2
		) {
			return false;
		}
		try {
			this.onRightClickPaste();
		} catch {
			// Clipboard paste is best-effort.
		}
		return true;
	}

	private handleScrollToEndIndicatorMouseEvent(event: SgrMouseEvent): boolean {
		const rect = this.scrollToEndIndicatorRect;
		if (!rect || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		if (event.y !== rect.row || event.x < rect.column || event.x >= rect.column + rect.width) return false;
		this.scrollToBottom();
		return true;
	}

	private getScrollbarTargetAt(x: number, y: number, includeHiddenAuto = false): ScrollbarTarget | undefined {
		if (this.hasOverlay() || !this.currentLayout) return undefined;
		for (const scrollView of getScrollViewsAt(this.currentLayout, x, y)) {
			const box = getScrollViewBox(this.currentLayout, scrollView);
			const geometry = box ? getScrollbarGeometry(box, includeHiddenAuto) : undefined;
			if (
				geometry &&
				x === geometry.column &&
				y >= geometry.trackTop &&
				y < geometry.trackTop + geometry.trackHeight
			) {
				return { scrollView, geometry };
			}
		}
		return undefined;
	}

	private setScrollbarHover(scrollView: ScrollView | undefined): void {
		if (scrollView === this.scrollbarHover) return;
		this.scrollbarHover?.setScrollbarActive(false);
		this.scrollbarHover = scrollView;
		this.scrollbarHover?.setScrollbarActive(true);
	}

	private updateScrollbarHover(x: number, y: number): void {
		this.setScrollbarHover(this.getScrollbarTargetAt(x, y, true)?.scrollView);
	}

	private stopScrollbarHover(): void {
		this.setScrollbarHover(undefined);
	}

	private scrollScrollbarToPointer(
		scrollView: ScrollView,
		geometry: ScrollbarGeometry,
		pointerY: number,
		grabOffset: number,
	): void {
		const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
		const thumbOffset = Math.max(0, Math.min(maxThumbOffset, pointerY - geometry.trackTop - grabOffset));
		const scrollTop = maxThumbOffset === 0 ? 0 : Math.round((thumbOffset / maxThumbOffset) * geometry.maxScrollTop);
		scrollView.scrollTo(scrollTop);
	}

	private handleScrollbarMouseEvent(event: SgrMouseEvent): boolean {
		if (this.scrollbarDrag) {
			if (event.release) {
				this.stopScrollbarDrag();
				return true;
			}
			const box = this.currentLayout
				? getScrollViewBox(this.currentLayout, this.scrollbarDrag.scrollView)
				: undefined;
			const geometry = box ? getScrollbarGeometry(box) : undefined;
			if (geometry) {
				this.scrollScrollbarToPointer(
					this.scrollbarDrag.scrollView,
					geometry,
					event.y,
					this.scrollbarDrag.grabOffset,
				);
			}
			return true;
		}

		if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		const target = this.getScrollbarTargetAt(event.x, event.y);
		if (!target) return false;
		this.selectedFragments.clear();
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.pressedHint = undefined;
		this.selectionDragged = false;
		this.setScrollbarHover(target.scrollView);
		const onThumb =
			event.y >= target.geometry.thumbTop && event.y < target.geometry.thumbTop + target.geometry.thumbHeight;
		const grabOffset = onThumb ? event.y - target.geometry.thumbTop : Math.floor(target.geometry.thumbHeight / 2);
		if (!onThumb) this.scrollScrollbarToPointer(target.scrollView, target.geometry, event.y, grabOffset);
		this.scrollbarDrag = {
			scrollView: target.scrollView,
			grabOffset,
		};
		return true;
	}

	private stopScrollbarDrag(): void {
		this.scrollbarDrag = undefined;
	}

	private getScrollSelectionPoint(scrollView: ScrollView, x: number, y: number): SelectionPoint | undefined {
		if (!this.currentLayout) return undefined;
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		if (visibleBottom < visibleTop) return undefined;
		const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y));
		const maxContentRow = Math.max(0, (getScrollContentRows(box)?.length ?? 1) - 1);
		return {
			row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
			col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
			scrollView,
		};
	}

	private getSelectionPoint(event: SgrMouseEvent, scrollView?: ScrollView): SelectionPoint {
		if (scrollView) {
			const point = this.getScrollSelectionPoint(scrollView, event.x, event.y);
			if (point) return point;
		}
		return {
			row: Math.max(0, Math.min(this.terminal.rows - 1, event.y)),
			col: Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
		};
	}

	private getSelectionSourceLine(point: SelectionPoint): string {
		if (point.scrollView && this.currentLayout) {
			const lines = getScrollContentRows(getScrollViewBox(this.currentLayout, point.scrollView));
			if (lines) return lines.at(point.row) ?? "";
		}
		return this.previousScreen[point.row] ?? "";
	}

	private getWordSelection(point: SelectionPoint): SelectionRange | undefined {
		const line = stripTerminalSequences(this.getSelectionSourceLine(point));
		const segments: Array<{ start: number; end: number; selectable: boolean; joiner: boolean }> = [];
		let start = 0;
		for (const segment of wordSegmenter.segment(line)) {
			const end = start + visibleWidth(segment.segment);
			const joiner = TERMINAL_WORD_SELECTION_JOINERS.has(segment.segment);
			segments.push({ start, end, selectable: segment.isWordLike === true || joiner, joiner });
			start = end;
		}
		const clickedSegmentIndex = segments.findIndex(
			(segment) => point.col >= segment.start && point.col < segment.end,
		);
		if (clickedSegmentIndex < 0) return undefined;

		const canJoin = (
			left: { selectable: boolean; joiner: boolean },
			right: { selectable: boolean; joiner: boolean },
		): boolean => left.selectable && right.selectable && (left.joiner || right.joiner);
		let selectionStart = segments[clickedSegmentIndex].start;
		let selectionEnd = segments[clickedSegmentIndex].end;
		for (let index = clickedSegmentIndex; index > 0 && canJoin(segments[index - 1], segments[index]); index--) {
			selectionStart = segments[index - 1].start;
		}
		for (
			let index = clickedSegmentIndex;
			index < segments.length - 1 && canJoin(segments[index], segments[index + 1]);
			index++
		) {
			selectionEnd = segments[index + 1].end;
		}
		return {
			start: { ...point, col: selectionStart },
			end: { ...point, col: selectionEnd, boundary: true },
		};
	}

	private getLineSelection(point: SelectionPoint): SelectionRange {
		return {
			start: { ...point, col: 0 },
			end: { ...point, col: visibleWidth(this.getSelectionSourceLine(point)), boundary: true },
		};
	}

	private updateSelectionFocus(point: SelectionPoint): void {
		this.setSelectionFocus(point);
		this.captureVolatileSelection();
	}

	private setSelectionFocus(point: SelectionPoint): void {
		if (this.selectionGranularity === "character" || !this.selectionInitialRange) {
			this.selectionFocus = point;
			return;
		}
		const range = this.selectionGranularity === "word" ? this.getWordSelection(point) : this.getLineSelection(point);
		if (!range) return;
		const initial = this.selectionInitialRange;
		const targetBeforeInitial =
			range.start.row < initial.start.row ||
			(range.start.row === initial.start.row && range.start.col < initial.start.col);
		if (targetBeforeInitial) {
			this.selectionAnchor = initial.end;
			this.selectionFocus = range.start;
		} else {
			this.selectionAnchor = initial.start;
			this.selectionFocus = range.end;
		}
	}

	private recordPress(previous: ClickTarget | undefined, press: Omit<ClickTarget, "count" | "awaitingPaint">): number {
		// A control counts presses on the same cell. Text selection also accepts another cell of the same word.
		const continues =
			previous &&
			press.timestamp - previous.timestamp <= MULTI_CLICK_INTERVAL_MS &&
			previous.button === press.button &&
			previous.row === press.row &&
			(previous.col === press.col ||
				(previous.wordStart === press.wordStart && previous.wordEnd === press.wordEnd)) &&
			(!previous.component || !press.component || previous.component === press.component) &&
			previous.drawn.length === press.drawn.length &&
			previous.drawn.every((item, i) => item === press.drawn[i]);
		const count = continues ? (previous.count % 3) + 1 : 1;
		if (continues) this.cancelWaitingSingleClicks(previous);
		this.lastClick = { ...press, count, awaitingPaint: false };
		return count;
	}

	/** What the screen shows at `x`, `y`: the painted row, the layout boxes and overlay drawn there. */
	private pointerFrame(x: number, y: number): PointerFrame {
		const decoration = this.decoratedRows.get(y);
		const overlay = this.overlayAt(x, y);
		const boxes = this.currentLayout ? getLayoutBoxesAt(this.currentLayout, x, y) : [];
		const innermost = boxes[0];
		return {
			line: this.previousScreen[y],
			hint: this.hintAt(x, y),
			unselectedLine: this.unselectedScreen[y],
			highlighted: this.highlightedRows.has(y),
			boxes: boxes.map((box) => ({ component: box.component, x: box.rect.x, y: box.rect.y })),
			drawn: overlay
				? drawnAt(overlay.component, overlay.width, y - overlay.row)
				: innermost
					? drawnAt(innermost.component, innermost.rect.width, y - innermost.rect.y)
					: [],
			overlay,
			// An overlay drawn over the row takes its clicks; the decoration under it is hidden.
			decorated:
				overlay === undefined &&
				decoration !== undefined &&
				x >= decoration.x &&
				x < decoration.x + decoration.width,
		};
	}

	private updateSelectionAutoScroll(event: SgrMouseEvent): void {
		const scrollView = this.selectionAnchor?.scrollView;
		if (!scrollView || !this.currentLayout) {
			this.stopSelectionAutoScroll();
			return;
		}
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		this.selectionDragPointer = { x: event.x, y: event.y };
		this.selectionAutoScrollDirection = event.y <= visibleTop ? -1 : event.y >= visibleBottom ? 1 : 0;
		if (this.selectionAutoScrollDirection === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		if (this.selectionAutoScrollTimer) return;
		this.selectionAutoScrollTimer = setInterval(() => this.autoScrollSelection(), 50);
		this.selectionAutoScrollTimer.unref();
	}

	private autoScrollSelection(): void {
		const scrollView = this.selectionAnchor?.scrollView;
		const pointer = this.selectionDragPointer;
		const direction = this.selectionAutoScrollDirection;
		if (!scrollView || !pointer || direction === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const remaining = scrollView.scrollBy(direction);
		if (remaining === direction) {
			this.stopSelectionAutoScroll();
			return;
		}
		const point = this.getScrollSelectionPoint(scrollView, pointer.x, pointer.y);
		if (point) this.updateSelectionFocus(point);
		this.requestRender();
	}

	private stopSelectionAutoScroll(): void {
		if (this.selectionAutoScrollTimer) {
			clearInterval(this.selectionAutoScrollTimer);
			this.selectionAutoScrollTimer = undefined;
		}
		this.selectionAutoScrollDirection = 0;
		this.selectionDragPointer = undefined;
	}

	private handleSelectionMouseEvent(event: SgrMouseEvent, timestamp: number, previous: ClickTarget | undefined): void {
		const button = event.button & 3;
		if (button !== 0 && !(event.release && button === 3)) return;
		const anchorScrollView = this.selectionAnchor?.scrollView;
		const point = this.getSelectionPoint(event, anchorScrollView);
		if (event.release) {
			if (!this.selectionPressActive) return;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			if (!this.selectionAnchor) return;
			this.updateSelectionFocus(point);
			const releaseFrame = this.pointerFrame(event.x, event.y);
			const samePaint = samePointerFrame(this.pressFrame, releaseFrame);
			const click = this.lastClick;
			// Drawing or clearing a selection changes the row's styling, not what the next press would select.
			const sameSpot =
				samePaint ||
				(sameDrawnAtPointer(this.pressFrame, releaseFrame) &&
					stripTerminalSequences(this.pressFrame?.line ?? "") ===
						stripTerminalSequences(releaseFrame.line ?? "") &&
					getOsc8LinkAtColumn(this.pressFrame?.line ?? "", event.x) ===
						getOsc8LinkAtColumn(releaseFrame.line ?? "", event.x));
			const unchanged =
				samePaint ||
				(sameSpot &&
					this.pressFrame?.highlighted &&
					!releaseFrame.highlighted &&
					this.pressFrame.unselectedLine === releaseFrame.unselectedLine);
			if (click && (click.row !== event.y || click.col !== event.x || !sameSpot)) this.lastClick = undefined;
			const isClick =
				this.lastClick !== undefined &&
				!this.selectionDragged &&
				this.selectionAnchor.scrollView === point.scrollView &&
				this.selectionAnchor.row === point.row &&
				this.selectionAnchor.col === point.col;
			// A click acts on what the screen showed when it was pressed: a repaint that changed what is under the
			// pointer before the release makes it no click at all.
			this.pressFrame = undefined;
			const clickedUrl = isClick && unchanged ? this.pressedUrl : undefined;
			this.pressedUrl = undefined;
			// A key hint acts on a single click of what the press showed, as a pressed key would.
			const clickedHint = isClick && unchanged ? this.pressedHint : undefined;
			this.pressedHint = undefined;
			if (clickedHint) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				if (this.lastClick) this.lastClick.awaitingPaint = true;
				this.runHintAction(clickedHint);
				this.requestRender();
				return;
			}
			if (clickedUrl && this.openUrl) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				try {
					this.openUrl(clickedUrl);
				} catch {
					// URL activation is best-effort.
				}
				this.requestRender();
				return;
			}
			if (click && isClick && unchanged && !releaseFrame.decorated) {
				const clickEvent = this.createMouseEvent("click", event.button, event.x, event.y, {
					clickCount: click.count,
				});
				const overlay = this.dispatchMouseToOverlay(clickEvent);
				const result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(clickEvent));
				if (result) {
					const render = this.applyMouseDispatchResult(clickEvent, result);
					this.clearTextSelection();
					this.waitForSingleClick(result, click);
					// Only an immediate action has changed what the next frame draws here.
					click.awaitingPaint = result.whenSingleClick === undefined;
					if (render) this.requestRender();
					return;
				}
			}
			if (this.copyOnSelect) void this.copySelectionToClipboard();
			this.requestRender();
			return;
		}
		if ((event.button & 32) !== 0) {
			if (!this.selectionPressActive || !this.selectionAnchor) return;
			this.selectionDragged = true;
			this.lastClick = undefined;
			this.pressedUrl = undefined;
			this.pressedHint = undefined;
			this.updateSelectionFocus(point);
			this.updateSelectionAutoScroll(event);
			this.requestRender();
			return;
		}
		this.stopSelectionAutoScroll();
		this.selectedFragments.clear();
		this.selectionPressActive = true;
		const scrollView =
			!this.hasOverlay() && this.currentLayout
				? getScrollViewsAt(this.currentLayout, event.x, event.y)[0]
				: undefined;
		const anchor = this.getSelectionPoint(event, scrollView);
		const word = this.getWordSelection(anchor);
		const pressFrame = this.pointerFrame(event.x, event.y);
		const col = Math.max(0, Math.min(this.terminal.columns - 1, event.x));
		const offset = col - anchor.col;
		const clickCount = this.recordPress(previous, {
			timestamp,
			button: event.button,
			row: event.y,
			col,
			wordStart: (word?.start.col ?? anchor.col) + offset,
			wordEnd: (word?.end.col ?? anchor.col) + offset,
			drawn: pressFrame.drawn,
		});
		const range = clickCount === 2 ? word : clickCount === 3 ? this.getLineSelection(anchor) : undefined;
		this.selectionGranularity = range ? (clickCount === 2 ? "word" : "line") : "character";
		this.selectionInitialRange = range;
		this.selectionAnchor = range?.start ?? anchor;
		this.selectionFocus = range?.end ?? anchor;
		this.captureVolatileSelection();
		this.selectionDragged = false;
		this.pressFrame = pressFrame;
		this.pressedUrl = range
			? undefined
			: getOsc8LinkAtColumn(
					this.previousScreen[Math.max(0, Math.min(this.terminal.rows - 1, event.y))] ?? "",
					Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
				);
		this.pressedHint = range || (event.button & MODIFIER_BUTTON_BITS) !== 0 ? undefined : pressFrame.hint;
		this.requestRender();
	}

	/** The action of the key hint the last frame painted at screen cell `x`, `y`, when keys reach what is drawn there. */
	private hintAt(x: number, y: number): HintAction | undefined {
		const action = hintActionAt(this.paintedHints[y], x);
		return action !== undefined && this.takesKeysAt(x, y) ? action : undefined;
	}

	/** A plain left press on a key hint, which the text selection takes so a click runs the hint and a drag selects. */
	private isHintPress(event: SgrMouseEvent): boolean {
		return !event.release && event.button === 0 && this.hintAt(event.x, event.y) !== undefined;
	}

	private getSelectionBounds(): { start: SelectionPoint; end: SelectionPoint } | undefined {
		if (!this.selectionAnchor || !this.selectionFocus) return undefined;
		if (this.selectionAnchor.scrollView !== this.selectionFocus.scrollView) return undefined;
		const anchorBeforeFocus =
			this.selectionAnchor.row < this.selectionFocus.row ||
			(this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col < this.selectionFocus.col);
		if (
			this.selectionAnchor.row === this.selectionFocus.row &&
			this.selectionAnchor.col === this.selectionFocus.col
		) {
			return undefined;
		}
		return anchorBeforeFocus
			? { start: this.selectionAnchor, end: this.selectionFocus }
			: { start: this.selectionFocus, end: this.selectionAnchor };
	}

	private getSelectionColumns(
		line: string,
		row: number,
		selection: { start: SelectionPoint; end: SelectionPoint },
		minColumn = 0,
		maxColumn = visibleWidth(line),
	): { start: number; end: number } {
		const lineWidth = visibleWidth(line);
		let start = Math.max(0, minColumn);
		let end = Math.min(lineWidth, maxColumn);
		if (row === selection.start.row) {
			start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
		}
		if (row === selection.end.row) {
			end = selection.end.boundary
				? Math.min(selection.end.col, lineWidth)
				: (getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth));
		}
		return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
	}

	private captureVolatileSelection(): void {
		const selection = this.getSelectionBounds();
		if (!selection) {
			this.selectedFragments.clear();
			return;
		}
		for (const row of this.selectedFragments.keys())
			if (row < selection.start.row || row > selection.end.row) this.selectedFragments.delete(row);
		this.capturePaintedFragments(selection, this.currentLayout);
	}

	private capturePaintedFragments(selection: SelectionRange, layout: LayoutFrame | undefined): void {
		const view = selection.start.scrollView;
		if (!layout || !view) return;
		const rows = getScrollContentRows(getScrollViewBox(layout, view));
		const first = Math.max(selection.start.row, view.scrollTop);
		const last = Math.min(selection.end.row, view.scrollTop + view.viewportHeight - 1);
		rows?.visitVolatileRows?.(first, last, (row, line, renderer) => {
			const { start, end } = this.getSelectionColumns(line, row, selection);
			const previous = this.selectedFragments.get(row);
			// The same live component can publish new text. A recreated historical component, however, cannot
			// reproduce its predecessor's private state: preserve the overlap that was already selected.
			const replay = previous && previous.renderer !== renderer ? previous : undefined;
			if (replay && replay.start === start && replay.end === end) return;
			const slice = (value: string, a: number, b: number) =>
				stripTerminalSequences(sliceByColumn(value, a, Math.max(0, b - a), true));
			let text: string;
			if (!replay || start >= replay.end || end <= replay.start) text = slice(line, start, end);
			else {
				const from = Math.max(start, replay.start),
					to = Math.min(end, replay.end);
				text =
					slice(line, start, from) +
					slice(replay.text, from - replay.start, to - replay.start) +
					slice(line, to, end);
			}
			this.selectedFragments.set(row, { renderer: replay?.renderer ?? renderer, start, end, text });
		});
	}

	private getActiveSelectionText(): string | undefined {
		const selection = this.getSelectionBounds();
		if (!selection) return undefined;
		let sourceLines: WindowRows = this.previousScreen;
		if (selection.start.scrollView) {
			if (!this.currentLayout) return undefined;
			const rows = getScrollContentRows(getScrollViewBox(this.currentLayout, selection.start.scrollView));
			if (!rows) return undefined;
			sourceLines = rows;
		}
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const pinned = this.selectedFragments.get(row);
			if (pinned) {
				lines.push(pinned.text.trimEnd());
				continue;
			}
			const line = sourceLines.at(row) ?? "";
			const columns = this.getSelectionColumns(line, row, selection);
			lines.push(
				stripTerminalSequences(
					sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
				).trimEnd(),
			);
		}
		const text = lines.join("\n");
		return text.length === 0 ? undefined : text;
	}

	private async copySelectionToClipboard(): Promise<boolean> {
		const text = this.getActiveSelectionText();
		if (!text) return false;
		return this.copyTextToClipboard(text);
	}

	private async copyTextToClipboard(text: string): Promise<boolean> {
		// Prefer an injected clipboard implementation (native clipboard + platform tools with a
		// verified success path) when the host app provides one. A bare OSC 52 write can show
		// "Copied!" while leaving the system clipboard untouched (e.g. macOS Terminal.app, tmux
		// without OSC 52 clipboard passthrough), so only report success when it actually copies.
		if (this.copySelection) {
			const result = await this.copySelection(text);
			const ok = result === true;
			this.flash(
				ok ? "Copied!" : typeof result === "string" ? result : "Copy failed",
				ok ? undefined : COPY_ERROR_FLASH_DURATION_MS,
			);
			return ok;
		}
		this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		this.flash("Copied!");
		return true;
	}

	private applySearchTextHighlight(text: string, current: boolean): string {
		const style = current ? this.searchCurrentMatchStyle : this.searchMatchStyle;
		let result = "";
		let plainStart = 0;
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				index += 1;
				continue;
			}
			if (index > plainStart) result += style(text.slice(plainStart, index));
			result += ansi.code;
			index += ansi.length;
			plainStart = index;
		}
		if (plainStart < text.length) result += style(text.slice(plainStart));
		return result;
	}

	private applySearchHighlights(screen: string[], layout: LayoutFrame): string[] {
		const search = this.activeSearch;
		if (!search || search.selectedIndex < 0 || search.matches.length === 0) return screen;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		const box = getScrollViewBox(layout, scrollView);
		if (!box) return screen;

		const rangesByRow = new Map<number, SearchHighlightRange[]>();
		const scrollbarColumn = getScrollbarGeometry(box)?.column;
		const minRow = Math.max(0, box.rect.y, box.clip.y);
		const maxRow = Math.min(screen.length, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
		const minColumn = Math.max(0, box.rect.x, box.clip.x);
		const maxColumn = Math.min(
			this.terminal.columns,
			box.rect.x + box.rect.width,
			box.clip.x + box.clip.width,
			scrollbarColumn ?? Number.POSITIVE_INFINITY,
		);
		const minContentRow = scrollView.scrollTop + minRow - box.rect.y;
		const maxContentRow = scrollView.scrollTop + maxRow - box.rect.y - 1;
		let low = 0;
		let high = search.matches.length;
		while (low < high) {
			const middle = low + Math.floor((high - low) / 2);
			const match = search.matches[middle]!;
			const lastRow = match.segments[match.segments.length - 1]?.row ?? -1;
			if (lastRow < minContentRow) low = middle + 1;
			else high = middle;
		}
		for (let matchIndex = low; matchIndex < search.matches.length; matchIndex++) {
			const match = search.matches[matchIndex]!;
			if ((match.segments[0]?.row ?? 0) > maxContentRow) break;
			for (const segment of match.segments) {
				const row = box.rect.y + segment.row - scrollView.scrollTop;
				if (row < minRow || row >= maxRow) continue;
				const startCol = Math.max(minColumn, box.rect.x + segment.startCol);
				const endCol = Math.min(maxColumn, box.rect.x + segment.endCol);
				if (endCol <= startCol) continue;
				const ranges = rangesByRow.get(row) ?? [];
				ranges.push({ startCol, endCol, current: matchIndex === search.selectedIndex });
				rangesByRow.set(row, ranges);
			}
		}

		const result = [...screen];
		for (const [row, ranges] of rangesByRow) {
			let line = result[row] ?? "";
			if (isImageLine(line)) continue;
			const lineWidth = visibleWidth(line);
			for (const range of ranges.sort((a, b) => b.startCol - a.startCol)) {
				const startCol = Math.min(range.startCol, lineWidth);
				const endCol = Math.min(range.endCol, lineWidth);
				if (endCol <= startCol) continue;
				const before = sliceByColumn(line, 0, startCol, true);
				const highlighted = sliceByColumn(line, startCol, endCol - startCol, true);
				const after = sliceByColumn(line, endCol, Math.max(0, lineWidth - endCol), true);
				line = `${before}${this.applySearchTextHighlight(highlighted, range.current)}${after}`;
			}
			result[row] = line;
		}
		return result;
	}

	private applySelectionHighlight(text: string): string {
		let result = "\x1b[7m";
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				result += text[index];
				index += 1;
				continue;
			}
			result += ansi.code;
			if (ansi.code.endsWith("m")) result += "\x1b[7m";
			index += ansi.length;
		}
		return `${result}\x1b[27m`;
	}

	private applySelection(screen: string[], layout = this.currentLayout): string[] {
		this.highlightedRows.clear();
		const selection = this.getSelectionBounds();
		if (!selection) return screen;
		this.capturePaintedFragments(selection, layout);
		let screenSelection = selection;
		let minRow = 0;
		let maxRow = screen.length - 1;
		let minColumn = 0;
		let maxColumn = this.terminal.columns;
		if (selection.start.scrollView) {
			if (!layout) return screen;
			const box = getScrollViewBox(layout, selection.start.scrollView);
			if (!box) return screen;
			minRow = Math.max(0, box.rect.y, box.clip.y);
			maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
			minColumn = Math.max(0, box.rect.x, box.clip.x);
			maxColumn = Math.min(this.terminal.columns, box.rect.x + box.rect.width, box.clip.x + box.clip.width);
			screenSelection = {
				start: {
					...selection.start,
					row: box.rect.y + selection.start.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.start.col,
				},
				end: {
					...selection.end,
					row: box.rect.y + selection.end.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.end.col,
				},
			};
		}
		return screen.map((line, row) => {
			if (
				row < minRow ||
				row > maxRow ||
				row < screenSelection.start.row ||
				row > screenSelection.end.row ||
				isImageLine(line)
			) {
				return line;
			}
			const lineWidth = visibleWidth(line);
			const columns = this.getSelectionColumns(line, row, screenSelection, minColumn, maxColumn);
			if (columns.end <= columns.start) return line;
			this.highlightedRows.add(row);
			const before = sliceByColumn(line, 0, columns.start, true);
			const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
			const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
			return `${before}${this.applySelectionHighlight(selected)}${after}`;
		});
	}

	private isMouseSequence(data: string): boolean {
		return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
	}

	private compositeScrollToEndIndicator(screen: string[], layout: LayoutFrame, width: number): string[] {
		this.scrollToEndIndicatorRect = undefined;
		this.decoratedRows = new Map();
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		if (!this.scrollToEndIndicator || !scrollView.followEnd || scrollView.isFollowingEnd) return screen;
		const box = getScrollViewBox(layout, scrollView);
		const clip = box?.clip;
		if (!clip || clip.width <= 0 || clip.height <= 0) return screen;
		const row = clip.y + clip.height - 1;
		if (row >= screen.length || isImageLine(screen[row] ?? "")) return screen;
		const scrollbarColumn = box ? getScrollbarGeometry(box)?.column : undefined;
		const label = truncateToWidth(this.scrollToEndIndicator(), clip.width, "");
		const labelWidth = visibleWidth(label);
		const column = clip.x + Math.floor((clip.width - labelWidth) / 2);
		const rightEdge = scrollbarColumn ?? clip.x + clip.width;
		const availableWidth = Math.max(0, rightEdge - column);
		const text = truncateToWidth(label, availableWidth, "");
		const textWidth = visibleWidth(text);
		if (textWidth === 0) return screen;
		const result = [...screen];
		result[row] = compositeTuiLine(result[row] ?? "", text, column, textWidth, width);
		this.scrollToEndIndicatorRect = { row, column, width: textWidth };
		// The rest of the row still shows the transcript, but its row is half covered: no click reaches it.
		this.decoratedRows.set(row, { x: clip.x, width: clip.width });
		return result;
	}

	private compositeFlashes(screen: string[], width: number, height: number): string[] {
		const flashLines = this.flashes.render(width).slice(-height);
		if (flashLines.length === 0) return screen;
		const result = [...screen];
		while (result.length < height) result.push("");
		for (let row = 0; row < flashLines.length; row++) {
			const line = flashLines[row]!;
			const flashWidth = visibleWidth(line);
			if (flashWidth === 0) continue;
			result[row] = compositeTuiLine(result[row] ?? "", line, width - flashWidth, flashWidth, width);
		}
		return result;
	}

	/**
	 * The layout and the overlays composited over it. An overlay that covered the whole screen last frame and still
	 * shows hides the layout under it, so the layout is not drawn again until the overlay stops covering it: a
	 * full-screen view's frames cost only the view. A layout with images is always drawn, because an image line
	 * shows through an overlay.
	 */
	private renderScreen(width: number, height: number): { layout: LayoutFrame; screen: string[] } {
		const covered = this.currentLayout;
		if (
			covered !== undefined &&
			!this.coveredLayoutHasImages &&
			this.previousScreenWidth === width &&
			this.previousScreenHeight === height &&
			this.overlaysCoverScreen(width, height)
		) {
			const screen = this.compositeOverlays(
				Array.from({ length: height }, () => ""),
				width,
				height,
			);
			// An overlay that shrank or hid in this frame shows the layout after all.
			if (this.overlaysCoverScreen(width, height)) return { layout: covered, screen };
		}
		const layout = this.renderLayout(width, height);
		return { layout, screen: this.compositeOverlays(this.composeLayout(layout, width), width, height) };
	}

	private renderLayout(width: number, height: number): LayoutFrame {
		if (this.activeSearch?.query.trim()) this.settleScrollContent(this.getPrimaryScrollView());
		const root = this.layoutRoot ?? this.implicitScrollView;
		let layout = renderLayoutFrame(root, width, height, () => this.requestRender());
		if (this.refreshSearch(layout)) layout = renderLayoutFrame(root, width, height, () => this.requestRender());
		this.coveredLayoutHasImages = layout.lines.some(isImageLine);
		return layout;
	}

	/** The layout's rows with its search highlights and scroll decorations, ready for the overlays. */
	private composeLayout(layout: LayoutFrame, width: number): string[] {
		// Resolve fake cursors before highlighting and compositing, which only track SGR codes
		let screen = this.resolveFakeCursors(layout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX, "")));
		screen = this.applySearchHighlights(screen, layout);
		screen = this.compositeScrollToEndIndicator(screen, layout, width);
		return this.compositeScrollPinnedPrompt(screen, layout, width);
	}

	private compositeScrollPinnedPrompt(screen: string[], layout: LayoutFrame, width: number): string[] {
		if (!this.scrollPinnedPrompt) return screen;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		if (!scrollView.followEnd || scrollView.isFollowingEnd || scrollView.scrollTop <= 0) return screen;
		if (this.isCurrentSearchMatchOnRow(scrollView.scrollTop)) return screen;
		const box = getScrollViewBox(layout, scrollView);
		const clip = box?.clip;
		const lines = getScrollContentRows(box);
		if (!clip || !lines || clip.width <= 0 || clip.height < 2) return screen;
		const pin = this.scrollPinnedPrompt;
		const promptRow = turnPromptAbove(lines, scrollView.scrollTop, pin.isPrompt);
		if (promptRow === undefined) return screen;
		const row = clip.y;
		if (row >= screen.length || isImageLine(screen[row] ?? "")) return screen;
		const scrollbarColumn = getScrollbarGeometry(box)?.column;
		const rightEdge = scrollbarColumn ?? clip.x + clip.width;
		const available = Math.max(0, rightEdge - clip.x);
		const text = truncateToWidth(pin.render(promptRow), available, "");
		const textWidth = visibleWidth(text);
		if (textWidth === 0) return screen;
		const padded = text + " ".repeat(Math.max(0, available - textWidth));
		const result = [...screen];
		result[row] = compositeTuiLine(result[row] ?? "", padded, clip.x, available, width);
		this.decoratedRows.set(row, { x: clip.x, width: available });
		return result;
	}

	private layoutFrame(): LayoutFrame {
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		return renderLayoutFrame(this.layoutRoot ?? this.implicitScrollView, width, height, () => this.requestRender());
	}

	private settleScrollContent(scrollView: ScrollView): boolean {
		const box = this.currentLayout ? getScrollViewBox(this.currentLayout, scrollView) : undefined;
		const content = box?.children[0]?.component;
		if (!(content instanceof WindowedContainer)) return false;
		content.settleRows();
		return true;
	}

	protected override doRender(): void {
		if (this.stopped || !this.altScreenActive) return;
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		const rendered = this.renderScreen(width, height);
		const nextLayout = rendered.layout;
		let screen = rendered.screen;
		if (screen.length > height) screen = screen.slice(screen.length - height);
		this.unselectedScreen = screen.slice();
		screen = this.applySelection(screen, nextLayout);
		screen = this.compositeFlashes(screen, width, height);

		const cursorPos = this.extractCursorPosition(screen, height);
		const paintedHints: (readonly HintSpan[] | undefined)[] = [];
		screen = screen.map((line, row) => {
			const read = readHintSpans(line);
			if (read.spans.length > 0) paintedHints[row] = read.spans;
			return read.line;
		});
		this.paintedHints = paintedHints;
		screen = this.applyLineResets(screen).map((line) => {
			if (isImageLine(line) || visibleWidth(line) <= width) return line;
			return sliceByColumn(line, 0, width, true);
		});

		const fullRedraw =
			this.previousScreen.length === 0 || this.previousScreenWidth !== width || this.previousScreenHeight !== height;
		const changedRows = screen.map((line, row) => line !== this.previousScreen[row]);
		const imageAnchorsNeedRedraw = screen.some(
			(line, row) => changedRows[row] && (isImageLine(line) || isImageLine(this.previousScreen[row] ?? "")),
		);
		const imageCellsNeedRedraw =
			!imageAnchorsNeedRedraw &&
			this.imageProtocol === "kitty" &&
			changedRows.some(Boolean) &&
			screen.some((line, row) => {
				const placementRows = getKittyImagePlacementRows(line);
				if (placementRows === undefined) return false;
				for (let coveredRow = row; coveredRow < row + placementRows; coveredRow++) {
					if (changedRows[coveredRow]) return true;
				}
				return false;
			});
		const imagesNeedRedraw = imageAnchorsNeedRedraw || imageCellsNeedRedraw;
		const redrawImages = fullRedraw || imagesNeedRedraw;
		const hadUploadedKittyImages = this.uploadedKittyImages.size > 0;
		const preparedKittyScreen =
			redrawImages && this.imageProtocol === "kitty"
				? this.prepareKittyScreen(screen)
				: { lines: screen, evictedImageDeletion: "" };

		let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
		if (fullRedraw) {
			this.fullRedrawCount += 1;
			const clearImages =
				this.imageProtocol === "kitty" && hadUploadedKittyImages
					? deleteAllKittyPlacements()
					: this.deleteKittyImages();
			buffer += `${clearImages}\x1b[2J`;
		} else if (imagesNeedRedraw) {
			if (this.imageProtocol === "iterm2") buffer += "\x1b[2J";
			else if (this.imageProtocol === "kitty") buffer += deleteAllKittyPlacements();
		}
		buffer += preparedKittyScreen.evictedImageDeletion;

		// Some terminals store Kitty images in the cells they cover (WezTerm, xterm.js's image addon in Orca),
		// so clearing or writing a covered row erases that part of the image. Draw placements after every clear
		// and text write so nothing later intersects them. Terminals that keep images on a separate layer
		// (Kitty, Ghostty) render the same result; text-only frames keep the interleaved output.
		const drawKittyImagesLast = redrawImages && this.imageProtocol === "kitty" && screen.some(isImageLine);
		if (drawKittyImagesLast) {
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				buffer += `\x1b[${row + 1};1H\x1b[2K`;
			}
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				if (isImageLine(preparedKittyScreen.lines[row] ?? "")) continue;
				buffer += `\x1b[${row + 1};1H${preparedKittyScreen.lines[row] ?? ""}`;
			}
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				if (!isImageLine(preparedKittyScreen.lines[row] ?? "")) continue;
				buffer += `\x1b[${row + 1};1H${preparedKittyScreen.lines[row] ?? ""}`;
			}
		} else {
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				buffer += `\x1b[${row + 1};1H\x1b[2K${preparedKittyScreen.lines[row] ?? ""}`;
			}
		}

		if (cursorPos) {
			buffer += `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
			buffer += this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l";
		} else {
			buffer += "\x1b[?25l";
		}
		buffer += END_SYNCHRONIZED_OUTPUT;
		this.terminal.write(buffer);

		this.previousScreen = screen;
		this.previousScreenWidth = width;
		this.previousScreenHeight = height;
		this.currentLayout = nextLayout;
		const click = this.lastClick;
		if (click?.awaitingPaint) {
			click.awaitingPaint = false;
			click.drawn = this.pointerFrame(click.col, click.row).drawn;
		}
	}
}

export function turnPromptAbove(
	lines: WindowRows,
	top: number,
	isPrompt: (row: string) => boolean,
): string | undefined {
	for (let start = Math.min(top, lines.length - 1); start >= 0; start--) {
		if (!isPrompt(lines.at(start) ?? "")) continue;
		for (let row = start; row < top; row++) {
			const text = (lines.at(row) ?? "").replace(OSC133_ZONE_PREFIX, "");
			if (text.replace(/\x1b\[[0-9;]*m/g, "").trim()) return text;
		}
		return undefined;
	}
	return undefined;
}
