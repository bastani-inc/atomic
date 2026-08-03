import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ReadonlySessionManager } from "../session-manager.ts";

const SESSION_ENVIRONMENT_KEYS = [
	"ATOMIC_SESSION_ID",
	"ATOMIC_SESSION_FILE",
	"ATOMIC_PROVIDER",
	"ATOMIC_MODEL",
	"ATOMIC_REASONING_LEVEL",
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
] as const;

export interface BashSessionContext {
	sessionManager: ReadonlySessionManager;
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
}

/** Capture one internally consistent session snapshot at command execution time. */
export function snapshotBashSessionEnvironment(
	context: BashSessionContext | undefined,
	exposeSessionEnvironment: boolean,
): NodeJS.ProcessEnv {
	if (!exposeSessionEnvironment || !context?.sessionManager) return {};
	const sessionId = context.sessionManager.getSessionId();
	const sessionFile = context.sessionManager.getSessionFile();
	const model = context.model;
	const thinkingLevel = context.thinkingLevel;
	return {
		ATOMIC_SESSION_ID: sessionId,
		PI_SESSION_ID: sessionId,
		...(sessionFile ? { ATOMIC_SESSION_FILE: sessionFile, PI_SESSION_FILE: sessionFile } : {}),
		...(model
			? {
					ATOMIC_PROVIDER: model.provider,
					PI_PROVIDER: model.provider,
					ATOMIC_MODEL: model.id,
					PI_MODEL: model.id,
				}
			: {}),
		...(thinkingLevel
			? {
					ATOMIC_REASONING_LEVEL: thinkingLevel,
					PI_REASONING_LEVEL: thinkingLevel,
				}
			: {}),
	};
}

/** Overlay named session metadata while preserving every unrelated caller variable verbatim. */
export function applyBashSessionEnvironment(env: NodeJS.ProcessEnv, snapshot: NodeJS.ProcessEnv): void {
	for (const key of SESSION_ENVIRONMENT_KEYS) delete env[key];
	Object.assign(env, snapshot);
}
