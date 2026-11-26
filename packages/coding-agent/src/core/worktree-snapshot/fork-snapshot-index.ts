import type { SqliteStatement } from "../storage/database.js";
import type { StorageDialect } from "../storage/dialect.js";
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
 * The trigger that earlier builds of #6560 installed to link each entry a session with fork segments writes. Each
 * INSERT into the session entries table ran it, a plain session's too, so the store now writes those links itself
 * (`forkLinkWrites`, `materializedForkLinks`), and a store's open drops the trigger where it finds it.
 */
export function legacyForkLinksTriggerName(entries: string): string {
	return `${entries}_fork_links_v1`;
}

/** The view seq one past a segment's last, for the segment aliased `alias`. */
const segmentEnd = (alias: string) => `${alias}.base_seq + ${alias}.to_seq - ${alias}.from_seq + 1`;

/**
 * The seq of the link that is the parent of entry `r` among the links its session stores, or null: of the links before
 * `r` with the parent's id, the first. `r` has the columns {@link parentColumns} names. A save and a rebuild of the
 * index both link an entry with this lookup, so an entry whose parent is written after it, or whose parent's id more
 * than one entry has, is linked the same by both (#6560).
 */
export function ownParentSeq(links: string): string {
	// `+seq`: the lookup goes by the entry's id, never in seq order, which SQLite would read row by row.
	return `(SELECT min(+p.seq) FROM ${links} AS p WHERE p.session_id = r.session_id AND p.entry_id = r.parent_id AND r.parent_type = 'text' AND +p.seq < r.seq)`;
}

/** Whether a link before entry `r` in its session has `r`'s id: such an entry is linked broken, as in a copy. */
export function ownDuplicate(links: string): string {
	return `EXISTS (SELECT 1 FROM ${links} AS other WHERE other.session_id = r.session_id AND other.entry_id = r.entry_id AND +other.seq < r.seq)`;
}

/**
 * The seq in session `child`'s view of the entry at seq `seq` of session `source`'s view, where `source` stores a row
 * `child` inherits. Segments are composed when a fork is made, so a segment's source stores the rows it names itself:
 * `seq` is either a row `source` stores, which a segment of `child` names, or a row `source` inherits, from the source
 * of one of its own segments, which a segment of `child` names by that source. An entry that `child`, or a fork
 * between `source` and `child`, stores itself, such as one a fork edited, is found by its id among the rows of
 * `child`'s view before `bound`, the entry being linked.
 */
function childViewSeq(
	links: string,
	segments: string,
	child: string,
	source: string,
	seq: string,
	bound: string,
): string {
	const inheritedBy = `ss.session_id = ${source} AND ${seq} BETWEEN ss.base_seq + 1 AND ${segmentEnd("ss")}`;
	const stored = `${seq} - ss.base_seq - 1 + ss.from_seq`;
	const entryId = `COALESCE((SELECT a.entry_id FROM ${links} AS a WHERE a.session_id = ${source} AND a.seq = ${seq}), (SELECT a.entry_id FROM ${segments} AS ss JOIN ${links} AS a ON a.session_id = ss.source_id AND a.seq = ${stored} WHERE ${inheritedBy}))`;
	return `COALESCE(
		(SELECT ${seq} - cs.from_seq + cs.base_seq + 1 FROM ${segments} AS cs WHERE cs.session_id = ${child} AND cs.source_id = ${source} AND ${seq} BETWEEN cs.from_seq AND cs.to_seq),
		(SELECT ${stored} - cs.from_seq + cs.base_seq + 1 FROM ${segments} AS ss JOIN ${segments} AS cs ON cs.session_id = ${child} AND cs.source_id = ss.source_id AND ${stored} BETWEEN cs.from_seq AND cs.to_seq WHERE ${inheritedBy}),
		(SELECT min(+own.seq) FROM ${links} AS own WHERE own.session_id = ${child} AND own.entry_id = ${entryId} AND +own.seq < ${bound}),
		(SELECT x.seq - cs.from_seq + cs.base_seq + 1 FROM ${segments} AS cs JOIN ${links} AS x ON x.session_id = cs.source_id AND x.entry_id = ${entryId} AND +x.seq BETWEEN cs.from_seq AND cs.to_seq WHERE cs.session_id = ${child} AND cs.base_seq < ${bound} ORDER BY cs.base_seq, x.seq LIMIT 1)
	)`;
}

