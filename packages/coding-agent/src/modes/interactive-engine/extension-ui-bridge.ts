import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../../core/extensions/index.ts";
import type { ActivityWatchdogDiagnostic } from "./activity-watchdog.ts";
import { IsolatedInteractiveRuntime } from "./isolated-runtime.ts";
import { RemoteComponentController } from "./remote-component.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcSlashCommand } from "../rpc/rpc-types.ts";

async function handleRequest(
	ui: ExtensionUIContext,
	request: RpcExtensionUIRequest,
): Promise<RpcExtensionUIResponse | undefined> {
	switch (request.method) {
		case "select": {
			const value = await ui.select(request.title, request.options, { timeout: request.timeout });
			return value === undefined
				? { type: "extension_ui_response", id: request.id, cancelled: true }
				: { type: "extension_ui_response", id: request.id, value };
		}
		case "confirm": {
			const confirmed = await ui.confirm(request.title, request.message, { timeout: request.timeout });
			return { type: "extension_ui_response", id: request.id, confirmed };
		}
		case "input": {
			const value = await ui.input(request.title, request.placeholder, { timeout: request.timeout });
			return value === undefined
				? { type: "extension_ui_response", id: request.id, cancelled: true }
				: { type: "extension_ui_response", id: request.id, value };
		}
		case "editor": {
			const value = await ui.editor(request.title, request.prefill);
			return value === undefined
				? { type: "extension_ui_response", id: request.id, cancelled: true }
				: { type: "extension_ui_response", id: request.id, value };
		}
		case "notify":
			ui.notify(request.message, request.notifyType);
			return undefined;
		case "setStatus":
			ui.setStatus(request.statusKey, request.statusText);
			return undefined;
		case "setWidget":
			ui.setWidget(request.widgetKey, request.widgetLines, { placement: request.widgetPlacement });
			return undefined;
		case "setTitle":
			ui.setTitle(request.title);
			return undefined;
		case "set_editor_text":
			ui.setEditorText(request.text);
			return undefined;
	}
}

export function attachInteractiveEngineHost(
	runtime: AgentSessionRuntime,
	ui: ExtensionUIContext,
	onDiagnostic: (diagnostic: ActivityWatchdogDiagnostic) => void,
	setShortcutHandler?: (handler: (data: string) => boolean) => void,
): void {
	if (!(runtime instanceof IsolatedInteractiveRuntime)) return;
	runtime.onDiagnostic(onDiagnostic);
	runtime.setExtensionUIHandler((request) => handleRequest(ui, request));
	new RemoteComponentController(runtime, ui);
	if (setShortcutHandler) {
		void runtime.getRemoteShortcuts().then(({ shortcuts }) => {
			setShortcutHandler((data) => {
				const shortcut = shortcuts.find(({ key }) => matchesKey(data, key as KeyId));
				if (!shortcut) return false;
				void runtime.invokeRemoteShortcut(shortcut.key).catch((error: Error) =>
					onDiagnostic({ activity: undefined, elapsedMs: 0, level: "unresponsive", message: error.message }));
				return true;
			});
		});
	}
}

export async function waitForInteractiveEngineBound(runtime: AgentSessionRuntime): Promise<void> {
	if (!(runtime instanceof IsolatedInteractiveRuntime)) return;
	await runtime.waitUntilBound();
	await runtime.initializeFromEngine();
}

export function interruptBlockedInteractiveEngine(runtime: AgentSessionRuntime): boolean {
	return runtime instanceof IsolatedInteractiveRuntime && runtime.interruptBlockedCallback();
}

/**
 * Command catalog the engine child exposes to the isolated host. Returns an
 * empty list for non-isolated runtimes so callers can merge unconditionally.
 */
export function getInteractiveEngineRemoteCommands(runtime: AgentSessionRuntime): readonly RpcSlashCommand[] {
	return runtime instanceof IsolatedInteractiveRuntime ? runtime.getRemoteCommands() : [];
}

/** Subscribe to engine-child command catalog changes. No-op when not isolated. */
export function onInteractiveEngineRemoteCommandsChanged(
	runtime: AgentSessionRuntime,
	listener: (commands: readonly RpcSlashCommand[]) => void,
): () => void {
	return runtime instanceof IsolatedInteractiveRuntime ? runtime.onRemoteCommandsChanged(listener) : () => {};
}
