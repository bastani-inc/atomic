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
	const { parent, columns, anchor, broken } = forkLinkValues(links, segments, isSnapshot, {
		isSnapshotOut: "t.is_snapshot = 1",
	});
	return `INSERT INTO ${links} (session_id, seq, entry_id, parent_id, anchor_seq, children, broken)
		SELECT t.session_id, t.seq, t.entry_id, CASE WHEN t.parent_type = 'text' THEN t.parent_id END, ${anchor}, 0, ${broken}
		FROM (SELECT r.session_id, r.seq, r.entry_id, r.parent_id, r.parent_type,
			CASE WHEN ${isSnapshot} THEN 1 ELSE 0 END AS is_snapshot,
			${columns}
			FROM ${rows} AS r ${parent}
			WHERE EXISTS (SELECT 1 FROM ${segments} AS any_segment WHERE any_segment.session_id = r.session_id)) AS t
		WHERE true
		ON CONFLICT (session_id, seq) DO UPDATE SET anchor_seq = excluded.anchor_seq, broken = excluded.broken`;
}

/**
 * The anchor and the broken mark of entry `r` as {@link forkSessionLink} links it, from the links before it, its
 * session's and those its segments name: the one function a save, the index's rebuild and the check of a
 * materialization's links ({@link forkLinksCheck}) all compute them with (#6560). For a session without segments it
 * is what the released link statement writes.
 *
 * `parent` is the join that follows `r` in the inner SELECT's FROM: it finds `r`'s parent among the links its session
 * stores ({@link ownParentSeq}) once, as `par`. `columns` projects `par`, the duplicate check and—when segments may
 * exist—a single inherited-parent lookup packing `(COALESCE(anchor + 1, 0) * 2 + broken)` into `inh`, so a row whose
 * parent comes from a segment looks the segment up once for both `anchor` and `broken`. The outer SELECT aliases that
 * projection as `t` and evaluates `anchor` and `broken`.
 */
export function forkLinkValues(
	links: string,
	segments: string,
	isSnapshot: string,
	options: {
		readonly isSnapshotOut?: string;
		readonly hasSegments?: boolean;
		readonly segmentBefore?: string;
	} = {},
): {
	readonly parent: string;
	readonly columns: string;
	readonly anchor: string;
	readonly broken: string;
} {
	const isSnapshotOut = options.isSnapshotOut ?? isSnapshot;
	const hasSegments = options.hasSegments ?? true;
	const segmentBefore = options.segmentBefore;
	// The first link with the parent's id, if it is before `r`: the link `ownParentSeq` finds, joined as a plain row, so
	// that no lookup is a join key the database computes for each comparison.
	const parent = `LEFT JOIN ${links} AS par ON par.session_id = r.session_id AND par.entry_id = r.parent_id AND r.parent_type = 'text' AND +par.seq < r.seq AND NOT EXISTS (SELECT 1 FROM ${links} AS earlier WHERE earlier.session_id = par.session_id AND earlier.entry_id = par.entry_id AND +earlier.seq < par.seq)`;
	if (!hasSegments) {
		return {
			parent,
			columns: `par.anchor_seq AS par_anchor, par.broken AS par_broken, CASE WHEN ${ownDuplicate(links)} THEN 1 ELSE 0 END AS dup`,
			anchor: `CASE WHEN ${isSnapshotOut} THEN t.seq ELSE t.par_anchor END`,
			broken: `CASE WHEN t.dup = 1 THEN 1 WHEN t.parent_type IS NULL OR t.parent_type = 'null' THEN 0 ELSE COALESCE(t.par_broken, 1) END`,
		};
	}
	const inhAnchor = `CASE WHEN ${isSnapshot} THEN 0 WHEN up.anchor_seq IS NOT NULL THEN COALESCE(${childViewSeq(links, segments, "r.session_id", "up.session_id", "up.anchor_seq", "r.seq")} + 1, 0) ELSE 0 END`;
	const inhSub = `(SELECT ${inhAnchor} * 2 + up.broken FROM ${segments} AS seg JOIN ${links} AS up ON up.session_id = seg.source_id AND up.entry_id = r.parent_id AND +up.seq BETWEEN seg.from_seq AND seg.to_seq WHERE seg.session_id = r.session_id AND seg.base_seq < r.seq ORDER BY seg.base_seq, up.seq LIMIT 1)`;
	const inherited =
		segmentBefore === undefined
			? `CASE WHEN par.seq IS NULL AND r.parent_type = 'text' THEN ${inhSub} END`
			: `CASE WHEN par.seq IS NULL AND r.parent_type = 'text' THEN CASE WHEN ${segmentBefore} THEN ${inhSub} END END`;
	const segDupExists = `EXISTS (SELECT 1 FROM ${segments} AS seg JOIN ${links} AS other ON other.session_id = seg.source_id AND other.entry_id = r.entry_id AND +other.seq BETWEEN seg.from_seq AND seg.to_seq WHERE seg.session_id = r.session_id AND seg.base_seq < r.seq)`;
	const segDup =
		segmentBefore === undefined
			? `CASE WHEN ${segDupExists} THEN 1 ELSE 0 END`
			: `CASE WHEN ${segmentBefore} THEN CASE WHEN ${segDupExists} THEN 1 ELSE 0 END ELSE 0 END`;
	return {
		parent,
		columns: `par.seq AS par_seq, par.anchor_seq AS par_anchor, par.broken AS par_broken, ${inherited} AS inh, CASE WHEN ${ownDuplicate(links)} THEN 1 ELSE ${segDup} END AS dup`,
		anchor: `CASE WHEN ${isSnapshotOut} THEN t.seq WHEN t.par_seq IS NOT NULL THEN t.par_anchor ELSE NULLIF(t.inh / 2, 0) - 1 END`,
		broken: `CASE WHEN t.dup = 1 THEN 1 WHEN t.parent_type IS NULL OR t.parent_type = 'null' THEN 0 WHEN t.par_seq IS NOT NULL THEN t.par_broken ELSE COALESCE(t.inh % 2, 1) END`,
	};
}

