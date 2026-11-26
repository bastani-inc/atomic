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
 * (`forkEntryLink`, `materializedForkLinks`), and a store's open drops the trigger where it finds it.
 */
export function legacyForkLinksTriggerName(entries: string): string {
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
 * the session inherits also has is broken, as in a copy. It writes over the released statement's row, so it ends the
 * same whichever of the two runs first.
 *
 * With `written`, the store runs it after the statement that inserted the entry, whose rows and segments after it may
 * be there already (#6560): it then reads only the session's rows and segments before the entry, which are what a copy
 * had when it inserted the entry, and leaves the children count to the released statements, which count each child as
 * it is inserted. Without, as the index's backfill runs it, it counts the children an entry written below the
 * session's last row already has, as when a fork's inherited rows are copied into it.
 *
 * The snapshot references of such an entry stay as the released statements index them: a reference's `prev_seq` that
 * would name an inherited entry is empty. Collection walks a session's references only through the rows the session
 * stores, and keeps every snapshot record a segment names (see `SqlSnapshotBlobStore.sweep`), so it never needs it.
 */
export function forkSessionLink(
	links: string,
	segments: string,
	rows: string,
	isSnapshot: string,
	written = false,
): string {
	const before = (alias: string) => (written ? ` AND ${alias}.seq < r.seq` : "");
	const segmentBefore = written ? " AND seg.base_seq < r.seq" : "";
	const own = (column: string) =>
		`(SELECT p.${column} FROM ${links} AS p WHERE p.session_id = r.session_id AND p.entry_id = r.parent_id AND r.parent_type = 'text'${before("p")} ORDER BY p.seq LIMIT 1)`;
	const ownParent = `EXISTS (SELECT 1 FROM ${links} AS p WHERE p.session_id = r.session_id AND p.entry_id = r.parent_id AND r.parent_type = 'text'${before("p")})`;
	const inherited = (select: string) =>
		`(SELECT ${select} FROM ${segments} AS seg JOIN ${links} AS up ON up.session_id = seg.source_id AND up.entry_id = r.parent_id AND up.seq BETWEEN seg.from_seq AND seg.to_seq WHERE seg.session_id = r.session_id AND r.parent_type = 'text'${segmentBefore} ORDER BY seg.base_seq, up.seq LIMIT 1)`;
	const anchor = `CASE WHEN up.anchor_seq IS NOT NULL THEN ${childViewSeq(links, segments, "r.session_id", "up.session_id", "up.anchor_seq")} END`;
	const duplicate = `EXISTS (SELECT 1 FROM ${links} AS other WHERE other.session_id = r.session_id AND other.entry_id = r.entry_id AND other.seq <> r.seq${before("other")}) OR EXISTS (SELECT 1 FROM ${segments} AS seg JOIN ${links} AS other ON other.session_id = seg.source_id AND other.entry_id = r.entry_id AND other.seq BETWEEN seg.from_seq AND seg.to_seq WHERE seg.session_id = r.session_id${segmentBefore})`;
	const children = written
		? "0"
		: `CASE WHEN EXISTS (SELECT 1 FROM ${links} AS later WHERE later.session_id = r.session_id AND later.seq > r.seq) THEN (SELECT count(*) FROM ${links} AS c WHERE c.session_id = r.session_id AND c.parent_id = r.entry_id AND c.seq <> r.seq) ELSE 0 END`;
	return `INSERT INTO ${links} (session_id, seq, entry_id, parent_id, anchor_seq, children, broken)
		SELECT r.session_id, r.seq, r.entry_id, CASE WHEN r.parent_type = 'text' THEN r.parent_id END,
			CASE WHEN ${isSnapshot} THEN r.seq WHEN ${ownParent} THEN ${own("anchor_seq")} ELSE ${inherited(anchor)} END,
			${children},
			CASE WHEN ${duplicate} THEN 1 WHEN r.parent_type IS NULL OR r.parent_type = 'null' THEN 0 WHEN ${ownParent} THEN ${own("broken")} ELSE COALESCE(${inherited("up.broken")}, 1) END
		FROM ${rows} AS r WHERE EXISTS (SELECT 1 FROM ${segments} AS any_segment WHERE any_segment.session_id = r.session_id)
		ON CONFLICT (session_id, seq) DO UPDATE SET anchor_seq = excluded.anchor_seq, ${written ? "" : "children = excluded.children, "}broken = excluded.broken`;
}

/**
 * The statement that links the rows a materialization just copied into a fork (#6560), one piece of one source at a
 * time, all of them in one statement: each row is linked as its source links it, its anchor taken into the fork's
 * view, and its children counted among the rows the fork now stores. It runs after the piece's rows are inserted and
 * before the fork's segments lose the piece, so they still map the source's seqs. `complete` is the condition that the
 * index's backfill is done: until then the backfill links the rows. Parameters: the fork's id, the shift from the
 * source's seqs to the fork's, the source's id, the first and last seq of the piece in the source, and the fork's id.
 */
export function materializedForkLinks(links: string, segments: string, complete: string, int: string): string {
	const anchor = `CASE WHEN up.anchor_seq IS NOT NULL THEN ${childViewSeq(links, segments, "m.child", "up.session_id", "up.anchor_seq")} END`;
	return `INSERT INTO ${links} (session_id, seq, entry_id, parent_id, anchor_seq, children, broken)
		SELECT m.child, up.seq + m.shift, up.entry_id, up.parent_id, ${anchor}, COALESCE(kids.n, 0), up.broken
		FROM (SELECT CAST(? AS text) AS child, CAST(? AS ${int}) AS shift) AS m
		JOIN ${links} AS up ON up.session_id = ? AND up.seq BETWEEN ? AND ?
		LEFT JOIN (SELECT parent_id, count(*) AS n FROM ${links} WHERE session_id = ? GROUP BY parent_id) AS kids ON kids.parent_id = up.entry_id
		WHERE ${complete}
		ON CONFLICT (session_id, seq) DO UPDATE SET anchor_seq = excluded.anchor_seq, children = excluded.children, broken = excluded.broken`;
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
 * The statements with which a session store links the entries a session with fork segments stores (#6560). The
 * released triggers, which every entry runs, link an entry whose parent the session inherits as broken, without an
 * anchor, and an entry below it the same; so the store writes the link over theirs in the transaction that writes the
 * entry, behind it and the entries before it, in seq order. A plain session's writes run none of them. Each waits for
 * the index's backfill, which links what they would.
 */
export interface ForkLinkWrites {
	/** The link of the entry at `seq` of session `sessionId`, run after the statements that wrote it. */
	entry(sessionId: string, seq: number): SqliteStatement;
	/** The links of a piece a materialization copied into a fork, in one statement: see {@link materializedForkLinks}. */
	readonly materialized: string;
}

export function forkLinkWrites(tables: ForkLinkTables, d: StorageDialect): ForkLinkWrites {
	const complete = entriesIndexComplete(tables.sources);
	const rows = `(SELECT session_id, seq, entry_id, entry_json, ${parentColumns(d, "entry_json")} FROM ${tables.entries} WHERE session_id = ? AND seq = ? AND ${complete})`;
	const sql = forkSessionLink(
		tables.sessionLinks,
		tables.forkSegments,
		rows,
		snapshotEntryCondition(d, (name) => `r.${name}`),
		true,
	);
	return {
		entry: (sessionId, seq) => ({ sql, params: [sessionId, seq] }),
		materialized: materializedForkLinks(tables.sessionLinks, tables.forkSegments, complete, d.types.int),
	};
}
