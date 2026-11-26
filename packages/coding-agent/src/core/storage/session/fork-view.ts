import type { SqliteValue } from "../database.js";
import type { StorageDialect } from "../dialect.js";

/**
 * Reads of a session's rows through its view (#6560). A fork that shares its parent's history stores no copy of the
 * entries it inherits: its `fork_segments` rows name the sessions that store them (see `fork-segments.ts`). Each read
 * of a session's entries, entry chunks, search texts or entry links names the session's view instead of the table: the
 * rows its segments name, renumbered to the session's own seqs, and the rows it stores itself. The segments are joined
 * in the very statement that reads the rows, so a read never pairs one snapshot's segments with another's rows, and no
 * list of segments is kept between statements to go stale.
 *
 * A view row also says where it is stored, `src_id` and `src_seq`, for a lookup of the same row, or of its chunks, in
 * the same statement. Those never leave the statement: a parent's replace may move the rows a child inherits into the
 * child between two statements, which leaves the child's view as it was but not where its rows are stored.
 */
export interface ForkViewTables {
	/** The fork segments table, or undefined where the database has no shared history, which reads the table itself. */
	readonly segments: string | undefined;
	readonly dialect: StorageDialect;
	/**
	 * A condition every row of the view holds to, in the statement's own snapshot: a read outside a transaction checks
	 * that the database's schema is one it reads this way, as another process may raise it at any time.
	 */
	readonly guard?: string;
}

export interface ForkView {
	/** A common table expression, `name AS NOT MATERIALIZED (...)`, for the start of the statement's `WITH`. */
	readonly cte: string;
	/** Its parameters, which come before every other parameter of the statement. */
	readonly params: readonly SqliteValue[];
}

/** The largest view seq a range reads when it has no upper bound. */
export const FORK_VIEW_END = Number.MAX_SAFE_INTEGER;

/**
 * The common table expression `name`: session `sessionId`'s rows of `table`, a table keyed by `(session_id, seq)` and
 * maybe more, whose view seqs are after `after` and at most `through`, with `columns` and `session_id`, `seq`, `src_id`
 * and `src_seq`. Bounding the range lets each source's index read only the rows asked for.
 */
export function forkView(
	tables: ForkViewTables,
	view: {
		readonly name: string;
		readonly table: string;
		readonly columns: readonly string[];
		readonly sessionId: string;
		readonly after: number;
		readonly through: number;
		/** Only the rows whose column `column` holds `value`, which an index of the table keyed by it then finds. */
		readonly match?: { readonly column: string; readonly value: SqliteValue };
	},
): ForkView {
	const { name, table, sessionId, after, through, match } = view;
	const int = tables.dialect.types.int;
	const conditions = (alias: string) =>
		`${match === undefined ? "" : ` AND ${alias}${match.column} = ?`}${tables.guard === undefined ? "" : ` AND ${tables.guard}`}`;
	const matched = match === undefined ? [] : [match.value];
	const own = `SELECT session_id, seq${view.columns.map((column) => `, ${column}`).join("")}, session_id AS src_id, seq AS src_seq
		FROM ${table} WHERE session_id = ? AND seq > CAST(? AS ${int}) AND seq <= CAST(? AS ${int})${conditions("")}`;
	if (tables.segments === undefined)
		return { cte: `${name} AS NOT MATERIALIZED (${own})`, params: [sessionId, after, through, ...matched] };
	const { greatest, least } = tables.dialect;
	// A segment's source row at seq s is view seq base_seq + (s - from_seq) + 1: the view seqs after `after` and at most
	// `through` are the source's seqs from `after` + from_seq - base_seq through `through` + from_seq - base_seq - 1.
	const inherited = `SELECT f.session_id AS session_id, f.base_seq + (x.seq - f.from_seq) + 1 AS seq${view.columns
		.map((column) => `, x.${column} AS ${column}`)
		.join("")}, x.session_id AS src_id, x.seq AS src_seq
		FROM ${tables.segments} f JOIN ${table} x ON x.session_id = f.source_id
			AND x.seq >= ${greatest("f.from_seq", `CAST(? AS ${int}) + f.from_seq - f.base_seq`)}
			AND x.seq <= ${least("f.to_seq", `CAST(? AS ${int}) + f.from_seq - f.base_seq - 1`)}
		WHERE f.session_id = ? AND f.base_seq < CAST(? AS ${int})
			AND f.base_seq + (f.to_seq - f.from_seq) + 1 > CAST(? AS ${int})${conditions("x.")}`;
	return {
		cte: `${name} AS NOT MATERIALIZED (${inherited} UNION ALL ${own})`,
		params: [after, through, sessionId, through, after, ...matched, sessionId, after, through, ...matched],
	};
}

/**
 * Every session's rows of `table` through its view, as a derived table with `columns`, `session_id` and `seq`, and no
 * parameters: for a statement that reads the rows of many sessions, each by `session_id`, which the database applies
 * to both halves of the union.
 */
export function forkViewAll(
	tables: ForkViewTables,
	view: { readonly table: string; readonly columns: readonly string[] },
): string {
	const { table } = view;
	if (tables.segments === undefined)
		return tables.guard === undefined ? table : `(SELECT * FROM ${table} WHERE ${tables.guard})`;
	const columns = view.columns.map((column) => `, ${column}`).join("");
	const guard = tables.guard === undefined ? "" : ` WHERE ${tables.guard}`;
	return `(SELECT f.session_id AS session_id, f.base_seq + (x.seq - f.from_seq) + 1 AS seq${view.columns
		.map((column) => `, x.${column} AS ${column}`)
		.join("")}
		FROM ${tables.segments} f JOIN ${table} x ON x.session_id = f.source_id AND x.seq >= f.from_seq AND x.seq <= f.to_seq${guard}
		UNION ALL SELECT session_id, seq${columns} FROM ${table}${guard})`;
}

/** `sql`, a statement that may begin with `WITH`, with `views` first in its `WITH`. */
export function withForkViews(views: readonly ForkView[], sql: string): string {
	if (views.length === 0) return sql;
	const ctes = views.map((view) => view.cte).join(", ");
	const body = sql.trimStart();
	return /^WITH\s/i.test(body) ? `WITH ${ctes}, ${body.slice(4).trimStart()}` : `WITH ${ctes} ${body}`;
}

/** The parameters of `views`, in order, for the start of the statement's parameters. */
export function forkViewParams(views: readonly ForkView[]): SqliteValue[] {
	return views.flatMap((view) => view.params);
}
