import {
	CURSOR_MARKER,
	Editor,
	type EditorAutocompleteHintEntry,
	type EditorOptions,
	type EditorTheme,
	isHintActivation,
	isKeyRelease,
	isKeyRepeat,
	type Keybinding,
	type KeyId,
	keyInputData,
	matchesKey,
	renderFakeCursor,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@bastani/atomic-tui";
import { keybindingIdentity } from "../../../core/keybinding-identity.js";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { isPhysicalCtrlC, isPhysicalEscape } from "../interactive-key-identity.ts";
import { theme } from "../theme/theme.js";
import type { AtomicWorkingLoader } from "./atomic-working-status.ts";
import { renderComposerRule, sanitizeRuleLabel } from "./composer-rule.ts";

export interface CustomEditorOptions extends EditorOptions {
	promptPrefix?: string;
	placeholder?: string | (() => string);
	/** Render the streaming working status in the editor's top border. */
	embedWorkingStatus?: boolean;
	topRuleLabel?: () => string | undefined;
}

export function stripEditorAnsi(text: string): string {
	let i = text.indexOf("\x1b");
	if (i === -1) return text;
	const len = text.length;
	let out = "";
	let copyFrom = 0;
	let belPos = -1;
	let stPos = -1;
	let lastSt = -2;
	while (i !== -1 && i < len) {
		const next = i + 1 < len ? text.charCodeAt(i + 1) : -1;
		if (next === 0x5b) {
			let j = i + 2;
			while (j < len) {
				const c = text.charCodeAt(j);
				if (c >= 0x30 && c <= 0x3f) j++;
				else break;
			}
			while (j < len) {
				const c = text.charCodeAt(j);
				if (c >= 0x20 && c <= 0x2f) j++;
				else break;
			}
			if (j < len) {
				const c = text.charCodeAt(j);
				if (c >= 0x40 && c <= 0x7e) {
					out += text.slice(copyFrom, i);
					copyFrom = j + 1;
					i = text.indexOf("\x1b", copyFrom);
					continue;
				}
			}
			i = text.indexOf("\x1b", j);
			continue;
		}
		if (next === 0x5d) {
			if (belPos < i + 2 && belPos !== len) {
				const found = text.indexOf("\x07", i + 2);
				belPos = found === -1 ? len : found;
			}
			let end = -1;
			if (belPos < len) {
				end = belPos + 1;
			} else {
				if (lastSt === -2) lastSt = text.lastIndexOf("\x1b\\");
				if (lastSt >= i + 2) end = lastSt + 2;
			}
			if (end !== -1) {
				out += text.slice(copyFrom, i);
				copyFrom = end;
				i = text.indexOf("\x1b", copyFrom);
				continue;
			}
			i = text.indexOf("\x1b", i + 2);
			continue;
		}
		if (next === 0x50 || next === 0x58 || next === 0x5f) {
			if (stPos < i + 2 && stPos !== len) {
				const found = text.indexOf("\x1b\\", i + 2);
				stPos = found === -1 ? len : found;
			}
			if (stPos < len) {
				out += text.slice(copyFrom, i);
				copyFrom = stPos + 2;
				i = text.indexOf("\x1b", copyFrom);
				continue;
			}
			i = text.indexOf("\x1b", i + 2);
			continue;
		}
		i = text.indexOf("\x1b", i + 1);
	}
	return copyFrom === 0 ? text : out + text.slice(copyFrom);
}
const BORDER_LINE_PATTERN = /^[─ ↑↓0-9more]+$/;
/** Exact Empty Bracketed Paste sequence from the terminal (image-only macOS Cmd+V). */
const EMPTY_BRACKETED_PASTE = "\x1b[200~\x1b[201~";

/**
 * Actions that take their keys before the back key (`app.nav.back`) reaches the prompt: its own Esc, exit, help, paste
 * and history keys, and the keys the screen takes from an empty prompt (Ctrl+C, the agent panel, the background-work
 * chord, a waited shell). A back key bound to one of them stays theirs.
 */
const KEYS_TAKEN_BEFORE_BACK: readonly Keybinding[] = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.keys.help",
	"app.clipboard.pasteImage",
	"app.agents.focus",
	"app.agents.chord",
	"app.tasks.openWaited",
	"tui.editor.historyPrevious",
	"tui.editor.historyNext",
];
/**
 * Runs the extension shortcut a key press is bound to, answering whether there was one. `takes` answers the same
 * without running it, so a hint never names a key an extension takes.
 */
export type ExtensionShortcutHandler = ((data: string) => boolean) & { readonly takes?: (data: string) => boolean };

/** What the prompt holds when the agent panel's key (`app.agents.focus`) arrives. */
export interface AgentsFocusInput {
	/** Nothing typed (whitespace, a newline or a paste is text) and no completion menu; asked only when it matters. */
	promptEmpty(): boolean;
	/** A click on the key's hint pressed it. */
	readonly clicked: boolean;
}

