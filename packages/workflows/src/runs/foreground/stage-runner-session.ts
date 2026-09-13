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

/** Failed binding cleanup cannot authorize another owner, regardless of model-error wording. */
export class StageSessionBindingCleanupFailure extends AggregateError {
	constructor(bindingError: unknown, cleanupErrors: readonly unknown[]) {
		super(
			[bindingError, ...cleanupErrors],
			"atomic-workflows: failed binding cleanup did not release session ownership",
			{
				cause: bindingError,
			},
		);
		this.name = "StageSessionBindingCleanupFailure";
	}
}

export async function cleanupFailedStageSessionBinding(
	current: StageSessionRuntime,
	bindingError: unknown,
): Promise<void> {
	const cleanupErrors: unknown[] = [];
	try {
		await shutdownStageSession(current);
	} catch (error) {
		cleanupErrors.push(error);
	}
	try {
		await current.dispose();
	} catch (error) {
		cleanupErrors.push(error);
	}
	if (cleanupErrors.length > 0) throw new StageSessionBindingCleanupFailure(bindingError, cleanupErrors);
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
