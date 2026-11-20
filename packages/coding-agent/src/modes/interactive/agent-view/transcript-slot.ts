import {
	type Component,
	isKeyRelease,
	isViewportTUI,
	stripHintMarkers,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	VStack,
} from "@bastani/atomic-tui";
import { TRANSCRIPT_JUMP_TO_END_URL } from "../components/transcript-follow-indicator.ts";
import { type InteractiveModeBase, isFullscreenViewportAction } from "../interactive-mode-base.ts";
import { theme } from "../theme/theme.js";
import type { AgentViewSwitcher } from "./agent-view-switcher.ts";
import type { AgentViewPort } from "./contracts.ts";
import { setViewedNoticeSink } from "./viewed-notices.ts";

/** Rows the prompt, footer and panel take below the transcript before the first frame says how many they take. */
const ESTIMATED_DOCK_ROWS = 10;
/** Notices kept at the bottom of a shown subagent's transcript; older ones leave as newer ones arrive. */
const MAX_NOTICES = 3;

type NoticeKind = "status" | "warning" | "error";

interface Notice {
	readonly kind: NoticeKind;
	readonly text: string;
}

function noticeText(notice: Notice): string {
	switch (notice.kind) {
		case "status":
			return theme.fg("dim", notice.text);
		case "warning":
			return theme.fg("warning", `Warning: ${notice.text}`);
		case "error":
			return theme.fg("error", `Error: ${notice.text}`);
	}
}

/** An SGR wheel report the transcript's own viewport reads, for a wheel turn over the transcript area. */
function wheelReport(event: TuiMouseEvent): string {
	const code = ((event.wheelDelta ?? 0) < 0 ? 64 : 65) | (event.alt ? 8 : 0);
	return `\x1b[<${code};${Math.max(1, Math.floor(event.x) + 1)};${Math.max(1, Math.floor(event.y) + 1)}M`;
}

/**
 * The transcript area while a subagent is shown: its transcript in the rows the screen gives it, and the screen's
 * status, warning and error notices below it, as the main chat adds them below its last message.
 */
export class AgentTranscriptSlot implements Component {
	port: AgentViewPort | undefined;
	/** The rows the transcript had in the last frame; undefined before one was drawn. */
	transcriptRows: number | undefined;
	/** The rows the whole area had in the last frame, notices included. */
	paintedRows: number | undefined;
	private notices: Notice[] = [];
	private readonly fallbackRows: () => number;

	constructor(fallbackRows: () => number) {
		this.fallbackRows = fallbackRows;
	}

	renderSized(width: number, height: number): string[] {
		const port = this.port;
		if (height <= 0 || port === undefined) return [];
		const noticeLines = this.renderNotices(width);
		const notices = noticeLines.slice(Math.max(0, noticeLines.length - (height - 1)));
		const rows = height - notices.length;
		const transcript = port.transcript;
		const drawn =
			typeof transcript.renderSized === "function" ? transcript.renderSized(width, rows) : transcript.render(width);
		const lines = drawn.length > rows ? drawn.slice(drawn.length - rows) : drawn;
		this.transcriptRows = rows;
		this.paintedRows = height;
		return [...lines, ...Array.from({ length: rows - lines.length }, () => ""), ...notices];
	}

	render(width: number): string[] {
		return this.renderSized(width, Math.max(1, this.fallbackRows()));
	}

	handleInput(data: string): void {
		this.port?.transcript.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const transcript = this.port?.transcript;
		if (transcript === undefined || event.y < 0 || event.y >= (this.transcriptRows ?? 0)) return undefined;
		if (event.type === "wheel") return transcript.handleViewKey(wheelReport(event)) ? { handled: true } : undefined;
		return transcript.handleMouse?.(event);
	}

	paintedRowKey(row: number): string | undefined {
		if (row < 0 || row >= (this.transcriptRows ?? 0)) return undefined;
		return this.port?.transcript.paintedRowKey?.(row);
	}

	invalidate(): void {
		this.port?.transcript.invalidate();
	}

	addNotice(kind: NoticeKind, text: string): void {
		const last = this.notices.at(-1);
		// A status replaces the status just before it, as the main chat's next status line does.
		if (kind === "status" && last?.kind === "status") this.notices[this.notices.length - 1] = { kind, text };
		else this.notices.push({ kind, text });
		if (this.notices.length > MAX_NOTICES) this.notices.splice(0, this.notices.length - MAX_NOTICES);
	}

	clearNotices(): void {
		this.notices = [];
	}

