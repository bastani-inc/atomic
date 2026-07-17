import type {
	AutocompleteProvider,
	Component,
	EditorComponent,
	EditorTheme,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.ts";
import type { KeybindingsManager } from "../keybindings.ts";
import type { MessageRenderer } from "./message-types.ts";
import type { ToolDefinition } from "./tool-types.ts";

/** Options for extension UI dialogs. */
export interface ExtensionUIDialogOptions {
	/** AbortSignal to programmatically dismiss the dialog. */
	signal?: AbortSignal;
	/** Timeout in milliseconds. Dialog auto-dismisses with live countdown display. */
	timeout?: number;
}

/** Placement for extension widgets. */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** Options for extension widgets. */
export interface ExtensionWidgetOptions {
	/** Where the widget is rendered. Defaults to "aboveEditor". */
	placement?: WidgetPlacement;
}

/** Raw terminal input listener for extensions. */
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** Working indicator configuration for the interactive streaming loader. */
export interface WorkingIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator entirely. Custom frames are rendered verbatim. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

/** Wrap the current autocomplete provider with additional behavior. */
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

export interface ChatRenderSettings {
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	toolOutputExpanded: boolean;
	showImages: boolean;
	imageWidthCells: number;
	getToolDefinition(toolName: string): ToolDefinition | undefined;
	getCustomMessageRenderer(customType: string): MessageRenderer | undefined;
}

/** Host-owned inline custom UI focus state exposed to overlays without prompt content. */
export interface HostCustomUiState {
	/** Number of active non-overlay host custom UI mounts. */
	blockingInlineCustomUiDepth: number;
	/** True when at least one non-overlay host custom UI is mounted and blocking. */
	blockingInlineCustomUiActive: boolean;
	/** True when the active inline custom UI is waiting behind an overlay that kept focus. */
	blockingInlineCustomUiFocusDeferred?: boolean;
}

export type HostCustomUiStateListener = (state: HostCustomUiState) => void;

/**
 * JSON-safe session-selector row for the host-native session picker.
 * Mirrors `SessionInfo` with `created`/`modified` flattened to epoch millis so
 * rows can cross the interactive-engine protocol without `Date` objects.
 */
export interface HostSessionPickerRow {
	path: string;
	id: string;
	cwd: string;
	/** Creation time in epoch milliseconds. */
	createdAt: number;
	/** Last-modified time in epoch milliseconds. */
	modifiedAt: number;
	messageCount: number;
	firstMessage: string;
	allMessagesText?: string;
	name?: string;
	/** Optional semantic color for synthetic selector rows. */
	messageColor?: "success" | "warning" | "accent" | "error";
}

/** Request for {@link ExtensionUIContext.hostSessionPicker}. */
export interface HostSessionPickerRequest {
	/** Rows shown in the first frame. Push later rows via the handle's `update()`. */
	sessions: HostSessionPickerRow[];
	/** Show the rename keybinding hint in the picker header. Defaults to false. */
	showRenameHint?: boolean;
	/**
	 * Invoked after the user confirms a Ctrl+D delete on a row. The host does
	 * NOT remove the row; reply with `update()` (row removed) or `error()`.
	 */
	onDelete?: (path: string) => void | Promise<void>;
}

/** Live control surface for an open host-native session picker. */
export interface HostSessionPickerHandle {
	/** Resolves with the selected row's `path`, or `undefined` on cancel/close. */
	result: Promise<string | undefined>;
	/** Replace the picker rows (navigation/search state is preserved host-side). */
	update(sessions: HostSessionPickerRow[]): void;
	/** Surface a transient error message in the picker header. */
	error(message: string): void;
	/** Close the picker; `result` resolves `undefined`. Idempotent. */
	close(): void;
}

/**
 * UI context for extensions to request interactive UI.
 * Each mode (interactive, RPC, print) provides its own implementation.
 */
export interface ExtensionUIContext {
	/** Show a selector and return the user's choice. */
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a confirmation dialog. */
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	/** Show a text input dialog. */
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a notification to the user. */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/** Request an interactive repaint after extension-owned state changes. */
	requestRender(): void;

	/** Get host-owned inline custom UI focus state, if the mode exposes it. */
	getHostCustomUiState?(): HostCustomUiState;

	/** Observe host-owned inline custom UI focus state changes. Returns an unsubscribe function. */
	onHostCustomUiStateChange?(listener: HostCustomUiStateListener): () => void;

	/** Move focus to a mounted host-owned inline custom UI, if one is pending. */
	focusHostInlineCustomUi?(): boolean;

	/** Listen to raw terminal input (interactive mode only). Returns an unsubscribe function. */
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/** Set status text in the footer/status bar. Pass undefined to clear. */
	setStatus(key: string, text: string | undefined): void;

	/** Set the working/loading message shown during streaming. Call with no argument to restore default. */
	setWorkingMessage(message?: string): void;

	/** Show or hide the built-in interactive working loader row during streaming. */
	setWorkingVisible(visible: boolean): void;

	/**
	 * Configure the interactive working indicator shown during streaming.
	 *
	 * - Omit the argument to restore the default animated spinner.
	 * - Use `frames: ["●"]` for a static indicator.
	 * - Use `frames: []` to hide the indicator entirely.
	 * - Custom frames are rendered as provided, so extensions must add their own colors.
	 */
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;

	/** Set the label shown for hidden thinking blocks. Call with no argument to restore default. */
	setHiddenThinkingLabel(label?: string): void;

	/** Set a widget to display above or below the editor. Accepts string array or component factory. */
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void;

	/** Set a custom footer component, or undefined to restore the built-in footer.
	 *
	 * The factory receives a FooterDataProvider for data not otherwise accessible:
	 * git branch and extension statuses from setStatus(). Token stats, model info,
	 * etc. are available via ctx.sessionManager and ctx.model.
	 */
	setFooter(
		factory:
			| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void;

	/** Set a custom header component (shown at startup, above chat), or undefined to restore the built-in header. */
	setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;

	/** Set the terminal window/tab title. */
	setTitle(title: string): void;

	/** Show a custom component with keyboard focus. */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			/** Keep host inline custom UI pending in the background while this overlay is visible. */
			deferInlineCustomUiFocus?: boolean;
			/** AbortSignal to programmatically dismiss the custom UI. */
			signal?: AbortSignal;
			/** Overlay positioning/sizing options. Can be static or a function for dynamic updates. */
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			/** Called with the overlay handle after the overlay is shown. Use to control visibility. */
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T>;

	/**
	 * Open a session-list picker that runs natively in the host terminal
	 * process. Every interactive host implements it — non-isolated mode
	 * mounts the selector directly (no IPC), isolated mode routes it over
	 * the engine session-picker protocol channel — so callers use one
	 * identical API. In both cases navigation and search never cross a
	 * process boundary; only open/update/select/delete/cancel do. The
	 * member is absent only on non-interactive surfaces (headless RPC,
	 * print); callers should fail with an actionable error there rather
	 * than degrade.
	 */
	hostSessionPicker?(request: HostSessionPickerRequest): HostSessionPickerHandle;

	/** Paste text into the editor, triggering paste handling (collapse for large content). */
	pasteToEditor(text: string): void;

	/** Set the text in the core input editor. */
	setEditorText(text: string): void;

	/** Get the current text from the core input editor. */
	getEditorText(): string;

	/** Show a multi-line editor for text editing. */
	editor(title: string, prefill?: string): Promise<string | undefined>;

	/** Stack additional autocomplete behavior on top of the built-in provider. */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	/**
	 * Set a custom editor component via factory function.
	 * Pass undefined to restore the default editor.
	 *
	 * The factory receives:
	 * - `theme`: EditorTheme for styling borders and autocomplete
	 * - `keybindings`: KeybindingsManager for app-level keybindings
	 *
	 * For full app keybinding support (escape, ctrl+d, model switching, etc.),
	 * extend `CustomEditor` from `@bastani/atomic` and call
	 * `super.handleInput(data)` for keys you don't handle.
	 *
	 * @example
	 * ```ts
	 * import { CustomEditor } from "@bastani/atomic";
	 *
	 * class VimEditor extends CustomEditor {
	 *   private mode: "normal" | "insert" = "insert";
	 *
	 *   handleInput(data: string): void {
	 *     if (this.mode === "normal") {
	 *       // Handle vim normal mode keys...
	 *       if (data === "i") { this.mode = "insert"; return; }
	 *     }
	 *     super.handleInput(data);  // App keybindings + text editing
	 *   }
	 * }
	 *
	 * ctx.ui.setEditorComponent((tui, theme, keybindings) =>
	 *   new VimEditor(tui, theme, keybindings)
	 * );
	 * ```
	 */
	setEditorComponent(factory: EditorFactory | undefined): void;

	/** Get the currently configured custom editor factory, or undefined when using the default editor. */
	getEditorComponent(): EditorFactory | undefined;

	/** Get the built-in footer data provider so embedded extension UIs can reuse the core footer. */
	getFooterDataProvider(): ReadonlyFooterDataProvider;

	/** Get the current theme for styling. */
	readonly theme: Theme;

	/** Get all available themes with their names and file paths. */
	getAllThemes(): { name: string; path: string | undefined }[];

	/** Load a theme by name without switching to it. Returns undefined if not found. */
	getTheme(name: string): Theme | undefined;

	/** Set the current theme by name or Theme object. */
	setTheme(theme: string | Theme): { success: boolean; error?: string };

	/** Get current tool output expansion state. */
	getToolsExpanded(): boolean;

	/** Set tool output expansion state. */
	setToolsExpanded(expanded: boolean): void;

	/** Get current chat rendering preferences and extension renderers. */
	getChatRenderSettings(): ChatRenderSettings;
}
