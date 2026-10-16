import { randomUUID } from "node:crypto";
import {
	type CreateAgentSessionOptions,
	JsonlSessionStore,
	type NewSessionOptions,
	resolveSessionStore,
	SessionManager,
	type SessionStore,
} from "@bastani/atomic";

export async function stageSessionStore(
	options: Pick<CreateAgentSessionOptions, "sessionManager" | "cwd" | "agentDir" | "settingsManager"> & {
		sessionStore?: SessionStore;
		sessionDir?: string;
	},
	defaultSessionDir?: string,
): Promise<SessionStore> {
	if (options.sessionStore !== undefined) return options.sessionStore;
	if (options.sessionManager !== undefined) return options.sessionManager.getSessionStore();
	const directory = options.sessionDir ?? defaultSessionDir;
	if (directory !== undefined) return JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
	return resolveSessionStore(options.cwd ?? process.cwd(), {
		agentDir: options.agentDir,
		settings: options.settingsManager?.getSettings(),
	});
}

export async function forkStageSession(
	store: SessionStore,
	sessionId: string,
	cwd: string,
	options: NewSessionOptions,
	destination: SessionStore = store,
): Promise<SessionManager> {
	const source = await store.load(sessionId);
	const id = randomUUID();
	await destination.create(
		{
			id,
			version: 4,
			createdAt: new Date().toISOString(),
			cwd,
			parentSessionId: sessionId,
			...(options.internal === true ? { internal: true } : {}),
			...(options.workflow === undefined ? {} : { workflow: options.workflow }),
		},
		source.entries,
	);
	return SessionManager.open(destination, id, cwd);
}
