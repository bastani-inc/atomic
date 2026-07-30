import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";

/**
 * Host-local answer to "is the focused input owner an engine-owned proxy?".
 *
 * Ctrl+C has to reach the host whenever a remote `ctx.ui.custom()` component
 * holds input, even while the engine is perfectly healthy: a component that
 * never resolves otherwise traps every key, and forwarding Ctrl+C to the engine
 * is exactly what the user is trying to escape. Visual modal state cannot answer
 * this — a native selector, a host input form, a session picker, and an
 * unrelated native overlay all look identical from the outside — so the remote
 * component controller reports its own mounts here instead.
 */
export interface RemoteProxyOwnershipSource {
	/** True when a remote overlay proxy currently holds focus. */
	hasFocusedRemoteOverlay(): boolean;
	/** True when `component` is a live remote proxy of the current generation. */
	isRemoteProxy(component: unknown): boolean;
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
 * True only when an engine-owned remote proxy is the component that would
 * receive the next keypress.
 *
 * A focused remote overlay wins outright. Otherwise any visible overlay owns
 * input, and since no remote overlay is focused it must be a native one, which
 * keeps its own Ctrl+C-as-cancel. With no overlay, ownership comes down to
 * whether the component sitting in the editor's place is a remote proxy;
 * widgets never own keyboard input and never appear there.
 */
export function remoteEngineProxyOwnsInput(
	runtime: AgentSessionRuntime,
	host: HostInputOwnership,
): boolean {
	const source = sources.get(runtime);
	if (!source) return false;
	if (source.hasFocusedRemoteOverlay()) return true;
	if (host.hasOverlay()) return false;
	return host.inlineComponents().some((component) => source.isRemoteProxy(component));
}
