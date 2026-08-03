import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ResourceOverlap } from "../../core/diagnostics.ts";
import type { ExtensionUIContext } from "../../core/extensions/index.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { RpcAutocompleteItem, RpcSlashCommand } from "../rpc/rpc-types.ts";
import type { ActivityWatchdogDiagnostic } from "./activity-watchdog.ts";
import { EngineDialogHostController } from "./engine-dialog-host.ts";
import { InputFormHostController } from "./input-form-host.ts";
import { IsolatedInteractiveRuntime } from "./isolated-runtime.ts";
import type { EngineExtensionShortcut, EngineKeybindingState, InteractiveEngineMessage } from "./protocol.ts";
import { RemoteComponentController } from "./remote-component.ts";
import { registerRemoteProxyOwnership } from "./remote-input-ownership.ts";
import { SessionPickerHostController } from "./session-picker-host.ts";

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
	setShortcutHandler?: (handler: (data: string) => boolean) => undefined | (() => void),
	keybindings?: KeybindingsManager,
): () => void {
	if (!(runtime instanceof IsolatedInteractiveRuntime)) return () => {};
	const disposeDiagnostic = runtime.onDiagnostic(onDiagnostic);
	// Generation-owned: RPC dialogs mount real host components and must not
	// outlive, or answer through, a replacement engine child.
	const dialogs = new EngineDialogHostController(runtime, ui);
	let shortcuts: EngineExtensionShortcut[] = [];
	const dispatchShortcut = (data: string): boolean => {
		const shortcut = shortcuts.find(({ key }) => matchesKey(data, key as KeyId));
		if (!shortcut) return false;
		void runtime
			.invokeRemoteShortcut(shortcut.key)
			.catch((error: Error) =>
				onDiagnostic({ activity: undefined, elapsedMs: 0, level: "unresponsive", message: error.message }),
			);
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
	// Ctrl+C must reach the host while a remote proxy owns input, so publish the
	// only component that can answer that question exactly.
	const disposeOwnership = registerRemoteProxyOwnership(runtime, remoteComponents);
	const sessionPicker = new SessionPickerHostController(runtime, ui);
	const inputForm = new InputFormHostController(runtime, ui);
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		disposeShortcutHandler?.();
		disposeKeybindings();
		disposeOwnership();
		remoteComponents.dispose();
		sessionPicker.dispose();
		inputForm.dispose();
		dialogs.dispose();
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
 * True when the interactive engine still owes a cooperative abort or the
 * heartbeat watchdog has declared it unresponsive, i.e. when the explicit
 * Ctrl+C escape hatch promised by the watchdog copy applies.
 */
export function interactiveEngineNeedsExplicitTermination(runtime: AgentSessionRuntime): boolean {
	return runtime instanceof IsolatedInteractiveRuntime && runtime.needsExplicitTermination();
}

/**
 * Explicitly terminate an unresponsive interactive engine and start recovery.
 * Only ever reached from a deliberate user action (Ctrl+C) — never from Escape.
 */
export function terminateInteractiveEngine(runtime: AgentSessionRuntime): boolean {
	if (!interactiveEngineNeedsExplicitTermination(runtime)) return false;
	void (runtime as IsolatedInteractiveRuntime).terminateAndRecover();
	return true;
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
