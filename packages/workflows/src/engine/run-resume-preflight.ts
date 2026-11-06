import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { JsonlSessionStore, resolveSessionStore, type SessionStore } from "@bastani/atomic";
import type { DurableWaitingStage } from "../durable/stage-primitive.js";
import type { StageAdapters } from "../runs/foreground/stage-runner-types.js";
import { isStageRehydrationError, StageRehydrationError } from "../shared/stage-wait-errors.js";

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
	callerStoreLabel: string,
): Promise<{ readonly store: SessionStore; readonly storage: string; readonly owned: boolean }> {
	const callerStore = storage.adapters?.sessionStore;
	if (callerStore !== undefined)
		return { store: callerStore, storage: describeStore(callerStore, callerStoreLabel), owned: false };
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
 * file-backed directory is found by its file. A stage that kept its session in the store its own `sessionStore`
 * option supplied is not looked up here: that store is known only once the workflow calls the stage again, and
 * {@link assertStageOwnedSessionExists} checks it then, before the stage does any work.
 *
 * A child run (`rootRunId` given) is checked the same way before its body runs, in the store its parent or its worker
 * pool hands it; the error then names the root run to resume (#4440).
 */
export async function assertWaitingStageSessionsExist(
	waiting: readonly DurableWaitingStage[],
	runId: string,
	storage: ResumeSessionStorage,
	rootRunId?: string,
): Promise<void> {
	const inRunStore = waiting.filter((stage) => stage.sessionStorage !== "stage");
	if (inRunStore.length === 0) return;
	const opened = await openRunSessionStore(
		storage,
		rootRunId === undefined ? "SDK sessionStore option" : "child workflow session store",
	);
	try {
		const missing: string[] = [];
		const checked = new Set<string>();
		for (const stage of inRunStore) {
			if (checked.has(stage.sessionId)) continue;
			checked.add(stage.sessionId);
			if ((await opened.store.readHeader(stage.sessionId)) !== undefined) continue;
			if (stage.sessionFile !== undefined && isAbsolute(stage.sessionFile) && existsSync(stage.sessionFile))
				continue;
			missing.push(stage.sessionId);
		}
		if (missing.length > 0)
			throw new StageRehydrationError(
				{ runId, ...(rootRunId === undefined ? {} : { rootRunId }), sessionIds: missing, storage: opened.storage },
				{ code: "session-not-found" },
			);
	} finally {
		if (opened.owned) await opened.store.close();
	}
}

/**
 * Whether a child's recorded result is the refusal of the check it makes when it starts (#4440). A worker pool keeps
 * that refusal as the child's outcome for the rest of its root's incarnation, so the pool never retries the child on
 * its own, and runs the child again when a later incarnation of the root asks for it, so a resume with the storage
 * the error names checks the sessions again instead of replaying the refusal.
 */
export function refusedAtChildStart(result: { readonly failureDetail?: unknown }): boolean {
	const detail = result.failureDetail;
	return (
		isStageRehydrationError(detail) &&
		detail.code === "session-not-found" &&
		typeof detail.fields?.rootRunId === "string"
	);
}

/** The stage a resume checks in the store its own `sessionStore` option supplies. */
export interface StageOwnedSession {
	readonly runId: string;
	readonly stageName: string;
	readonly stageId?: string;
	readonly sessionId: string;
}

/**
 * Before a resumed stage that kept its session in its own `sessionStore` does any work, check that the store the
 * workflow passes it now holds that session: one header read, with no write. A store that does not, or a call that
 * no longer passes a store, fails with a non-retryable `StageRehydrationError` (`session-not-found`) naming the
 * stage, instead of the stage starting over in a new session.
 */
export async function assertStageOwnedSessionExists(
	store: SessionStore | undefined,
	stage: StageOwnedSession,
): Promise<void> {
	if (store !== undefined && (await store.readHeader(stage.sessionId)) !== undefined) return;
	throw new StageRehydrationError(
		{
			runId: stage.runId,
			stageName: stage.stageName,
			...(stage.stageId === undefined ? {} : { stageId: stage.stageId }),
			sessionIds: [stage.sessionId],
			storage:
				store === undefined
					? "stage sessionStore option: not passed to the resumed stage"
					: describeStore(store, "stage sessionStore option"),
		},
		{ code: "session-not-found" },
	);
}
