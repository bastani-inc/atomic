import { CURSOR_MARKER, Editor, type EditorOptions, type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";

export interface CustomEditorOptions extends EditorOptions {
	promptPrefix?: string;
	placeholder?: string | (() => string);
}

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[PX_][\s\S]*?\x1b\\/g;
const BORDER_LINE_PATTERN = /^[─ ↑↓0-9more]+$/;

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private promptPrefix: string;
	private placeholder: string | (() => string) | undefined;
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

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
