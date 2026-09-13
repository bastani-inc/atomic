import type { AgentSession } from "@bastani/atomic";
import type { StageSessionCreateResult, StageSessionRuntime } from "./stage-runner-types.js";

type StageSessionExtensionRunner = {
	hasHandlers(eventType: string): boolean;
	emit(event: { readonly type: "session_shutdown"; readonly reason: "quit" }): Promise<unknown>;
};

function stageSessionExtensionRunner(current: StageSessionRuntime): StageSessionExtensionRunner | undefined {
	const runner = (current as StageSessionRuntime & { extensionRunner?: StageSessionExtensionRunner }).extensionRunner;
	if (runner && typeof runner.hasHandlers === "function" && typeof runner.emit === "function") {
		return runner;
	}
	return undefined;
}

const shutdowns = new WeakMap<StageSessionRuntime, Promise<void>>();

/** Release extension ownership before a fallback binds, retaining queued deliveries until transfer. */
export function shutdownStageSession(current: StageSessionRuntime | undefined): Promise<void> {
	if (!current) return Promise.resolve();
	const existing = shutdowns.get(current);
	if (existing) return existing;
	const shutdown = Promise.resolve().then(async () => {
		const runner = stageSessionExtensionRunner(current);
		if (runner?.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
	});
	shutdowns.set(current, shutdown);
	return shutdown;
}

export async function disposeStageSession(current: StageSessionRuntime | undefined): Promise<void> {
	if (!current) return;
	try {
		await shutdownStageSession(current);
	} catch (error) {
		console.error("atomic-workflows: stage session_shutdown handler failed", error);
	}
	await current.dispose();
}

export function asAgentSession(activeSession: StageSessionRuntime | undefined): AgentSession | undefined {
	if (!activeSession) return undefined;
	const candidate = activeSession as StageSessionRuntime &
		Partial<Pick<AgentSession, "state" | "sessionManager" | "modelRuntime" | "getContextUsage">>;
	if (
		candidate.state !== undefined &&
		candidate.sessionManager !== undefined &&
		candidate.modelRuntime !== undefined &&
		typeof candidate.getContextUsage === "function"
	) {
		return candidate as AgentSession;
	}
	return undefined;
}

export function normalizeSessionCreateResult(
	created: StageSessionRuntime | StageSessionCreateResult,
): StageSessionCreateResult {
	if ("session" in created) return created;
	return { session: created };
}

export function attachCreatedStageSession<T>(
	created: StageSessionRuntime | StageSessionCreateResult,
	disposed: boolean,
	stageName: string,
	attach: (result: StageSessionCreateResult) => T,
): T | Promise<never> {
	const result = normalizeSessionCreateResult(created);
	if (!disposed) return attach(result);
	return rejectDisposedCreatedSession(result, stageName);
}

async function rejectDisposedCreatedSession(result: StageSessionCreateResult, stageName: string): Promise<never> {
	await disposeStageSession(result.session);
	throw new Error(`atomic-workflows: stage "${stageName}" session has been disposed`);
}
