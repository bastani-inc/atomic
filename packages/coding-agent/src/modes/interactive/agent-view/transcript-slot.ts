import {
	type Component,
	isKeyRelease,
	isViewportTUI,
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

const slots = new WeakMap<InteractiveModeBase, AgentTranscriptSlot>();

function focusedComponent(mode: InteractiveModeBase): object | null | undefined {
	return (mode.ui as { getFocusedComponent?(): object | null }).getFocusedComponent?.();
}

/** The rows a subagent's transcript is drawn in on `mode`'s screen: those of the last frame, else an estimate. */
export function transcriptSlotRows(mode: InteractiveModeBase): number {
	return slots.get(mode)?.transcriptRows ?? Math.max(1, mode.ui.terminal.rows - ESTIMATED_DOCK_ROWS);
}

/**
 * Draw the viewed subagent's transcript where the main transcript is, and main's again when main is shown. While a
 * subagent is shown, the mode's status, warning and error notices are drawn at the bottom of its transcript.
 * Answers the uninstall.
 */
export function installTranscriptSlot(mode: InteractiveModeBase, switcher: AgentViewSwitcher): () => void {
	const slot = new AgentTranscriptSlot(() => Math.max(1, mode.ui.terminal.rows - ESTIMATED_DOCK_ROWS));
	slots.set(mode, slot);
	let agentRoot: Component | undefined;
	let unwatchPort: (() => void) | undefined;
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

	const offChange = switcher.onChange(({ to }) => {
		unwatchPort?.();
		unwatchPort = undefined;
		slot.clearNotices();
		slot.port = to.kind === "agent" ? to.port : undefined;
		if (to.kind === "agent") {
			unwatchPort = to.port.subscribe(() => {
				syncFocus();
				mode.ui.requestRender();
			});
		}
		const tui = mode.ui as { resetTextSelection?(): void };
		tui.resetTextSelection?.();
		applyLayout();
		syncFocus();
		mode.ui.requestRender();
	});
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

	// Notices and the jump to the latest row act on what is shown; while main is shown they are main's, unchanged.
	const own = mode as unknown as Record<string, unknown>;
	const overridden = ["showStatus", "showWarning", "showError", "jumpToTranscriptEnd"] as const;
	const ownBefore = new Map(
		overridden.filter((name) => Object.hasOwn(mode, name)).map((name) => [name, own[name]] as const),
	);
	const showStatus = mode.showStatus;
	const showWarning = mode.showWarning;
	const showError = mode.showError;
	const jumpToTranscriptEnd = mode.jumpToTranscriptEnd;
	own.showStatus = function (this: InteractiveModeBase, message: string, ...rest: unknown[]): void {
		if (!agentShown()) {
			(showStatus as (...args: unknown[]) => void).call(this, message, ...rest);
			return;
		}
		slot.addNotice("status", message);
		mode.ui.requestRender();
	};
	own.showWarning = function (this: InteractiveModeBase, message: string, ...rest: unknown[]): void {
		const target = rest[0];
		if (!agentShown() || (target !== undefined && target !== mode.chatContainer)) {
			(showWarning as (...args: unknown[]) => void).call(this, message, ...rest);
			return;
		}
		slot.addNotice("warning", message);
		mode.ui.requestRender();
	};
	own.showError = function (this: InteractiveModeBase, message: string): void {
		if (!agentShown()) {
			showError.call(this, message);
			return;
		}
		slot.addNotice("error", message);
		mode.ui.requestRender();
	};
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
		offChange();
		offRenderer();
		removeInput();
		unwatchPort?.();
		for (const name of overridden) {
			if (ownBefore.has(name)) own[name] = ownBefore.get(name);
			else delete own[name];
		}
		if (agentShown()) {
			slot.port = undefined;
			const tui = mode.ui;
			if (isViewportTUI(tui) && mode.fullscreenLayoutRoot !== undefined)
				tui.setLayoutRoot(mode.fullscreenLayoutRoot);
		}
		if (slots.get(mode) === slot) slots.delete(mode);
	};
}
