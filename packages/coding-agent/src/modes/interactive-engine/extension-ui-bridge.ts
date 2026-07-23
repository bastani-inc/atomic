import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ResourceOverlap } from "../../core/diagnostics.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { ExtensionUIContext } from "../../core/extensions/index.ts";
import type { ActivityWatchdogDiagnostic } from "./activity-watchdog.ts";
import type { EngineExtensionShortcut, EngineKeybindingState, InteractiveEngineMessage } from "./protocol.ts";
import { IsolatedInteractiveRuntime } from "./isolated-runtime.ts";
import { RemoteComponentController } from "./remote-component.ts";
import { InputFormHostController } from "./input-form-host.ts";
import { SessionPickerHostController } from "./session-picker-host.ts";
import type { RpcAutocompleteItem, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcSlashCommand } from "../rpc/rpc-types.ts";

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

interface EngineMessageSource {
	onEngineMessage(listener: (message: InteractiveEngineMessage) => void): () => void;
	onKeybindingState?(listener: (state: EngineKeybindingState) => void): () => void;
}

export function attachInteractiveEngineKeybindingSync(
	runtime: EngineMessageSource,
	keybindings: KeybindingsManager,
	onState?: (state: EngineKeybindingState) => void,
): () => void {
	const applyState = (state: EngineKeybindingState): void => {
		keybindings.setUserBindings(state.userBindings);
		onState?.(state);
	};
	if (runtime.onKeybindingState) return runtime.onKeybindingState(applyState);
	return runtime.onEngineMessage((message) => {
		if (message.type === "engine_keybindings_reloaded") applyState(message.state);
	});
}

export function attachInteractiveEngineHost(
	runtime: AgentSessionRuntime,
	ui: ExtensionUIContext,
	onDiagnostic: (diagnostic: ActivityWatchdogDiagnostic) => void,
	setShortcutHandler?: (handler: (data: string) => boolean) => void | (() => void),
	keybindings?: KeybindingsManager,
): () => void {
	if (!(runtime instanceof IsolatedInteractiveRuntime)) return () => {};
	const disposeDiagnostic = runtime.onDiagnostic(onDiagnostic);
	const disposeExtensionUi = runtime.setExtensionUIHandler((request) => handleRequest(ui, request));
	let shortcuts: EngineExtensionShortcut[] = [];
	const dispatchShortcut = (data: string): boolean => {
		const shortcut = shortcuts.find(({ key }) => matchesKey(data, key as KeyId));
		if (!shortcut) return false;
		void runtime.invokeRemoteShortcut(shortcut.key).catch((error: Error) =>
			onDiagnostic({ activity: undefined, elapsedMs: 0, level: "unresponsive", message: error.message }));
		return true;
	};
	let disposeShortcutHandler: (() => void) | undefined;
	const installShortcutHandler = (): void => {
		disposeShortcutHandler?.();
		const dispose = setShortcutHandler?.(dispatchShortcut);
		disposeShortcutHandler = typeof dispose === "function" ? dispose : undefined;
	};
	const applyState = (state: EngineKeybindingState): void => {
		shortcuts = [...state.shortcuts];
		installShortcutHandler();
	};
	installShortcutHandler();
	const disposeKeybindings = keybindings
		? attachInteractiveEngineKeybindingSync(runtime, keybindings, applyState)
		: runtime.onEngineMessage((message) => {
			if (message.type === "engine_keybindings_reloaded") applyState(message.state);
		});
	const remoteComponents = new RemoteComponentController(runtime, ui);
	const sessionPicker = new SessionPickerHostController(runtime, ui);
	const inputForm = new InputFormHostController(runtime, ui);
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		disposeShortcutHandler?.();
		disposeKeybindings();
		remoteComponents.dispose();
		sessionPicker.dispose();
		inputForm.dispose();
		disposeExtensionUi();
		disposeDiagnostic();
	};
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

export function getInteractiveEngineResourceOverlaps(runtime: AgentSessionRuntime): readonly ResourceOverlap[] {
	return runtime instanceof IsolatedInteractiveRuntime ? runtime.getResourceOverlaps() : [];
}

/** Evaluate an engine-child command's live argument completions. */
export function getInteractiveEngineRemoteCommandCompletions(
	runtime: AgentSessionRuntime,
	commandName: string,
	argumentPrefix: string,
): Promise<RpcAutocompleteItem[] | null> {
	return runtime instanceof IsolatedInteractiveRuntime
		? runtime.getRemoteCommandCompletions(commandName, argumentPrefix)
		: Promise.resolve(null);
}

/** Subscribe to engine-child command catalog changes. No-op when not isolated. */
export function onInteractiveEngineRemoteCommandsChanged(
	runtime: AgentSessionRuntime,
	listener: (commands: readonly RpcSlashCommand[]) => void,
): () => void {
	return runtime instanceof IsolatedInteractiveRuntime ? runtime.onRemoteCommandsChanged(listener) : () => {};
}
