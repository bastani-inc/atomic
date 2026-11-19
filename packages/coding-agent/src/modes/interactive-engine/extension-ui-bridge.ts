import { type KeyId, matchesKey } from "@bastani/atomic-tui";
import type { ClearedQueue } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ResourceOverlap } from "../../core/diagnostics.ts";
import type { UIPromptEndEvent, UIPromptStartEvent } from "../../core/extensions/agent-events.ts";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { RpcAutocompleteItem, RpcResourceExtension, RpcSlashCommand } from "../rpc/rpc-types.ts";
import type { ActivityWatchdogDiagnostic } from "./activity-watchdog.ts";
import { EngineDialogHostController } from "./engine-dialog-host.ts";
import { InputFormHostController } from "./input-form-host.ts";
import { type EngineResourceIssues, IsolatedInteractiveRuntime } from "./isolated-runtime.js";
import type { EngineExtensionShortcut, EngineKeybindingState, InteractiveEngineMessage } from "./protocol.ts";
import { RemoteComponentController, type TuiRendererLifecycle } from "./remote-component.ts";
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
	tuiRendererLifecycle: TuiRendererLifecycle,
	setShortcutHandler?: (handler: (data: string) => boolean) => undefined | (() => void),
	keybindings?: KeybindingsManager,
	onUIPrompt?: (event: UIPromptStartEvent | UIPromptEndEvent | undefined) => void,
): () => void {
	if (!(runtime instanceof IsolatedInteractiveRuntime)) return () => {};
	const disposeDiagnostic = runtime.onDiagnostic(onDiagnostic);
	const disposeUIPrompts = runtime.onEngineMessage((message) => {
		if (message.type === "engine_ui_prompt") onUIPrompt?.(message.event);
		// The footer paints the engine's panel counts, which the runtime has already mirrored. They can change
		// with no panel widget mounted (only shells running), so a widget's repaint cannot be relied on.
		else if (message.type === "engine_agent_panel_state") ui.requestRender();
	});
	const disposePromptGeneration = runtime.onGenerationEnded(() => onUIPrompt?.(undefined));
	// Generation-owned: RPC dialogs mount real host components and must not
	// outlive, or answer through, a replacement engine child.
	const dialogs = new EngineDialogHostController(runtime, ui);
	let shortcuts: EngineExtensionShortcut[] = [];
	const dispatchShortcut = (data: string): boolean => {
		const shortcut = shortcuts.find(
			({ key, editorKeys }) =>
				matchesKey(data, key as KeyId) && !editorKeys?.some((editorKey) => matchesKey(data, editorKey)),
		);
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
	const remoteComponents = new RemoteComponentController(runtime, ui, tuiRendererLifecycle);
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
		disposeUIPrompts();
		disposePromptGeneration();
		onUIPrompt?.(undefined);
		disposeOwnership();
		remoteComponents.dispose();
		sessionPicker.dispose();
		inputForm.dispose();
		dialogs.dispose();
		disposeDiagnostic();
	};
}

/** Route host-owned trust waits to the runner that actually owns the subscribers. */
export function withHostProjectTrustPrompt<T>(
	runtime: AgentSessionRuntime,
	kind: "select" | "confirm" | "input",
	title: string,
	run: () => Promise<T>,
): Promise<T> {
	return runtime instanceof IsolatedInteractiveRuntime
		? runtime.withProjectTrustPrompt(kind, title, run)
		: runtime.session.extensionRunner.withProjectTrustPrompt(kind, title, run);
}

export async function waitForInteractiveEngineBound(
	runtime: AgentSessionRuntime,
	preview?: (lines: string[]) => void,
): Promise<void> {
	if (!(runtime instanceof IsolatedInteractiveRuntime)) return;
	await runtime.waitUntilBound();
	await runtime.initializeFromEngine(undefined, preview);
}

export async function waitForInteractiveEngineProjectTrust(runtime: AgentSessionRuntime): Promise<void> {
	if (!(runtime instanceof IsolatedInteractiveRuntime)) return;
	await runtime.waitUntilProjectTrustSettled();
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

/**
 * Clear the engine child's queue and return exactly the messages it removed. The host's copy of that queue lags
 * the engine by a round trip, so a host that restores the queue to its editor restores this answer rather than
 * its copy (#4257). Returns `undefined` for a session that runs in this process, whose `clearQueue()` is exact.
 */
export function clearInteractiveEngineQueue(runtime: AgentSessionRuntime): Promise<ClearedQueue> | undefined {
	return runtime instanceof IsolatedInteractiveRuntime ? runtime.clearEngineQueue() : undefined;
}

export function getInteractiveEngineResourceOverlaps(runtime: AgentSessionRuntime): readonly ResourceOverlap[] {
	return runtime instanceof IsolatedInteractiveRuntime ? runtime.getResourceOverlaps() : [];
}

export function getInteractiveEngineResourceExtensions(runtime: AgentSessionRuntime): readonly RpcResourceExtension[] {
	return runtime instanceof IsolatedInteractiveRuntime ? runtime.getResourceExtensions() : [];
}

/** The interactive engine's extension load errors and warnings; empty for a session that runs in this process. */
export function getInteractiveEngineResourceIssues(runtime: AgentSessionRuntime): EngineResourceIssues {
	return runtime instanceof IsolatedInteractiveRuntime ? runtime.getResourceIssues() : { errors: [], warnings: [] };
}

export function onInteractiveEngineResourceExtensionsChanged(
	runtime: AgentSessionRuntime,
	listener: (extensions: readonly RpcResourceExtension[], forNextView?: true) => void,
): () => void {
	return runtime instanceof IsolatedInteractiveRuntime ? runtime.onResourceExtensionsChanged(listener) : () => {};
}

/** Called when the isolated host's trust for its session, or whether its engine has decided it, changes. */
export function onInteractiveEngineProjectTrustChanged(
	runtime: AgentSessionRuntime,
	listener: (resourcesChanged: boolean) => void,
): () => void {
	return runtime instanceof IsolatedInteractiveRuntime ? runtime.onProjectTrustChanged(listener) : () => {};
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
	listener: (commands: readonly RpcSlashCommand[], forNextView?: true) => void,
): () => void {
	return runtime instanceof IsolatedInteractiveRuntime ? runtime.onRemoteCommandsChanged(listener) : () => {};
}

/** Subscribe to fresh engine session stats, so the footer can repaint. No-op when not isolated. */
export function onInteractiveEngineSessionStatsChanged(runtime: AgentSessionRuntime, listener: () => void): () => void {
	return runtime instanceof IsolatedInteractiveRuntime ? runtime.onSessionStatsChanged(listener) : () => {};
}
