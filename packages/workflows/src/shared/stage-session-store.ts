import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
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

/**
 * Import a stage conversation recorded before #3700 into the store it now resumes from.
 *
 * Stage checkpoints written before #3700 point at a JSONL transcript. The session
 * import at startup covers only the default session directory, so a stage whose
 * transcript lives elsewhere (for example a host `--session-dir`) would resume by an
 * ID the selected store has never seen. The transcript is read without rewriting it.
 */
export async function migrateLegacyStageSession(
	store: SessionStore,
	sessionId: string,
	sessionFile: string | undefined,
): Promise<void> {
	if (sessionFile === undefined || (await store.readHeader(sessionId)) !== undefined) return;
	const location = resolve(sessionFile);
	const legacy = await JsonlSessionStore.open(dirname(location), { exactDirectory: true, scanExisting: false });
	try {
		for await (const file of legacy.scanFiles()) {
			if (resolve(file.location) !== location || file.header.id !== sessionId) continue;
			const snapshot = await file.read();
			if ((await store.readHeader(sessionId)) === undefined) await store.create(snapshot.header, snapshot.entries);
			return;
		}
	} finally {
		await legacy.close();
	}
}
