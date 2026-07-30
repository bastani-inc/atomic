import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";

/**
 * Host-local answer to "which engine-owned proxy owns input right now?".
 *
 * Ctrl+C has to be able to reach the host whenever a remote `ctx.ui.custom()`
 * component holds input, even while the engine is perfectly healthy: a component
 * that never resolves otherwise traps every key. Visual modal state cannot
 * answer this — a native selector, a host input form, a session picker, and an
 * unrelated native overlay all look identical from the outside — so the remote
 * component controller reports its own mounts here instead.
 *
 * The identity, rather than a boolean, lets the route give the first Ctrl+C to
 * the component (extension UIs bind it for their own Skip/Close) and escalate
 * only when the very same component is still holding input on the next press.
 */
export interface RemoteProxyOwnershipSource {
	/** The remote overlay proxy that currently holds focus, if any. */
	focusedRemoteOverlay(): unknown;
	/** `component` itself when it is a live non-widget remote proxy, else undefined. */
	remoteProxyOwner(component: unknown): unknown;
}

export interface HostInputOwnership {
	hasOverlay(): boolean;
	/** Components currently mounted where the editor normally lives. */
	inlineComponents(): readonly unknown[];
}

const sources = new WeakMap<AgentSessionRuntime, RemoteProxyOwnershipSource>();

export function registerRemoteProxyOwnership(
	runtime: AgentSessionRuntime,
	source: RemoteProxyOwnershipSource,
): () => void {
	sources.set(runtime, source);
	return () => {
		if (sources.get(runtime) === source) sources.delete(runtime);
	};
}

/**
 * The engine-owned remote proxy that would receive the next keypress, if any.
 *
 * A focused remote overlay wins outright. Otherwise any visible overlay owns
 * input, and since no remote overlay is focused it must be a native one, which
 * keeps its own Ctrl+C-as-cancel. With no overlay, ownership comes down to
 * whether the component sitting in the editor's place is a remote proxy;
 * widgets never own keyboard input and never appear there.
 */
export function remoteEngineProxyOwner(
	runtime: AgentSessionRuntime,
	host: HostInputOwnership,
): unknown {
	const source = sources.get(runtime);
	if (!source) return undefined;
	const overlay = source.focusedRemoteOverlay();
	if (overlay !== undefined) return overlay;
	if (host.hasOverlay()) return undefined;
	for (const component of host.inlineComponents()) {
		const owner = source.remoteProxyOwner(component);
		if (owner !== undefined) return owner;
	}
	return undefined;
}