/**
 * The statement that links one entry of a session with fork segments, as a copy of the session would have it. `rows`
 * yields that entry as `r`, with its parent's id and JSON type as `parent_id` and `parent_type`; `isSnapshot` tells
 * whether `r` is a snapshot entry. It runs after the released link statement of the entry, and writes over that row's
 * anchor and broken mark; the released statements keep the children count.
 *
 * The released link statement finds an entry's parent only among the links the session stores, so it marks an entry
 * whose parent the session inherits broken, without an anchor. This one also finds the parent among the links of the
 * rows the session's segments name, and takes the parent's anchor in the session's view. An entry whose id an entry
 * the session inherits also has is broken, as in a copy.
 *
 * It reads only the rows of the session's view before the entry, the links the session stores and those its segments
 * name, as a copy had when it inserted the entry: a parent written after its child, or an entry of the same id after
 * it, changes nothing. A save runs it as it writes an entry, the index's rebuild as it links a stored row again, and
 * both meet the rows before the entry linked already (`relinkSessionEntries`), so both link every entry the same
 * (#6560).
 *
 * The snapshot references of such an entry stay as the released statements index them: a reference's `prev_seq` that
 * would name an inherited entry is empty. Collection walks a session's references only through the rows the session
 * stores, and keeps every snapshot record a segment names (see `SqlSnapshotBlobStore.sweep`), so it never needs it.
 */
export function forkSessionLink(links: string, segments: string, rows: string, isSnapshot: string): string {
	const { anchor, broken } = forkLinkValues(links, segments, isSnapshot);
	return `INSERT INTO ${links} (session_id, seq, entry_id, parent_id, anchor_seq, children, broken)
		SELECT r.session_id, r.seq, r.entry_id, CASE WHEN r.parent_type = 'text' THEN r.parent_id END, ${anchor}, 0, ${broken}
		FROM ${rows} AS r WHERE EXISTS (SELECT 1 FROM ${segments} AS any_segment WHERE any_segment.session_id = r.session_id)
		ON CONFLICT (session_id, seq) DO UPDATE SET anchor_seq = excluded.anchor_seq, broken = excluded.broken`;
}

/**
 * The anchor and the broken mark of entry `r` as {@link forkSessionLink} links it, from the links before it, its
 * session's and those its segments name: the one function a save, the index's rebuild and the check of a
 * materialization's links ({@link forkLinksCheck}) all compute them with (#6560). For a session without segments it
 * is what the released link statement writes.
 */
export function forkLinkValues(
	links: string,
	segments: string,
	isSnapshot: string,
): { readonly anchor: string; readonly broken: string } {
	const parentSeq = ownParentSeq(links);
	const own = (column: string) =>
		`(SELECT p.${column} FROM ${links} AS p WHERE p.session_id = r.session_id AND p.seq = ${parentSeq})`;
	const ownParent = `${parentSeq} IS NOT NULL`;
	const inherited = (select: string) =>
		`(SELECT ${select} FROM ${segments} AS seg JOIN ${links} AS up ON up.session_id = seg.source_id AND up.entry_id = r.parent_id AND +up.seq BETWEEN seg.from_seq AND seg.to_seq WHERE seg.session_id = r.session_id AND r.parent_type = 'text' AND seg.base_seq < r.seq ORDER BY seg.base_seq, up.seq LIMIT 1)`;
	const anchor = `CASE WHEN up.anchor_seq IS NOT NULL THEN ${childViewSeq(links, segments, "r.session_id", "up.session_id", "up.anchor_seq", "r.seq")} END`;
	const duplicate = `${ownDuplicate(links)} OR EXISTS (SELECT 1 FROM ${segments} AS seg JOIN ${links} AS other ON other.session_id = seg.source_id AND other.entry_id = r.entry_id AND +other.seq BETWEEN seg.from_seq AND seg.to_seq WHERE seg.session_id = r.session_id AND seg.base_seq < r.seq)`;
	return {
		anchor: `CASE WHEN ${isSnapshot} THEN r.seq WHEN ${ownParent} THEN ${own("anchor_seq")} ELSE ${inherited(anchor)} END`,
		broken: `CASE WHEN ${duplicate} THEN 1 WHEN r.parent_type IS NULL OR r.parent_type = 'null' THEN 0 WHEN ${ownParent} THEN ${own("broken")} ELSE COALESCE(${inherited("up.broken")}, 1) END`,
	};
}

