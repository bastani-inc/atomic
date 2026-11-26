import { sessionForkTables } from "../storage/session/fork-schema.js";

/**
 * The fork segments of the sessions under `prefix` (#6560): `(session_id, idx, source_id, from_seq, to_seq, base_seq)`,
 * one row per run of a session's view that another session stores. `atomic storage migrate` creates the table when it
 * turns shared-history forks on; until then no session has a segment.
 */
export function forkSegmentsTable(prefix = ""): string {
	return sessionForkTables(prefix).forkSegments;
}

/**
 * The trigger that indexes the link of each entry a session with fork segments writes. Its name carries a version, so a
 * build that installs the released session-entries triggers again, under their own names, never replaces or drops it.
 */
export function forkLinksTriggerName(entries: string): string {
	return `${entries}_fork_links_v1`;
}

/** The view seq one past a segment's last, for the segment aliased `alias`. */
const segmentEnd = (alias: string) => `${alias}.base_seq + ${alias}.to_seq - ${alias}.from_seq + 1`;

/**
 * The seq in session `child`'s view of the entry at seq `seq` of session `source`'s view, where `source` stores a row
 * `child` inherits. Segments are composed when a fork is made, so a segment's source stores the rows it names itself:
 * `seq` is either a row `source` stores, which a segment of `child` names, or a row `source` inherits, from the source
 * of one of its own segments, which a segment of `child` names by that source. An entry that `child`, or a fork
 * between `source` and `child`, stores itself, such as one a fork edited, is found by its id.
 */
function childViewSeq(links: string, segments: string, child: string, source: string, seq: string): string {
	const inheritedBy = `ss.session_id = ${source} AND ${seq} BETWEEN ss.base_seq + 1 AND ${segmentEnd("ss")}`;
	const stored = `${seq} - ss.base_seq - 1 + ss.from_seq`;
	const entryId = `COALESCE((SELECT a.entry_id FROM ${links} AS a WHERE a.session_id = ${source} AND a.seq = ${seq}), (SELECT a.entry_id FROM ${segments} AS ss JOIN ${links} AS a ON a.session_id = ss.source_id AND a.seq = ${stored} WHERE ${inheritedBy}))`;
	return `COALESCE(
		(SELECT ${seq} - cs.from_seq + cs.base_seq + 1 FROM ${segments} AS cs WHERE cs.session_id = ${child} AND cs.source_id = ${source} AND ${seq} BETWEEN cs.from_seq AND cs.to_seq),
		(SELECT ${stored} - cs.from_seq + cs.base_seq + 1 FROM ${segments} AS ss JOIN ${segments} AS cs ON cs.session_id = ${child} AND cs.source_id = ss.source_id AND ${stored} BETWEEN cs.from_seq AND cs.to_seq WHERE ${inheritedBy}),
		(SELECT own.seq FROM ${links} AS own WHERE own.session_id = ${child} AND own.entry_id = ${entryId} ORDER BY own.seq LIMIT 1),
		(SELECT x.seq - cs.from_seq + cs.base_seq + 1 FROM ${segments} AS cs JOIN ${links} AS x ON x.session_id = cs.source_id AND x.entry_id = ${entryId} AND x.seq BETWEEN cs.from_seq AND cs.to_seq WHERE cs.session_id = ${child} ORDER BY cs.base_seq, x.seq LIMIT 1)
	)`;
}

/**
 * The statement that indexes the link of one entry of a session with fork segments, as a copy of the session would
 * have it. `rows` yields that entry as `r`, with its parent's id and JSON type as `parent_id` and `parent_type`;
 * `isSnapshot` tells whether `r` is a snapshot entry.
 *
 * The released link statement finds an entry's parent only among the links the session stores, so it marks an entry
 * whose parent the session inherits broken, without an anchor. This one also finds the parent among the links of the
 * rows the session's segments name, and takes the parent's anchor in the session's view. An entry whose id an entry
 * the session inherits also has is broken, as in a copy. It counts the children an entry written below the session's
 * last row already has, as when a fork's inherited rows are copied into it. It writes over the released statement's
 * row, so it ends the same whichever of the two runs first.
 *
 * The snapshot references of such an entry stay as the released statements index them: a reference's `prev_seq` that
 * would name an inherited entry is empty. Collection walks a session's references only through the rows the session
 * stores, and keeps every snapshot record a segment names (see `SqlSnapshotBlobStore.sweep`), so it never needs it.
 */
export function forkSessionLink(links: string, segments: string, rows: string, isSnapshot: string): string {
	const own = (column: string) =>
		`(SELECT p.${column} FROM ${links} AS p WHERE p.session_id = r.session_id AND p.entry_id = r.parent_id AND r.parent_type = 'text' ORDER BY p.seq LIMIT 1)`;
	const ownParent = `EXISTS (SELECT 1 FROM ${links} AS p WHERE p.session_id = r.session_id AND p.entry_id = r.parent_id AND r.parent_type = 'text')`;
	const inherited = (select: string) =>
		`(SELECT ${select} FROM ${segments} AS seg JOIN ${links} AS up ON up.session_id = seg.source_id AND up.entry_id = r.parent_id AND up.seq BETWEEN seg.from_seq AND seg.to_seq WHERE seg.session_id = r.session_id AND r.parent_type = 'text' ORDER BY seg.base_seq, up.seq LIMIT 1)`;
	const anchor = `CASE WHEN up.anchor_seq IS NOT NULL THEN ${childViewSeq(links, segments, "r.session_id", "up.session_id", "up.anchor_seq")} END`;
	const duplicate = `EXISTS (SELECT 1 FROM ${links} AS other WHERE other.session_id = r.session_id AND other.entry_id = r.entry_id AND other.seq <> r.seq) OR EXISTS (SELECT 1 FROM ${segments} AS seg JOIN ${links} AS other ON other.session_id = seg.source_id AND other.entry_id = r.entry_id AND other.seq BETWEEN seg.from_seq AND seg.to_seq WHERE seg.session_id = r.session_id)`;
	const children = `CASE WHEN EXISTS (SELECT 1 FROM ${links} AS later WHERE later.session_id = r.session_id AND later.seq > r.seq) THEN (SELECT count(*) FROM ${links} AS c WHERE c.session_id = r.session_id AND c.parent_id = r.entry_id AND c.seq <> r.seq) ELSE 0 END`;
	return `INSERT INTO ${links} (session_id, seq, entry_id, parent_id, anchor_seq, children, broken)
		SELECT r.session_id, r.seq, r.entry_id, CASE WHEN r.parent_type = 'text' THEN r.parent_id END,
			CASE WHEN ${isSnapshot} THEN r.seq WHEN ${ownParent} THEN ${own("anchor_seq")} ELSE ${inherited(anchor)} END,
			${children},
			CASE WHEN ${duplicate} THEN 1 WHEN r.parent_type IS NULL OR r.parent_type = 'null' THEN 0 WHEN ${ownParent} THEN ${own("broken")} ELSE COALESCE(${inherited("up.broken")}, 1) END
		FROM ${rows} AS r WHERE EXISTS (SELECT 1 FROM ${segments} AS any_segment WHERE any_segment.session_id = r.session_id)
		ON CONFLICT (session_id, seq) DO UPDATE SET anchor_seq = excluded.anchor_seq, children = excluded.children, broken = excluded.broken`;
}
