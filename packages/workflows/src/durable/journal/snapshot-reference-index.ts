import type { SnapshotIndexTables, SqliteDatabase } from "@bastani/atomic/storage";
import { JOURNAL_TRANSACTION } from "./internal.js";
import { JOURNAL_COLUMNS as c, RUN_EVENT_TYPES } from "./types.js";

type JournalTables = { readonly runs: string; readonly events: string };

/** The `seq` of a run state taken from the run's header status, which any start or status event replaces. */
const HEADER_SEQ = -1;

/**
 * The SQL form of `isDurableWorkflowResumable` for the status payload `p`, given that the run has a snapshot reference
 * and so at least one checkpoint: a root run keeps its snapshots while it is failed or blocked, or running or paused,
 * unless it was marked not resumable.
 */
function retainedByStatus(p: string): string {
	const root = `json_type(${p}, '$.rootWorkflowId')`;
	return `CASE
		WHEN ${root} IS NOT NULL AND (${root} <> 'text' OR json_extract(${p}, '$.rootWorkflowId') <> json_extract(${p}, '$.workflowId')) THEN 0
		WHEN json_extract(${p}, '$.status') IN ('failed', 'blocked', 'running', 'paused') THEN json_type(${p}, '$.resumable') IS NOT 'false'
		ELSE 0
	END`;
}

/**
 * Triggers that keep the snapshot reference index current with every write to the journal, from any connection and
 * every write path (single and batched appends, pooled checkpoints, legacy conversion): a tool or stage checkpoint
 * adds the blobs of each snapshot it carries to its run's references, the latest well-formed start or status event by
 * sequence decides whether the run keeps them, the run's header status decides until one exists, and deleting the run
 * removes both.
 */
export async function indexJournalSnapshotReferences(
	database: SqliteDatabase,
	journal: JournalTables,
	t: SnapshotIndexTables,
): Promise<void> {
	const refs = `${journal.events}_snapshot_refs`;
	if (await database.get("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = ?", refs)) return;
	const p = `NEW.${c.payload}`;
	const keptByHeader = `NEW.${c.status} NOT IN ('completed', 'cancelled')`;
	await database.transaction(
		(tx) =>
			tx.exec(`
				CREATE TRIGGER IF NOT EXISTS ${refs} AFTER INSERT ON ${journal.events}
				WHEN NEW.${c.type} = '${RUN_EVENT_TYPES.checkpointRecorded}' AND instr(${p}, '"worktreeSnapshots"') > 0
					AND json_valid(${p}) AND json_extract(${p}, '$.kind') IN ('tool', 'stage')
				BEGIN
					INSERT OR IGNORE INTO ${t.runRefs} (run_id, hash)
					SELECT NEW.${c.runId}, hash FROM (
						SELECT json_extract(${p}, link.fullkey || '.patch') AS hash
						FROM json_each(${p}, '$.worktreeSnapshots') AS snapshot, json_each(${p}, snapshot.fullkey || '.chain') AS link
						UNION ALL
						SELECT json_extract(${p}, snapshot.fullkey || '.bundle.blob') FROM json_each(${p}, '$.worktreeSnapshots') AS snapshot
					) WHERE typeof(hash) = 'text';
				END;
				CREATE TRIGGER IF NOT EXISTS ${journal.events}_snapshot_state AFTER INSERT ON ${journal.events}
				WHEN NEW.${c.type} IN ('${RUN_EVENT_TYPES.runStarted}', '${RUN_EVENT_TYPES.statusChanged}') AND json_valid(${p})
					AND json_type(${p}, '$.workflowId') = 'text' AND json_type(${p}, '$.status') = 'text'
					AND json_type(${p}, '$.completedCheckpoints') IN ('integer', 'real')
					AND json_type(${p}, '$.pendingPrompts') IN ('integer', 'real')
				BEGIN
					INSERT INTO ${t.runState} (run_id, retained, seq) VALUES (NEW.${c.runId}, ${retainedByStatus(p)}, NEW.${c.seq})
					ON CONFLICT (run_id) DO UPDATE SET retained = excluded.retained, seq = excluded.seq
					WHERE excluded.seq >= ${t.runState}.seq;
				END;
				CREATE TRIGGER IF NOT EXISTS ${journal.runs}_snapshot_state_insert AFTER INSERT ON ${journal.runs}
				BEGIN
					INSERT INTO ${t.runState} (run_id, retained, seq) VALUES (NEW.${c.runId}, ${keptByHeader}, ${HEADER_SEQ})
					ON CONFLICT (run_id) DO NOTHING;
				END;
				CREATE TRIGGER IF NOT EXISTS ${journal.runs}_snapshot_state_status AFTER UPDATE OF ${c.status} ON ${journal.runs}
				BEGIN
					UPDATE ${t.runState} SET retained = ${keptByHeader} WHERE run_id = NEW.${c.runId} AND seq = ${HEADER_SEQ};
				END;
				CREATE TRIGGER IF NOT EXISTS ${journal.runs}_snapshot_refs_delete AFTER DELETE ON ${journal.runs}
				BEGIN
					DELETE FROM ${t.runRefs} WHERE run_id = OLD.${c.runId};
					DELETE FROM ${t.runState} WHERE run_id = OLD.${c.runId};
				END;
			`),
		JOURNAL_TRANSACTION,
	);
}