/**
 * The statement that links the rows a materialization just copied into a fork (#6560), one piece of one source at a
 * time, all of them in one statement: each row is linked as its source links it, its anchor taken into the fork's
 * view, and its children counted among the rows the fork now stores. It runs after the piece's rows are inserted and
 * before the fork's segments lose the piece, so they still map the source's seqs. These links are what
 * {@link forkLinkValues} computes for every history but a few: {@link forkLinksCheck} tells, once the segments lost
 * the pieces, and the fork is linked again row by row where it does not hold. `complete` is the condition that the
 * index's backfill is done: until then the backfill links the rows. Parameters: the fork's id, the shift from the
 * source's seqs to the fork's, the source's id, the first and last seq of the piece in the source, and the fork's id.
 */
export function materializedForkLinks(links: string, segments: string, complete: string, int: string): string {
	const anchor = `CASE WHEN up.anchor_seq IS NOT NULL THEN ${childViewSeq(links, segments, "m.child", "up.session_id", "up.anchor_seq", "up.seq + m.shift")} END`;
	return `INSERT INTO ${links} (session_id, seq, entry_id, parent_id, anchor_seq, children, broken)
		SELECT m.child, up.seq + m.shift, up.entry_id, up.parent_id, ${anchor}, COALESCE(kids.n, 0), up.broken
		FROM (SELECT CAST(? AS text) AS child, CAST(? AS ${int}) AS shift) AS m
		JOIN ${links} AS up ON up.session_id = ? AND up.seq BETWEEN ? AND ?
		LEFT JOIN (SELECT parent_id, count(*) AS n FROM ${links} WHERE session_id = ? GROUP BY parent_id) AS kids ON kids.parent_id = up.entry_id
		WHERE ${complete}
		ON CONFLICT (session_id, seq) DO UPDATE SET anchor_seq = excluded.anchor_seq, children = excluded.children, broken = excluded.broken`;
}

/**
 * The read that tells whether the links of session `?` from seq `?` on are the ones {@link forkLinkValues} computes,
 * one statement for them all (#6560): `seq`, the first row whose anchor or broken mark is not, or null; `children`,
 * whether a row from that seq on has a child stored before it, whose count {@link materializedForkLinks} and a save
 * may tell apart; and `refs`, whether a snapshot entry's reference names another previous snapshot than its parent's
 * anchor. `rows` yields the session's rows from that seq on as `r`, with their ids, their parents' ids and JSON types
 * (`parent_id`, `parent_type`), bound to the session's id and the seq; `isSnapshot` tells whether `r` is a snapshot
 * entry; `refs` is the snapshot references' table. Nothing is read until the index's backfill is done (`complete`).
 */