	private renderNotices(width: number): string[] {
		if (this.notices.length === 0) return [];
		const lines = [""];
		for (const notice of this.notices) lines.push(...new Text(noticeText(notice), 1, 0).render(width));
		return lines;
	}
}

/** An OSC 8 hyperlink's opening or closing sequence. */
const HYPERLINK = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** What the renderer ends every row it writes with; it adds it again to the held rows. */
const ROW_END = "\x1b[0m\x1b]8;;\x07";

/** A row as the screen showed it, without its links: drawn again, it writes the same text and styles. */
function heldRow(line: string): string {
	const row = line.endsWith(ROW_END) ? line.slice(0, -ROW_END.length) : line;
	return stripHintMarkers(row).replace(HYPERLINK, "");
}

/**
 * The rows the dock below the transcript painted last, drawn in its place while it is held. They are only text, with
 * no links or clickable hints left in them: what they acted on is gone. A press on them shows the dock live and does
 * nothing else; a frame of another size than the one they were painted in ends the hold too.
 */
class HeldDockRows implements Component {
	private readonly lines: string[];
	/** Whether the screen is still the one the rows were painted on, at the same size. */
	private readonly sameScreen: (width: number) => boolean;
	/** The dock drawn live, for a frame of another size before the hold has ended. */
	private readonly live: (width: number) => string[];
	private readonly onEnd: () => void;

	constructor(
		lines: string[],
		sameScreen: (width: number) => boolean,
		live: (width: number) => string[],
		onEnd: () => void,
	) {
		this.lines = lines.map(heldRow);
		this.sameScreen = sameScreen;
		this.live = live;
		this.onEnd = onEnd;
	}

