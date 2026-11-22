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

interface InteractiveEngineStartOptions {
	createRuntime: CreateAgentSessionRuntimeFactory;
	parsed: Args;
	sessionManager: SessionManager;
	resources: InteractiveEngineResourcePaths;
	startupExtensionCheck?: StartupExtensionCheck;
}

/** An engine child started before the host's own runtime exists. */
interface StartedInteractiveEngine {
	/** The host's runtime exists: it takes the engine, and what the engine wrote meanwhile reaches it. */
	attach(localRuntime: AgentSessionRuntime): IsolatedInteractiveRuntime;
	/** The host's runtime will never exist: stop the engine. */
	abandon(): Promise<void>;
}

/**
 * Start the engine child. With `holdOutput`, what it writes waits until the runtime attaches, so that nothing it says
 * reaches the client before the runtime's listeners do.
 */
function startInteractiveEngine(options: InteractiveEngineStartOptions, holdOutput: boolean): StartedInteractiveEngine {
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
	const releaseOutput = holdOutput ? client.holdChildOutput() : undefined;
	const started = client.start();
	// Observed from the start: the runtime handles how the start ends once it attaches.
	started.catch(() => {});
	return {
		attach(localRuntime) {
			// The host paints and takes input while the engine child loads: its readiness gates only what needs the engine.
			isolatedRuntime = new IsolatedInteractiveRuntime(localRuntime, options.createRuntime, client, started);
			isolatedRuntime.setEngineCallbackActive(callbackActive);
			for (const diagnostic of pendingDiagnostics) isolatedRuntime.emitDiagnostic(diagnostic);
			releaseOutput?.();
			return isolatedRuntime;
		},
		async abandon() {
			await client.stop().catch(() => {});
		},
	};
}

export async function createIsolatedInteractiveRuntime(
	options: InteractiveEngineStartOptions & { localRuntime: AgentSessionRuntime },
): Promise<IsolatedInteractiveRuntime> {
	return startInteractiveEngine(options, false).attach(options.localRuntime);
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
	/**
	 * Settles once the host's runtime creation has done everything that decides what its engine is started with and
	 * finds in the session: the engine then starts while the host creates the rest of its own runtime. Until then, or
	 * without it, the engine starts once the host's runtime exists.
	 */
	engineInputsFinal?: Promise<void>,
): Promise<AgentSessionRuntime> {
	isolateInteractiveHost &&= canIsolateSessionStore(sessionManager.getSessionStore());
	if (isolateInteractiveHost && hasInlineExtensionFactories) {
		throw new Error(
			"Interactive engine isolation cannot serialize inline extension factories; load the extension from a module path instead.",
		);
	}
	// A host that starts no engine has no use for one started while it loaded.
	if (!isolateInteractiveHost) {
		discardPrewarmedEngine();
		return createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager, interactive });
	}
	const creating = createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager, interactive });
	const startsEarly =
		engineInputsFinal !== undefined &&
		(await Promise.race([
			engineInputsFinal.then(() => true),
			creating.then(
				() => false,
				() => false,
			),
		]));
	const engineOptions = async (): Promise<InteractiveEngineStartOptions> => ({
		createRuntime,
		parsed,
		sessionManager,
		resources,
		startupExtensionCheck: await startupExtensionCheck?.(),
	});
	// Options that cannot be read now are read again, as before, once the host's runtime exists.
	const earlyOptions = startsEarly ? await engineOptions().catch(() => undefined) : undefined;
	const early = earlyOptions ? startInteractiveEngine(earlyOptions, true) : undefined;
	let localRuntime: AgentSessionRuntime;
	try {
		localRuntime = await creating;
	} catch (error) {
		await early?.abandon();
		throw error;
	}
	return (early ?? startInteractiveEngine(await engineOptions(), false)).attach(localRuntime);
}