export function forkLinksCheck(
	tables: { readonly links: string; readonly segments: string; readonly refs: string },
	rows: string,
	isSnapshot: string,
	complete: string,
): string {
	const { links, segments, refs } = tables;
	const { anchor, broken } = forkLinkValues(links, segments, isSnapshot);
	const parentAnchor = `(SELECT p.anchor_seq FROM ${links} AS p WHERE p.session_id = r.session_id AND p.seq = ${ownParentSeq(links)})`;
	return `SELECT
		(SELECT min(v.seq) FROM (SELECT r.session_id, r.seq, ${anchor} AS anchor_seq, ${broken} AS broken FROM ${rows} AS r) AS v
			JOIN ${links} AS l ON l.session_id = v.session_id AND l.seq = v.seq
			WHERE COALESCE(l.anchor_seq, -1) <> COALESCE(v.anchor_seq, -1) OR l.broken <> v.broken) AS seq,
		CASE WHEN EXISTS (SELECT 1 FROM ${links} AS c WHERE c.session_id = ? AND c.parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM ${links} AS q WHERE q.session_id = c.session_id AND q.entry_id = c.parent_id AND +q.seq > c.seq AND +q.seq >= ?)) THEN 1 ELSE 0 END AS children,
		CASE WHEN EXISTS (SELECT 1 FROM ${rows} AS r JOIN ${refs} AS ref ON ref.session_id = r.session_id AND ref.seq = r.seq WHERE ${isSnapshot} AND COALESCE(ref.prev_seq, -1) <> COALESCE(${parentAnchor}, -1)) THEN 1 ELSE 0 END AS refs
	WHERE ${complete}`;
}

/** Whether `column(name)`'s row is a snapshot entry, whose snapshot the index records. */
export function snapshotEntryCondition(d: StorageDialect, column: (name: string) => string): string {
	const entry = column("entry_json");
	return `${d.contains(entry, `'"worktree_snapshot"'`)} AND ${d.jsonText(entry, "type")} = 'worktree_snapshot' AND ${d.jsonHasType("text", entry, "root")} AND ${d.jsonHasType("text", entry, "snapshotId")}`;
}

/** The columns of one entry as `r` that name its parent once, so a statement parses the entry's JSON for it only once. */
export function parentColumns(d: StorageDialect, json: string): string {
	return `${d.jsonText(json, "parentId")} AS parent_id, ${d.jsonType(json, "parentId")} AS parent_type`;
}

/**
 * Whether the session entries' index is complete, by its progress row in `sources`: until then their backfill indexes
 * what the triggers and the session store do not.
 */
export function entriesIndexComplete(sources: string): string {
	return `(SELECT backfilled_through >= watermark FROM ${sources} WHERE source = 'session-entries')`;
}

/** The tables {@link forkLinkWrites} reads and writes. */
export interface ForkLinkTables {
	/** The session entries. */
	readonly entries: string;
	/** The snapshot index's session links and progress rows. */
	readonly sessionLinks: string;
	readonly sources: string;
	readonly forkSegments: string;
}

/**
 * The statement with which a session store links the entries a session with fork segments stores (#6560). The
 * released triggers, which every entry runs, link an entry whose parent the session inherits as broken, without an
 * anchor, and an entry below it the same; so the store writes the link over theirs in the transaction that writes the
 * entry, behind it and the entries before it, in seq order. A plain session's writes run none of them. It waits for
 * the index's backfill, which links what it would.
 */
export interface ForkLinkWrites {
	/** The link of the entry at `seq` of session `sessionId`, run after the statements that wrote it. */
	entry(sessionId: string, seq: number): SqliteStatement;
}

export function forkLinkWrites(tables: ForkLinkTables, d: StorageDialect): ForkLinkWrites {
	const complete = entriesIndexComplete(tables.sources);
	const rows = `(SELECT session_id, seq, entry_id, entry_json, ${parentColumns(d, "entry_json")} FROM ${tables.entries} WHERE session_id = ? AND seq = ? AND ${complete})`;
	const sql = forkSessionLink(
		tables.sessionLinks,
		tables.forkSegments,
		rows,
		snapshotEntryCondition(d, (name) => `r.${name}`),
	);
	return { entry: (sessionId, seq) => ({ sql, params: [sessionId, seq] }) };
}
