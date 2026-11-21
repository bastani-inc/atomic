import type { Args } from "../../cli/args.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import type { StartupExtensionCheck } from "../../core/project-trust-state.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import { canIsolateSessionStore } from "../../core/session-storage.js";
import { RpcClient } from "../rpc/rpc-client.ts";
import type { ActivityWatchdogDiagnostic } from "./activity-watchdog.ts";
import { buildInteractiveEngineArgs, type InteractiveEngineResourcePaths } from "./engine-args.ts";
import { discardPrewarmedEngine, interactiveEngineClientOptions } from "./engine-prewarm.ts";
import { IsolatedInteractiveRuntime } from "./isolated-runtime.js";

export async function createIsolatedInteractiveRuntime(options: {
	localRuntime: AgentSessionRuntime;
	createRuntime: CreateAgentSessionRuntimeFactory;
	parsed: Args;
	sessionManager: SessionManager;
	resources: InteractiveEngineResourcePaths;
	startupExtensionCheck?: StartupExtensionCheck;
}): Promise<IsolatedInteractiveRuntime> {
	let isolatedRuntime: IsolatedInteractiveRuntime | undefined;
	const pendingDiagnostics: ActivityWatchdogDiagnostic[] = [];
	let callbackActive = false;
	const client = new RpcClient({
		...interactiveEngineClientOptions(options.sessionManager.getCwd()),
		args: buildInteractiveEngineArgs(options.parsed, options.sessionManager, options.resources),
		interactiveEngine: {
			onDiagnostic: (diagnostic) =>
				isolatedRuntime ? isolatedRuntime.emitDiagnostic(diagnostic) : pendingDiagnostics.push(diagnostic),
			onActivityChange: (active) => {
				callbackActive = active;
				isolatedRuntime?.setEngineCallbackActive(active);
			},
			onHeartbeat: () => isolatedRuntime?.noteEngineHeartbeat(),
			// Handed to the child through the protected bootstrap file so it never
			// enters an environment the child's own subprocesses can inherit.
			...(options.parsed.apiKey ? { apiKey: options.parsed.apiKey } : {}),
			...(options.sessionManager.isPersisted() && options.sessionManager.startedSession()
				? { startedSessionId: options.sessionManager.getSessionId() }
				: {}),
			...(options.startupExtensionCheck ? { startupExtensionCheck: options.startupExtensionCheck } : {}),
		},
	});
	// The host paints and takes input while the engine child loads: its readiness gates only what needs the engine.
	isolatedRuntime = new IsolatedInteractiveRuntime(
		options.localRuntime,
		options.createRuntime,
		client,
		client.start(),
	);
	isolatedRuntime.setEngineCallbackActive(callbackActive);
	for (const diagnostic of pendingDiagnostics) isolatedRuntime.emitDiagnostic(diagnostic);
	return isolatedRuntime;
}

export async function createRuntimeForMode(
	createRuntime: CreateAgentSessionRuntimeFactory,
	cwd: string,
	agentDir: string,
	sessionManager: SessionManager,
	isolateInteractiveHost: boolean,
	hasInlineExtensionFactories: boolean,
	parsed: Args,
	resources: InteractiveEngineResourcePaths,
	interactive: boolean,
	/** What the host's startup found when it checked its extensions, once its own runtime exists (see main.ts). */
	startupExtensionCheck?: () => Promise<StartupExtensionCheck | undefined>,
): Promise<AgentSessionRuntime> {
	isolateInteractiveHost &&= canIsolateSessionStore(sessionManager.getSessionStore());
	if (isolateInteractiveHost && hasInlineExtensionFactories) {
		throw new Error(
			"Interactive engine isolation cannot serialize inline extension factories; load the extension from a module path instead.",
		);
	}
	// A host that starts no engine has no use for one started while it loaded.
	if (!isolateInteractiveHost) discardPrewarmedEngine();
	const localRuntime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager, interactive });
	if (!isolateInteractiveHost) return localRuntime;
	return createIsolatedInteractiveRuntime({
		localRuntime,
		createRuntime,
		parsed,
		sessionManager,
		resources,
		startupExtensionCheck: await startupExtensionCheck?.(),
	});
}
