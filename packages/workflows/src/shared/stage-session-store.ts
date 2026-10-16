import { randomUUID } from "node:crypto";
import {
	getDefaultSessionDirPath,
	JsonlSessionStore,
	type NewSessionOptions,
	SessionManager,
	type SessionStore,
} from "@bastani/atomic";

export async function stageSessionStore(
	options: { sessionStore?: SessionStore; sessionManager?: SessionManager; cwd?: string; sessionDir?: string },
	defaultSessionDir?: string,
): Promise<SessionStore> {
	return (
		options.sessionStore ??
		options.sessionManager?.getSessionStore() ??
		JsonlSessionStore.open(
			options.sessionDir ?? defaultSessionDir ?? getDefaultSessionDirPath(options.cwd ?? process.cwd()),
			{
				exactDirectory: true,
				scanExisting: false,
			},
		)
	);
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
