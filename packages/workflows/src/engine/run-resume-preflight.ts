import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { JsonlSessionStore, resolveSessionStore, type SessionStore } from "@bastani/atomic";
import type { DurableWaitingStage } from "../durable/stage-primitive.js";
import type { StageAdapters } from "../runs/foreground/stage-runner-types.js";
import { StageRehydrationError } from "../shared/stage-wait-errors.js";

/** The session storage a run's stages reopen from, as the run was started. */
export interface ResumeSessionStorage {
	readonly adapters?: Pick<StageAdapters, "sessionStore">;
	readonly defaultSessionDir?: string;
	readonly cwd?: string;
}

/** File-backed adapters name their location; any other adapter is named by kind only, so no URL or secret leaks. */
function describeStore(store: SessionStore, selectedBy: string): string {
	const { adapter, location } = store.descriptor;
	const fileBacked = adapter === "jsonl" || adapter === "sqlite";
	return `${selectedBy}: ${adapter}${fileBacked && location !== "" ? ` ${location}` : ""}`;
}

async function openRunSessionStore(
	storage: ResumeSessionStorage,
): Promise<{ readonly store: SessionStore; readonly storage: string; readonly owned: boolean }> {
	const callerStore = storage.adapters?.sessionStore;
	if (callerStore !== undefined)
		return { store: callerStore, storage: describeStore(callerStore, "SDK sessionStore option"), owned: false };
	if (storage.defaultSessionDir !== undefined) {
		const store = await JsonlSessionStore.open(storage.defaultSessionDir, {
			exactDirectory: true,
			scanExisting: false,
		});
		return { store, storage: describeStore(store, "session directory"), owned: true };
	}
	const store = await resolveSessionStore(storage.cwd ?? process.cwd());
	return { store, storage: describeStore(store, "configured session storage"), owned: true };
}

/**
 * Before a durable resume takes its run's lease, check that every stage its previous process left waiting (found by
 * `durableWaitingStages`, one pass over the run's records) can reopen its session: one header read per session, with
 * no write. Every missing session is reported together, in a non-retryable `StageRehydrationError`
 * (`session-not-found`) whose hint names the storage the run was started with. A session a stage kept in its own
 * file-backed directory is found by its file.
 */
export async function assertWaitingStageSessionsExist(
	waiting: readonly DurableWaitingStage[],
	runId: string,
	storage: ResumeSessionStorage,
): Promise<void> {
	const opened = await openRunSessionStore(storage);
	try {
		const missing: string[] = [];
		const checked = new Set<string>();
		for (const stage of waiting) {
			if (checked.has(stage.sessionId)) continue;
			checked.add(stage.sessionId);
			if ((await opened.store.readHeader(stage.sessionId)) !== undefined) continue;
			if (stage.sessionFile !== undefined && isAbsolute(stage.sessionFile) && existsSync(stage.sessionFile))
				continue;
			missing.push(stage.sessionId);
		}
		if (missing.length > 0)
			throw new StageRehydrationError(
				{ runId, sessionIds: missing, storage: opened.storage },
				{ code: "session-not-found" },
			);
	} finally {
		if (opened.owned) await opened.store.close();
	}
}
