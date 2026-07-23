import * as crypto from "node:crypto";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	HostInputFormRequest,
	HostSessionPickerRequest,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import type { FooterDataProvider } from "../../core/footer-data-provider.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import type { EngineCustomUiService } from "../interactive-engine/engine-custom-ui.ts";
import type { EngineInputFormService } from "../interactive-engine/engine-input-form.ts";
import type { EngineSessionPickerService } from "../interactive-engine/engine-session-picker.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./rpc-types.ts";
import type { RpcOutput } from "./rpc-responses.ts";

export interface RpcPendingExtensionRequest {
	resolve: (value: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
}

export type RpcPendingExtensionRequests = Map<string, RpcPendingExtensionRequest>;

interface CreateRpcExtensionUIContextOptions {
	output: RpcOutput;
	pendingExtensionRequests: RpcPendingExtensionRequests;
	customUi?: EngineCustomUiService;
	sessionPicker?: EngineSessionPickerService;
	inputForm?: EngineInputFormService;
	footerDataProvider?: FooterDataProvider;
}

interface DialogPromiseOptions<T> extends CreateRpcExtensionUIContextOptions {
	dialogOptions: ExtensionUIDialogOptions | undefined;
	defaultValue: T;
	request: Record<string, unknown>;
	parseResponse: (response: RpcExtensionUIResponse) => T;
}

function createDialogPromise<T>({
	output,
	pendingExtensionRequests,
	dialogOptions,
	defaultValue,
	request,
	parseResponse,
}: DialogPromiseOptions<T>): Promise<T> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(defaultValue);

	const id = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			dialogOptions?.signal?.removeEventListener("abort", onAbort);
			pendingExtensionRequests.delete(id);
		};

		const onAbort = () => {
			cleanup();
			resolve(defaultValue);
		};
		dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });

		if (dialogOptions?.timeout) {
			timeoutId = setTimeout(() => {
				cleanup();
				resolve(defaultValue);
			}, dialogOptions.timeout);
		}

		pendingExtensionRequests.set(id, {
			resolve: (response: RpcExtensionUIResponse) => {
				cleanup();
				resolve(parseResponse(response));
			},
			reject,
		});
		output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
	});
}

function emitExtensionUIRequest(output: RpcOutput, request: Record<string, unknown>): void {
	output({ type: "extension_ui_request", id: crypto.randomUUID(), ...request } as RpcExtensionUIRequest);
}

