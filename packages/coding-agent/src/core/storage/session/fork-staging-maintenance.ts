import type { SqliteDatabase } from "../database.js";
import type { StorageDialect } from "../dialect.js";

/** Rows removed in one transaction, including an idle-only pass at open. */
export const FORK_STAGING_CLEANUP_ROWS = 32;
export const FORK_STAGING_LEASE_KIND = 0;

/** Never load the clone writer in an ordinary open. Fence a lapsed transfer before deleting so a paused donor
 * cannot publish a partially swept transfer. When more rows remain, the new token stays expired. */
export async function tryCleanupForkStaging(database: SqliteDatabase, dialect: StorageDialect, table: string) {
	if (!database.tryMaintenance) return;
	const lease = FORK_STAGING_LEASE_KIND;
	const lapsed = `SELECT transfer_id FROM ${table} WHERE kind=${lease} AND size<${dialect.nowMs} LIMIT 1`;
	if (!(await database.get(lapsed))) return;
	await database.tryMaintenance(async (tx) => {
		const expired = await tx.get(lapsed);
		if (!expired) return;
		const id = String(expired.transfer_id);
		await tx.run(`UPDATE ${table} SET body=?,size=0 WHERE transfer_id=? AND kind=${lease}`, crypto.randomUUID(), id);
		const removed = await tx.run(
			`DELETE FROM ${table} WHERE transfer_id=? AND kind>${lease} AND (kind,seq,idx) IN (SELECT kind,seq,idx FROM ${table} WHERE transfer_id=? AND kind>${lease} LIMIT ?)`,
			id,
			id,
			FORK_STAGING_CLEANUP_ROWS,
		);
		if (removed.changes < FORK_STAGING_CLEANUP_ROWS)
			await tx.run(`DELETE FROM ${table} WHERE transfer_id=? AND kind=${lease}`, id);
	});
}