	render(width: number): string[] {
		if (this.sameScreen(width)) return this.lines;
		this.onEnd();
		return this.live(width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// A wheel turn scrolls as it does over the live dock.
		if (event.type === "wheel") return undefined;
		if (event.type !== "press") return { handled: true, render: false };
		this.onEnd();
		// The release comes back here: it is not a click on whatever is drawn live under the pointer by then.
		return { capture: true };
	}

	invalidate(): void {}
}

/** What is below the transcript: drawn live, or held as painted while a subagent `/tasks` opened is on its way. */
type DockState =
	| { readonly kind: "live" }
	| {
			readonly kind: "held";
			/** Which hold this is: its release names it by number, so it keeps nothing of the held rows alive. */
			readonly hold: number;
			readonly rows: HeldDockRows;
			readonly timer: ReturnType<typeof setTimeout>;
			/** Stops listening for a replaced renderer, which ends the hold. */
			readonly offRenderer: () => void;
			/** The layout root while held, for the transcript part it was made with. */
			root: { readonly part: Component; readonly root: Component } | undefined;
	  };

/**
 * A key press, which shows a held dock live before it runs. Not a key release or a focus report, which the reader
 * did not type, nor the pointer: the screen's viewport takes it first, and the held rows take no clicks.
 */
function endsDockHold(data: string): boolean {
	return (
		!isKeyRelease(data) &&
		data !== "\x1b[I" &&
		data !== "\x1b[O" &&
		!data.startsWith("\x1b[<") &&
		!data.startsWith("\x1b[M")
	);
}

const slots = new WeakMap<InteractiveModeBase, AgentTranscriptSlot>();
const dockHolds = new WeakMap<InteractiveModeBase, (timeoutMs: number) => () => void>();

/**
 * Keep the dock below the transcript (prompt, footer, panel) as it was painted, at most `timeoutMs`, while the
 * transcript above keeps drawing live: `/tasks` closes while the subagent it opens is on its way, and the main chat's
 * prompt is not painted in between. A key press, a press on the held rows, another size or renderer, and the
 * answered release show it live again. Only the fullscreen renderer holds; answers the release.
 */
export function holdTranscriptDock(mode: InteractiveModeBase, timeoutMs: number): () => void {
	return dockHolds.get(mode)?.(timeoutMs) ?? (() => {});
}

function focusedComponent(mode: InteractiveModeBase): object | null | undefined {
	return (mode.ui as { getFocusedComponent?(): object | null }).getFocusedComponent?.();
}

/** The rows a subagent's transcript is drawn in on `mode`'s screen: those of the last frame, else an estimate. */
export function transcriptSlotRows(mode: InteractiveModeBase): number {
	return slots.get(mode)?.transcriptRows ?? Math.max(1, mode.ui.terminal.rows - ESTIMATED_DOCK_ROWS);
}

/**
 * Draw the viewed subagent's transcript where the main transcript is, and main's again when main is shown. While a
 * subagent is shown, the mode's status, warning and error notices, which stay main's, are also drawn at the bottom of
 * its transcript, as are the notices about it alone (`notifyViewed`). Answers the uninstall.
 */
export function installTranscriptSlot(mode: InteractiveModeBase, switcher: AgentViewSwitcher): () => void {
	const slot = new AgentTranscriptSlot(() => Math.max(1, mode.ui.terminal.rows - ESTIMATED_DOCK_ROWS));
	slots.set(mode, slot);
	let agentRoot: Component | undefined;
	let unwatchPort: (() => void) | undefined;
	let dock: DockState = { kind: "live" };
	let holds = 0;
	const agentShown = () => switcher.viewed.kind === "agent";

	/** The question form of a held prompt takes the keys while it is open; the prompt has them otherwise. */
	const syncFocus = () => {
		const viewed = switcher.viewed;
		const wantsSlot = viewed.kind === "agent" && viewed.port.transcript.capturesInput();
		const focused = focusedComponent(mode);
		if (wantsSlot && focused === mode.editor) mode.ui.setFocus(slot);
		else if (!wantsSlot && focused === slot) mode.ui.setFocus(mode.editor);
	};

	/** Install the layout of what is shown: the agent root over the same dock, or main's own root object again. */
	const applyLayout = () => {
		const tui = mode.ui;
		const shown = agentShown();
		if (isViewportTUI(tui)) {
			const held = dock;
			const part = shown ? slot : mode.transcriptScrollView;
			if (held.kind === "held" && part !== undefined) {
				if (held.root?.part !== part)
					held.root = {
						part,
						root: new VStack([
							{ component: part, basis: 0, grow: 1, shrink: 1, minSize: 1 },
							{ component: held.rows, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
						]),
					};
				tui.setLayoutRoot(held.root.root);
				return;
			}
			if (shown && mode.fullscreenDock !== undefined) {
				agentRoot ??= new VStack([
					{ component: slot, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					{ component: mode.fullscreenDock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
				]);
				tui.setLayoutRoot(agentRoot);
			} else if (mode.fullscreenLayoutRoot !== undefined) tui.setLayoutRoot(mode.fullscreenLayoutRoot);
			return;
		}
		// The main-screen renderer draws its children in order: the transcript area is the document's place.
		const children = tui.children;
		const at = children.indexOf(shown ? mode.documentContainer : slot);
		if (at >= 0) children[at] = shown ? slot : mode.documentContainer;
	};

	/**
	 * What the screen does differently while a subagent is shown, attached when one is first shown and detached when
	 * main is again: with main shown the mode has nothing of this, exactly as before.
	 */
	const attach = (): (() => void) => {
		// A replaced renderer starts on main's root; a shown subagent keeps its place.
		const offRenderer = mode.onTuiRendererChange(() => {
			if (agentShown()) applyLayout();
		});
		// Scroll keys go to the shown transcript, as they go to main's while main is shown. The screen's own viewport
		// declines them meanwhile (`shouldHandleViewportInput`).
		const removeInput = mode.addTuiInputListener((data) => {
			const viewed = switcher.viewed;
			if (viewed.kind !== "agent" || focusedComponent(mode) !== mode.editor) return undefined;
			if (!isFullscreenViewportAction(data, mode.keybindings)) return undefined;
			if (!isKeyRelease(data)) viewed.port.transcript.handleViewKey(data);
			mode.ui.requestRender();
			return { consume: true };
		});
		const own = mode as unknown as Record<string, unknown>;
		const overridden = ["showStatus", "showWarning", "showError", "jumpToTranscriptEnd"] as const;
		const ownBefore = new Map(
			overridden.filter((name) => Object.hasOwn(mode, name)).map((name) => [name, own[name]] as const),
		);
		const showStatus = mode.showStatus;
		const showWarning = mode.showWarning;
		const showError = mode.showError;
		const jumpToTranscriptEnd = mode.jumpToTranscriptEnd;
		// Main's notices stay main's, rows in its transcript as before; while a subagent is shown they are also drawn
		// under its transcript, where the reader is looking.
		own.showStatus = function (this: InteractiveModeBase, message: string, ...rest: unknown[]): void {
			(showStatus as (...args: unknown[]) => void).call(this, message, ...rest);
			if (agentShown()) mirror("status", message);
		};
		own.showWarning = function (this: InteractiveModeBase, message: string, ...rest: unknown[]): void {
			(showWarning as (...args: unknown[]) => void).call(this, message, ...rest);
			const target = rest[0];
			if (agentShown() && (target === undefined || target === mode.chatContainer)) mirror("warning", message);
		};
		own.showError = function (this: InteractiveModeBase, message: string): void {
			showError.call(this, message);
			if (agentShown()) mirror("error", message);
		};
		// The jump to the latest row acts on what is shown.
		own.jumpToTranscriptEnd = function (this: InteractiveModeBase): void {
			const viewed = switcher.viewed;
			if (viewed.kind !== "agent") {
				jumpToTranscriptEnd.call(this);
				return;
			}
			viewed.port.transcript.handleViewKey(TRANSCRIPT_JUMP_TO_END_URL);
			mode.ui.requestRender();
		};
		return () => {
			offRenderer();
			removeInput();
			for (const name of overridden) {
				if (ownBefore.has(name)) own[name] = ownBefore.get(name);
				else delete own[name];
			}
		};
	};
	let detach: (() => void) | undefined;

	const endDockHold = (held: DockState) => {
		if (dock !== held || held.kind !== "held") return;
		clearTimeout(held.timer);
		held.offRenderer();
		dock = { kind: "live" };
		applyLayout();
		mode.ui.requestRender();
	};
	dockHolds.set(mode, (timeoutMs) => {
		const tui = mode.ui;
		const screen = (tui as { getScreenLines?(): string[] }).getScreenLines?.();
		const rows = tui.terminal.rows;
		const top = agentShown() ? slot.paintedRows : mode.transcriptScrollView?.viewportHeight;
		if (
			dock.kind === "held" ||
			!isViewportTUI(tui) ||
			// An overlay over the screen is in the rows too; the screen without it is not what they show.
			tui.hasOverlay() ||
			mode.fullscreenDock === undefined ||
			screen === undefined ||
			screen.length !== rows ||
			top === undefined ||
			top < 1 ||
			top >= rows
		)
			return () => {};
		const hold = ++holds;
		const end = () => {
			if (dock.kind === "held" && dock.hold === hold) endDockHold(dock);
		};
		const timer = setTimeout(end, timeoutMs);
		timer.unref?.();
		const columns = tui.terminal.columns;
		const fullscreenDock = mode.fullscreenDock;
		dock = {
			kind: "held",
			hold,
			rows: new HeldDockRows(
				screen.slice(top),
				(width) => width === columns && tui.terminal.columns === columns && tui.terminal.rows === rows,
				(width) => fullscreenDock.render(width),
				() => queueMicrotask(end),
			),
			timer,
			offRenderer: mode.onTuiRendererChange(end),
			root: undefined,
		};
		applyLayout();
		return end;
	});
	// One listener for every hold, added here and never while keys are being handled (a listener added then would see
	// the key that started the hold): a key shows the screen live before it runs, where the reader can see it land.
	// Clicks and wheel turns reach the screen as painted: the transcript above is live, the held rows are inert. It
	// does nothing while no hold is held, so with main shown the screen is exactly as before.
	const removeHoldInput = mode.addTuiInputListener?.((data) => {
		const held = dock;
		if (held.kind === "held" && endsDockHold(data)) endDockHold(held);
		return undefined;
	});

	const offChange = switcher.onChange(({ to }) => {
		unwatchPort?.();
		unwatchPort = undefined;
		slot.clearNotices();
		slot.port = to.kind === "agent" ? to.port : undefined;
		if (to.kind === "agent") {
			detach ??= attach();
			unwatchPort = to.port.subscribe(() => {
				syncFocus();
				mode.ui.requestRender();
			});
		}
		const tui = mode.ui as { resetTextSelection?(): void };
		tui.resetTextSelection?.();
		applyLayout();
		syncFocus();
		if (to.kind === "main") {
			detach?.();
			detach = undefined;
		}
		mode.ui.requestRender();
	});
	const mirror = (kind: NoticeKind, text: string) => {
		slot.addNotice(kind, text);
		mode.ui.requestRender();
	};
	// Notices about the shown subagent alone (a refused command, its pause failing) are drawn under it only.
	setViewedNoticeSink(mode, { show: (text, kind) => mirror(kind === "info" ? "status" : kind, text) });

	return () => {
		endDockHold(dock);
		removeHoldInput?.();
		if (dockHolds.get(mode) !== undefined && slots.get(mode) === slot) dockHolds.delete(mode);
		setViewedNoticeSink(mode, undefined);
		offChange();
		unwatchPort?.();
		detach?.();
		detach = undefined;
		if (agentShown()) {
			slot.port = undefined;
			const tui = mode.ui;
			if (isViewportTUI(tui) && mode.fullscreenLayoutRoot !== undefined)
				tui.setLayoutRoot(mode.fullscreenLayoutRoot);
		}
		if (slots.get(mode) === slot) slots.delete(mode);
	};
}