/**
 * The statement that links the rows a materialization just copied into a fork (#6560), one piece of one source at a
 * time, all of them in one statement: each row is linked as its source links it, its anchor taken into the fork's
 * view, and its children counted among the rows the fork now stores past the piece's start whose parent ID the piece
 * names. It runs after the piece's rows are inserted and before the fork's segments lose the piece, so they still map
 * the source's seqs. These links are what {@link forkLinkValues} computes for every history but a few:
 * {@link forkLinksCheck} tells, once the segments lost the pieces, and the fork is linked again row by row where it
 * does not hold. `complete` is the condition that the index's backfill is done: until then the backfill links the rows.
 * Parameters (bound in the leading CTE so the order stays fixed across mixed versions): the fork's id, the shift from
 * the source's seqs to the fork's, the source's id, the first and last seq of the piece in the source, and the fork's
 * id.
 */
export function materializedForkLinks(
	links: string,
	segments: string,
	complete: string,
	int: string,
	dialectName?: StorageDialect["name"],
): string {
	const mCte = `WITH m AS (
		SELECT CAST(? AS text) AS child, CAST(? AS ${int}) AS shift,
			CAST(? AS text) AS source, CAST(? AS ${int}) AS from_seq, CAST(? AS ${int}) AS to_seq,
			CAST(? AS text) AS kids_child
	)`;
	if (dialectName === "postgres") {
		const anchor = `CASE WHEN counted.anchor_seq IS NOT NULL THEN ${childViewSeq(links, segments, "counted.child", "counted.session_id", "counted.anchor_seq", "counted.seq + counted.shift")} END`;
		// On PostgreSQL, unioning the piece's rows (is_kid = 0) with the fork's later links (is_kid = 1) and summing over
		// PARTITION BY entry_id avoids a LEFT JOIN on an aggregated subquery, which PostgreSQL can plan as a quadratic
		// nested loop on fresh tables whose statistics have not been analyzed yet.
		return `${mCte},
	counted AS (
		SELECT child, shift, session_id, seq, entry_id, parent_id, anchor_seq, broken, is_kid,
			sum(is_kid) OVER (PARTITION BY entry_id) AS n
		FROM (
			SELECT m.child, m.shift, up.session_id, up.seq, up.entry_id, up.parent_id, up.anchor_seq, up.broken, 0 AS is_kid
			FROM m CROSS JOIN ${links} AS up
			WHERE up.session_id = m.source AND up.seq BETWEEN m.from_seq AND m.to_seq
			UNION ALL
			SELECT NULL, NULL, NULL, NULL, l.parent_id, NULL, NULL, NULL, 1 AS is_kid
			FROM m CROSS JOIN ${links} AS l
			WHERE l.session_id = m.kids_child AND l.seq > m.from_seq + m.shift AND l.parent_id IS NOT NULL
		) AS u
	)
	INSERT INTO ${links} (session_id, seq, entry_id, parent_id, anchor_seq, children, broken)
	SELECT counted.child, counted.seq + counted.shift, counted.entry_id, counted.parent_id, ${anchor}, counted.n, counted.broken
	FROM counted
	WHERE counted.is_kid = 0 AND ${complete}
	ON CONFLICT (session_id, seq) DO UPDATE SET anchor_seq = excluded.anchor_seq, children = excluded.children, broken = excluded.broken`;
	}
	const anchor = `CASE WHEN up.anchor_seq IS NOT NULL THEN ${childViewSeq(links, segments, "m.child", "up.session_id", "up.anchor_seq", "up.seq + m.shift")} END`;
	return `${mCte}
	INSERT INTO ${links} (session_id, seq, entry_id, parent_id, anchor_seq, children, broken)
	SELECT m.child, up.seq + m.shift, up.entry_id, up.parent_id, ${anchor}, COALESCE(kids.n, 0), up.broken
	FROM m
	CROSS JOIN ${links} AS up
	LEFT JOIN (
		SELECT l.parent_id, count(*) AS n
		FROM m AS km
		CROSS JOIN ${links} AS l
		WHERE l.session_id = km.kids_child AND l.seq > km.from_seq + km.shift
			AND l.parent_id IN (
				SELECT p.entry_id FROM m AS pm CROSS JOIN ${links} AS p
				WHERE p.session_id = pm.source AND p.seq BETWEEN pm.from_seq AND pm.to_seq
			)
		GROUP BY l.parent_id
	) AS kids ON kids.parent_id = up.entry_id
	WHERE up.session_id = m.source AND up.seq BETWEEN m.from_seq AND m.to_seq AND ${complete}
	ON CONFLICT (session_id, seq) DO UPDATE SET anchor_seq = excluded.anchor_seq, children = excluded.children, broken = excluded.broken`;
}

