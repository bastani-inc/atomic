import {
	CURSOR_MARKER,
	Editor,
	type EditorOptions,
	type EditorTheme,
	isKeyRepeat,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { isPhysicalEscape } from "../interactive-key-identity.ts";
import { theme } from "../theme/theme.ts";
import type { AtomicWorkingLoader } from "./atomic-working-status.ts";

export interface CustomEditorOptions extends EditorOptions {
	promptPrefix?: string;
	placeholder?: string | (() => string);
	/** Render the streaming working status in the editor's top border. */
	embedWorkingStatus?: boolean;
}

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[PX_][\s\S]*?\x1b\\/g;
const BORDER_LINE_PATTERN = /^[─ ↑↓0-9more]+$/;
/** Exact Empty Bracketed Paste sequence from the terminal (image-only macOS Cmd+V). */
const EMPTY_BRACKETED_PASTE = "\x1b[200~\x1b[201~";

function isMacosNativeImagePasteSignal(data: string): boolean {
	if (process.platform !== "darwin") {
		return false;
	}
	// Image-only Cmd+V: some terminals emit Empty Bracketed Paste; Kitty-protocol
	// terminals (e.g. Ghostty) emit super+v as a CSI-u key event instead.
	return data === EMPTY_BRACKETED_PASTE || matchesKey(data, "super+v");
}

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private promptPrefix: string;
	private placeholder: string | (() => string) | undefined;
	private workingStatusIndicator: AtomicWorkingLoader | undefined;
	readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.promptPrefix = options?.promptPrefix ?? "❯ ";
		this.placeholder = options?.placeholder;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	setWorkingStatusIndicator(indicator: AtomicWorkingLoader | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	setPlaceholder(placeholder: string | (() => string) | undefined): void {
		this.placeholder = placeholder;
	}

	render(width: number): string[] {
		const promptWidth = visibleWidth(this.promptPrefix);
		if (promptWidth <= 0 || width <= promptWidth + 1) {
			return super.render(width);
		}

		const editorWidth = Math.max(1, width - promptWidth);
		const lines = super.render(editorWidth);
		let borderCount = 0;
		let inPromptBox = false;
		let promptShown = false;

		const placeholder = typeof this.placeholder === "function" ? this.placeholder() : this.placeholder;

		return lines.map((line) => {
			if (this.isEditorBorderLine(line)) {
				borderCount += 1;
				if (borderCount === 1) {
					inPromptBox = true;
					promptShown = false;
					return this.renderTopBorderWithWorkingStatus(line, width);
				} else if (borderCount === 2) {
					inPromptBox = false;
				}
				return this.extendBorderLine(line, width);
			}

			const showPrompt = inPromptBox && !promptShown;
			const prefix = showPrompt ? this.promptPrefix : " ".repeat(promptWidth);
			let content = line;
			if (showPrompt && placeholder && this.getText() === "") {
				content = this.renderPlaceholder(placeholder, editorWidth);
			}
			if (inPromptBox) {
				promptShown = true;
			}
			return this.padLine(`${prefix}${content}`, width);
		});
	}

	private renderPlaceholder(placeholder: string, editorWidth: number): string {
		const cursor = `${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[0m`;
		const placeholderWidth = Math.max(0, editorWidth - 1);
		const text = truncateToWidth(placeholder, placeholderWidth, "...");
		return `${cursor}${theme.fg("muted", text)}`;
	}

	private renderTopBorderWithWorkingStatus(line: string, width: number): string {
		const indicator = this.workingStatusIndicator;
		if (!this.embedWorkingStatus || !indicator || width <= 0) return this.extendBorderLine(line, width);

		const plainLine = line.replace(ANSI_ESCAPE_PATTERN, "");
		const overflowMatch = /↑ (\d+) more/.exec(plainLine);
		let status = indicator.renderInBorder(Math.max(1, width - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) return this.extendBorderLine(line, width);

		if (overflowMatch) {
			const label = overflowMatch[0];
			const labelStart = overflowMatch.index;
			const remainingWidth = width - labelStart - visibleWidth(label);
			if (remainingWidth < statusWidth + 3) {
				status = indicator.renderSpinnerInBorder(width);
				statusWidth = visibleWidth(status);
			}
			if (remainingWidth >= statusWidth + 3) {
				const middleWidth = remainingWidth - statusWidth - 3;
				return (
					this.borderColor(`${"─".repeat(Math.max(0, labelStart - 1))} ${label} ${"─".repeat(middleWidth)} `) +
					status +
					this.borderColor("─")
				);
			}
			// At widths that cannot carry both, preserve pi-tui's overflow label
			// and its stable left-aligned position instead of shifting it.
			return this.extendBorderLine(line, width);
		}

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = indicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	private isEditorBorderLine(line: string): boolean {
		const plain = line.replace(ANSI_ESCAPE_PATTERN, "").trim();
		return plain.includes("─") && BORDER_LINE_PATTERN.test(plain);
	}

	private extendBorderLine(line: string, width: number): string {
		const remainingWidth = width - visibleWidth(line);
		if (remainingWidth <= 0) {
			return line;
		}
		return `${line}${this.borderColor("─".repeat(remainingWidth))}`;
	}

	private padLine(line: string, width: number): string {
		const remainingWidth = width - visibleWidth(line);
		if (remainingWidth <= 0) {
			return line;
		}
		return `${line}${" ".repeat(remainingWidth)}`;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	/**
	 * Buffer captured immediately before the base editor consumed an input event.
	 *
	 * pi-tui's `submitValue()` expands paste markers, trims, and clears the editor
	 * before it calls `onSubmit`, so the callback argument can never be the text
	 * the user actually had. Atomic needs the pre-trim buffer to put an unaccepted
	 * submission back exactly as typed, and 0.82.1 exposes no pre-trim hook.
	 */
	private submittedDraftSnapshot: string | undefined;

	/** Consume the buffer captured for the submission currently being dispatched. */
	takeSubmittedDraft(): string | undefined {
		const draft = this.submittedDraftSnapshot;
		this.submittedDraftSnapshot = undefined;
		return draft;
	}

	handleInput(data: string): boolean {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return true;
		}

		// Explicit Image Paste keybinding, or macOS Native Paste (image-only Cmd+V
		// as empty bracketed paste or Kitty-protocol super+v).
		const isPasteImageSignal =
			this.keybindings.matches(data, "app.clipboard.pasteImage") || isMacosNativeImagePasteSignal(data);
		if (isPasteImageSignal) {
			if (!isKeyRepeat(data)) {
				this.onPasteImage?.();
			}
			return true;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active. Physical Escape is
		// matched directly so a remapped `app.interrupt`/`app.clear` can never route
		// it into a clear, terminate, or engine-restart handler.
		if (isPhysicalEscape(data) || this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return true;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return true;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return true;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P or Ctrl+N without triggering another app action.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return true;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return true;
			}
		}

		// Snapshot the live buffer for the same synchronous dispatch that may submit
		// it, then drop it again so an ordinary keystroke cannot leave stale state.
		this.submittedDraftSnapshot = this.getExpandedText();
		try {
			super.handleInput(data);
		} finally {
			this.submittedDraftSnapshot = undefined;
		}
		return false;
	}
}
