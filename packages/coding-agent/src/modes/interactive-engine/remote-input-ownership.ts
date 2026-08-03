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
 * The identity, rather than a boolean, lets the route ask the controller what
 * that exact mount declared: a component that binds Ctrl+C itself (the
 * workflows prompt card's `ctrl+c Skip`, the stage chat's `ctrl+c Close`) keeps
 * receiving the key, while an undeclared one is closed locally so it can never
 * trap the keyboard.
 */
export interface RemoteProxyOwnershipSource {
	/** The remote overlay proxy that currently holds focus, if any. */
	focusedRemoteOverlay(): unknown;
	/** `component` itself when it is a live non-widget remote proxy, else undefined. */
	remoteProxyOwner(component: unknown): unknown;
	/** True when the extension declared that this mount binds Ctrl+C itself. */
	remoteProxyHandlesCtrlC(component: unknown): boolean;
	/** Close exactly this proxy through the ordinary host close path. */
	dismissRemoteProxy(component: unknown): boolean;
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
export function remoteEngineProxyOwner(runtime: AgentSessionRuntime, host: HostInputOwnership): unknown {
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

/** True when the mount that owns input declared that it binds Ctrl+C itself. */
export function remoteProxyHandlesCtrlC(runtime: AgentSessionRuntime, owner: unknown): boolean {
	return sources.get(runtime)?.remoteProxyHandlesCtrlC(owner) === true;
}

/** Close exactly the remote proxy that owns input; the engine keeps running. */
export function dismissRemoteProxy(runtime: AgentSessionRuntime, owner: unknown): boolean {
	return sources.get(runtime)?.dismissRemoteProxy(owner) === true;
}
