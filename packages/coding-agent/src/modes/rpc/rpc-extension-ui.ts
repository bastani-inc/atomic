import * as crypto from "node:crypto";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
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
}: CreateRpcExtensionUIContextOptions): ExtensionUIContext {
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

		requestRender(): void {
			// RPC mode does not own a local TUI renderer.
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
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
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				emitExtensionUIRequest(output, {
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				});
			}
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			emitExtensionUIRequest(output, { method: "setTitle", title });
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			emitExtensionUIRequest(output, { method: "set_editor_text", text });
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response; host should track editor state locally if needed.
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

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		getFooterDataProvider() {
			return {
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
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},

		getChatRenderSettings() {
			return {
				hideThinkingBlock: false,
				hiddenThinkingLabel: "Thinking...",
				toolOutputExpanded: false,
				showImages: false,
				imageWidthCells: 60,
				getToolDefinition: () => undefined,
				getCustomMessageRenderer: () => undefined,
			};
		},
	};
}