/** What the prompt holds when the back key arrives. */
export interface NavBackInput {
	/** Nothing typed (whitespace, a newline or a paste is text) and no completion menu. */
	readonly promptEmpty: boolean;
	/** A click on the key's hint pressed it. */
	readonly clicked: boolean;
	/** Whether the key is one of the prompt's {@link CustomEditor.navBackKeys}; asked only when it would go back. */
	isBackKey(): boolean;
}

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
	private topRuleLabel: (() => string | undefined) | undefined;
	private workingStatusIndicator: AtomicWorkingLoader | undefined;
	readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: ExtensionShortcutHandler;
	/**
	 * A back key (`app.nav.back`) that nothing before it took, set while there is somewhere to go back to: answers
	 * whether it went back. When it did not, the key moves the cursor as usual.
	 */
	public onNavBack?: (input: NavBackInput) => boolean;
	/**
	 * The agent panel's key (`app.agents.focus`) that nothing before it took, set on an extension's editor built on this
	 * one: answers whether it focused the agent panel. When it did not, the key moves the cursor as usual. The prompt's
	 * own editor has the key taken before it reaches it.
	 */
	public onAgentsFocus?: (input: AgentsFocusInput) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		const editorTheme = { ...theme };
		super(tui, editorTheme, options);
		this.keybindings = keybindings;
		const renderHint = theme.autocompleteHint;
		if (renderHint) {
			editorTheme.autocompleteHint = (entries, width) => renderHint(this.autocompleteHintEntries(entries), width);
		}
		this.promptPrefix = options?.promptPrefix ?? "❯ ";
		this.placeholder = options?.placeholder;
		this.topRuleLabel = options?.topRuleLabel;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	private autocompleteHintEntries(entries: readonly EditorAutocompleteHintEntry[]): EditorAutocompleteHintEntry[] {
		const taken = new Set<string>();
		for (const action of this.actionHandlers.keys()) {
			if (action === "app.interrupt" || action === "app.exit" || action === "app.keys.help") continue;
			for (const key of this.keybindings.getKeys(action)) taken.add(keybindingIdentity(key));
		}
		for (const action of ["tui.editor.historyPrevious", "tui.editor.historyNext"] as const) {
			for (const key of this.keybindings.getKeys(action)) taken.delete(keybindingIdentity(key));
		}
		if (this.getText().length === 0) {
			for (const key of this.keybindings.getKeys("app.exit")) taken.add(keybindingIdentity(key));
		}
		for (const key of this.keybindings.getKeys("app.interrupt")) taken.delete(keybindingIdentity(key));
		taken.delete("escape");
		for (const key of this.keybindings.getKeys("app.clipboard.pasteImage")) taken.add(keybindingIdentity(key));
		if (process.platform === "darwin") taken.add(keybindingIdentity("super+v"));
		for (const action of ["tui.select.pageUp", "tui.select.pageDown"] as const) {
			for (const key of this.keybindings.getKeys(action)) taken.delete(keybindingIdentity(key));
		}
		for (const action of ["tui.input.copy", "tui.editor.undo"] as const) {
			for (const key of this.keybindings.getKeys(action)) taken.add(keybindingIdentity(key));
		}
		const available = new Map<string, readonly string[]>();
		for (const action of [
			"tui.select.cancel",
			"tui.select.up",
			"tui.select.down",
			"tui.select.pageUp",
			"tui.select.pageDown",
			"tui.input.tab",
			"tui.select.confirm",
		] as const) {
			const keys = this.keybindings.getKeys(action);
			available.set(
				action,
				keys.filter((key) => !taken.has(keybindingIdentity(key))),
			);
			for (const key of keys) taken.add(keybindingIdentity(key));
		}
		return entries.map((entry) => ({
			...entry,
			resolvedKeys: entry.actions.flatMap((action) => {
				const allowed = entry.resolvedKeys?.map((key) => keybindingIdentity(key as KeyId));
				const key = available
					.get(action)
					?.find((candidate) => allowed === undefined || allowed.includes(keybindingIdentity(candidate as KeyId)));
				return key === undefined ? [] : [key];
			}),
		}));
	}

	setTopRuleLabel(label: (() => string | undefined) | undefined): void {
		this.topRuleLabel = label;
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
		const cursor = `${this.focused ? CURSOR_MARKER : ""}${renderFakeCursor(" ")}`;
		const placeholderWidth = Math.max(0, editorWidth - 1);
		const text = truncateToWidth(placeholder, placeholderWidth, "...");
		return `${cursor}${theme.fg("muted", text)}`;
	}

	private renderTopBorderWithWorkingStatus(line: string, width: number): string {
		const indicator = this.workingStatusIndicator;
		if (!this.embedWorkingStatus || !indicator || width <= 0) return this.renderLabeledTopRule(line, width);

		const plainLine = stripEditorAnsi(line);
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

	private renderLabeledTopRule(line: string, width: number): string {
		const raw = this.topRuleLabel?.();
		const label = raw ? sanitizeRuleLabel(raw) : "";
		const plain = stripEditorAnsi(line);
		if (!label || !/^─+$/.test(plain.trim())) return this.extendBorderLine(line, width);
		return renderComposerRule(width, {
			label: { plain: label, styled: theme.fg("muted", label) },
			color: this.borderColor,
		});
	}

	private isEditorBorderLine(line: string): boolean {
		const plain = stripEditorAnsi(line).trim();
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
	 * The keys of `app.nav.back` that go back. Each is judged by what it sends, which is also what a click on its hint
	 * presses: never Esc or Ctrl+C (`ctrl+[` sends Esc), and nothing an extension shortcut or an action handled before
	 * the back key takes. A hint that names the back key names these.
	 */
	navBackKeys(): KeyId[] {
		const taken = [...KEYS_TAKEN_BEFORE_BACK, ...this.actionHandlers.keys()];
		return this.keybindings.getKeys("app.nav.back").filter((key) => {
			const data = keyInputData(key);
			return (
				data !== undefined &&
				!isPhysicalEscape(data) &&
				!isPhysicalCtrlC(data) &&
				!taken.some((action) => this.keybindings.matches(data, action)) &&
				this.onExtensionShortcut?.takes?.(data) !== true
			);
		});
	}

	/** Whether `data` is one of {@link navBackKeys}. */
	isNavBackKey(data: string): boolean {
		return this.navBackKeys().some((key) => matchesKey(data, key));
	}

	/** Whether a typed back key goes back now: the prompt holds nothing and shows no completion menu. */
	navBackEmpty(): boolean {
		return this.getText().length === 0 && !this.isShowingAutocomplete();
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

		// Selection page keys move an open autocomplete menu before app actions run.
		// This lets users bind Ctrl+V even though it pastes images by default.
		if (
			this.isShowingAutocomplete() &&
			(this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.select.pageDown"))
		) {
			super.handleInput(data);
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
				this.dismissEmptyAutocomplete();
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

		// A click on the `? keys` hint opens the keys whatever the prompt holds; a typed `?` does only on an empty one.
		if (
			(isHintActivation() || (this.getText().length === 0 && !this.isShowingAutocomplete())) &&
			this.keybindings.matches(data, "app.keys.help")
		) {
			const handler = this.actionHandlers.get("app.keys.help");
			if (handler) {
				handler();
				return true;
			}
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
			if (
				action !== "app.interrupt" &&
				action !== "app.exit" &&
				action !== "app.keys.help" &&
				this.keybindings.matches(data, action)
			) {
				handler();
				return true;
			}
		}

		// The agent panel's key focuses the panel from an empty prompt, or from a click on its hint.
		if (
			this.onAgentsFocus &&
			!isKeyRelease(data) &&
			this.keybindings.matches(data, "app.agents.focus") &&
			this.onAgentsFocus({
				promptEmpty: () => this.getText().length === 0 && !this.isShowingAutocomplete(),
				clicked: isHintActivation(),
			})
		) {
			return true;
		}

		// The back key goes back from an empty prompt, or from a click on its hint; otherwise it moves the cursor.
		if (
			this.onNavBack &&
			this.keybindings.matches(data, "app.nav.back") &&
			this.onNavBack({
				promptEmpty: this.navBackEmpty(),
				clicked: isHintActivation(),
				isBackKey: () => this.isNavBackKey(data),
			})
		) {
			return true;
		}

		// Snapshot the live buffer for the same synchronous dispatch that may submit
		// it, then drop it again so an ordinary keystroke cannot leave stale state.
		this.submittedDraftSnapshot = this.getExpandedText();
		try {
			super.handleInput(data);
		} finally {
			this.submittedDraftSnapshot = undefined;
		}
		this.continueSlashSkillAutocomplete(data);
		return false;
	}

	/**
	 * 0.86 Editor retriggers slash suggestions only for `[A-Za-z0-9._-]`.
	 * Atomic skill selectors are `/skill:name@scope`, so `:` and `@` must keep
	 * discovery live after the picker closed on a non-matching prefix.
	 */
	private continueSlashSkillAutocomplete(data: string): void {
		if (data !== ":" && data !== "@") return;
		const cursor = this.getCursor();
		if (cursor.line !== 0) return;
		const beforeCursor = (this.getLines()[cursor.line] ?? "").slice(0, cursor.col);
		if (!beforeCursor.trimStart().startsWith("/")) return;
		(
			this as unknown as {
				tryTriggerAutocomplete: (explicitTab?: boolean) => void;
			}
		).tryTriggerAutocomplete();
	}
}