export function createRpcExtensionUIContext({
	output,
	pendingExtensionRequests,
	customUi,
	sessionPicker,
	inputForm,
	footerDataProvider,
}: CreateRpcExtensionUIContextOptions): ExtensionUIContext {
	const unsupportedWarnings = new Set<string>();
	let toolsExpanded = false;
	const warnUnsupported = (method: string): void => {
		if (!customUi || unsupportedWarnings.has(method)) return;
		unsupportedWarnings.add(method);
		emitExtensionUIRequest(output, {
			method: "notify",
			message: `${method} is unavailable in isolated interactive mode because it requires a synchronous host callback`,
			notifyType: "warning",
		});
	};
	return {
		select: (title, options, opts) =>
			createDialogPromise({
				output,
				pendingExtensionRequests,
				dialogOptions: opts,
				defaultValue: undefined,
				request: { method: "select", title, options, timeout: opts?.timeout },
				parseResponse: (response) =>
					"cancelled" in response && response.cancelled ? undefined : "value" in response ? response.value : undefined,
			}),

		confirm: (title, message, opts) =>
			createDialogPromise({
				output,
				pendingExtensionRequests,
				dialogOptions: opts,
				defaultValue: false,
				request: { method: "confirm", title, message, timeout: opts?.timeout },
				parseResponse: (response) =>
					"cancelled" in response && response.cancelled ? false : "confirmed" in response ? response.confirmed : false,
			}),

		input: (title, placeholder, opts) =>
			createDialogPromise({
				output,
				pendingExtensionRequests,
				dialogOptions: opts,
				defaultValue: undefined,
				request: { method: "input", title, placeholder, timeout: opts?.timeout },
				parseResponse: (response) =>
					"cancelled" in response && response.cancelled ? undefined : "value" in response ? response.value : undefined,
			}),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			emitExtensionUIRequest(output, { method: "notify", message, notifyType: type });
		},

		requestRender(): void { customUi?.requestRender(); },

		getHostCustomUiState: () => customUi?.getHostCustomUiState() ?? {
			blockingInlineCustomUiDepth: 0,
			blockingInlineCustomUiActive: false,
		},
		onHostCustomUiStateChange: (listener) => customUi?.onHostCustomUiStateChange(listener) ?? (() => {}),
		focusHostInlineCustomUi: () => customUi?.focusHostInlineCustomUi() ?? false,

		onTerminalInput(): () => void {
			warnUnsupported("ctx.ui.onTerminalInput");
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			footerDataProvider?.setExtensionStatus(key, text);
			// Isolated custom UI components (e.g. an attached stage-chat footer)
			// re-render only after an engine_custom_invalidate; without this the
			// mirrored status text goes stale until an unrelated repaint occurs.
			customUi?.requestRender();
			emitExtensionUIRequest(output, { method: "setStatus", statusKey: key, statusText: text });
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			if (content === undefined) {
				customUi?.setWidget(key, undefined, options?.placement);
				emitExtensionUIRequest(output, {
					method: "setWidget", widgetKey: key, widgetLines: undefined, widgetPlacement: options?.placement,
				});
				return;
			}
			if (Array.isArray(content)) {
				emitExtensionUIRequest(output, {
					method: "setWidget", widgetKey: key, widgetLines: content as string[], widgetPlacement: options?.placement,
				});
				return;
			}
			if (customUi && typeof content === "function") {
				customUi.setWidget(key, content as (tui: TUI, theme: Theme) => Component & { dispose?(): void }, options?.placement);
				return;
			}
			warnUnsupported("component-factory widgets");
		},

		setFooter(): void { warnUnsupported("ctx.ui.setFooter"); },

		setHeader(): void { warnUnsupported("ctx.ui.setHeader"); },

		setTitle(title: string): void {
			emitExtensionUIRequest(output, { method: "setTitle", title });
		},

		custom: (factory, options) => customUi
			? customUi.custom(factory, options)
			: Promise.resolve(undefined as never),

		// Exposed in the isolated engine child, where the terminal host mounts
		// the real session selector natively so picker navigation never crosses
		// the process boundary. Absent in plain headless RPC (no interactive
		// host); callers must fail with an actionable error, not degrade.
		...(sessionPicker ? { hostSessionPicker: (request: HostSessionPickerRequest) => sessionPicker.open(request) } : {}),
		...(inputForm ? { hostInputForm: (request: HostInputFormRequest) => inputForm.open(request) } : {}),

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			emitExtensionUIRequest(output, { method: "set_editor_text", text });
		},

		getEditorText(): string {
			warnUnsupported("ctx.ui.getEditorText");
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void { warnUnsupported("ctx.ui.addAutocompleteProvider"); },

		setEditorComponent(): void { warnUnsupported("ctx.ui.setEditorComponent"); },

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		getFooterDataProvider() {
			return footerDataProvider ?? {
				getGitBranch: () => null,
				getExtensionStatuses: () => new Map(),
				getAvailableProviderCount: () => 1,
				onBranchChange: () => () => {},
			};
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			return toolsExpanded;
		},

		setToolsExpanded(expanded: boolean) {
			toolsExpanded = expanded;
			customUi?.requestRender();
		},

		getChatRenderSettings() {
			return {
				hideThinkingBlock: false,
				hiddenThinkingLabel: "Thinking...",
				toolOutputExpanded: toolsExpanded,
				showImages: false,
				imageWidthCells: 60,
				getToolDefinition: () => undefined,
				getCustomMessageRenderer: () => undefined,
			};
		},
	};
}