/**
 * The read that tells whether the links of session `?` from seq `?` on are the ones {@link forkLinkValues} computes,
 * one statement for them all, in one pass over those links (#6560): `seq`, the first row whose anchor or broken mark
 * is not, or null; `children`, whether a row from that seq on has a child stored before it (or names itself as its own
 * parent), whose count {@link materializedForkLinks} and a save may tell apart; and `refs`, whether a snapshot entry's
 * reference names another previous snapshot than its parent's anchor. It reads the rows' links, which name each
 * entry's id and its parent's, so no entry's JSON is parsed: a link without a parent is taken for a root (one whose
 * parent is a value of another type, which no store writes, is linked broken, so the check finds it), and a snapshot
 * entry is its own anchor, as no other entry is. `refs` is the snapshot references' table. Nothing is read until the
 * index's backfill is done (`complete`).
 *
 * When `hasSegments` is false (no segments remain for the session), segment lookups and segment duplicate checks are
 * omitted altogether; parameters are `(sessionId, fromSeq, sessionId, fromSeq)` when `materialize` is true (default),
 * or `(sessionId, fromSeq, sessionId, fromSeq, sessionId, fromSeq)` when `materialize` is false (streamed without a
 * temporary table). When `hasSegments` is true (default), the session's earliest segment `base_seq` is read once to
 * skip segment lookups and duplicate checks for rows before it (and when no segments remain); parameters are
 * `(sessionId, sessionId, fromSeq, sessionId, fromSeq)`.
 */
export function forkLinksCheck(
	tables: { readonly links: string; readonly segments: string; readonly refs: string },
	complete: string,
	options: { readonly hasSegments?: boolean; readonly materialize?: boolean } = {},
): string {
	const { links, segments, refs } = tables;
	const hasSegments = options.hasSegments ?? true;
	const materialize = options.materialize ?? true;
	const rows = `(SELECT l.session_id, l.seq, l.entry_id, l.parent_id, CASE WHEN l.parent_id IS NOT NULL THEN 'text' ELSE 'null' END AS parent_type, l.anchor_seq AS own_anchor, l.broken AS own_broken FROM ${links} AS l WHERE l.session_id = ? AND l.seq >= ?)`;
	if (!hasSegments && !materialize) {
		const { parent } = forkLinkValues(links, segments, "r.own_anchor = r.seq", { hasSegments: false });
		const anchor = "CASE WHEN r.own_anchor = r.seq THEN r.seq ELSE par.anchor_seq END";
		const broken = `CASE WHEN ${ownDuplicate(links)} THEN 1 WHEN r.parent_type IS NULL OR r.parent_type = 'null' THEN 0 ELSE COALESCE(par.broken, 1) END`;
		return `SELECT v.seq,
			CASE WHEN v.children = 1 OR EXISTS (SELECT 1 FROM ${links} AS c WHERE c.session_id = ? AND c.seq < ? AND c.parent_id IN (SELECT q.entry_id FROM ${links} AS q WHERE q.session_id = ? AND q.seq >= ?)) THEN 1 ELSE 0 END AS children,
			v.refs
		FROM (SELECT
			min(CASE WHEN COALESCE(r.own_anchor, -1) <> COALESCE(${anchor}, -1) OR r.own_broken <> ${broken} THEN r.seq END) AS seq,
			max(CASE WHEN r.parent_id IS NOT NULL AND (r.parent_id = r.entry_id OR EXISTS (SELECT 1 FROM ${links} AS q WHERE q.session_id = r.session_id AND q.entry_id = r.parent_id AND +q.seq > r.seq)) THEN 1 ELSE 0 END) AS children,
			max(CASE WHEN r.own_anchor = r.seq AND ref.seq IS NOT NULL AND COALESCE(ref.prev_seq, -1) <> COALESCE(par.anchor_seq, -1) THEN 1 ELSE 0 END) AS refs
			FROM ${rows} AS r ${parent} LEFT JOIN ${refs} AS ref ON ref.session_id = r.session_id AND ref.seq = r.seq) AS v
		WHERE ${complete}`;
	}
	const { parent, columns, anchor, broken } = forkLinkValues(links, segments, "r.own_anchor = r.seq", {
		isSnapshotOut: "t.own_anchor = t.seq",
		hasSegments,
		segmentBefore: hasSegments ? "s.first_seg < r.seq" : undefined,
	});
	const fromChecked = hasSegments
		? `(SELECT min(seg.base_seq) AS first_seg FROM ${segments} AS seg WHERE seg.session_id = ?) AS s CROSS JOIN ${rows} AS r`
		: `${rows} AS r`;
	// Materialize the checked rows once as `t` so that the packed inherited-parent lookup evaluates at most once per row
	// and the earlier-row child probe tests `c.parent_id` against `t.entry_id` without scanning the checked rows again.
	return `WITH t AS MATERIALIZED (
		SELECT r.session_id, r.seq, r.entry_id, r.parent_id, r.parent_type, r.own_anchor, r.own_broken,
			${columns},
			ref.seq AS ref_seq, ref.prev_seq AS ref_prev
		FROM ${fromChecked} ${parent} LEFT JOIN ${refs} AS ref ON ref.session_id = r.session_id AND ref.seq = r.seq
	)
	SELECT v.seq,
		CASE WHEN v.children = 1 OR EXISTS (SELECT 1 FROM ${links} AS c WHERE c.session_id = ? AND c.seq < ? AND c.parent_id IN (SELECT entry_id FROM t)) THEN 1 ELSE 0 END AS children,
		v.refs
	FROM (SELECT
		min(CASE WHEN COALESCE(t.own_anchor, -1) <> COALESCE(${anchor}, -1) OR t.own_broken <> ${broken} THEN t.seq END) AS seq,
		max(CASE WHEN t.parent_id IS NOT NULL AND (t.parent_id = t.entry_id OR EXISTS (SELECT 1 FROM ${links} AS q WHERE q.session_id = t.session_id AND q.entry_id = t.parent_id AND +q.seq > t.seq)) THEN 1 ELSE 0 END) AS children,
		max(CASE WHEN t.own_anchor = t.seq AND t.ref_seq IS NOT NULL AND COALESCE(t.ref_prev, -1) <> COALESCE(t.par_anchor, -1) THEN 1 ELSE 0 END) AS refs
		FROM t) AS v
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
