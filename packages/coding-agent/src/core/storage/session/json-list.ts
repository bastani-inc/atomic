import type { StorageDialect } from "../dialect.js";

/**
 * `expression IN (…)` over a list bound as one parameter, the list as a JSON array (`JSON.stringify(values)`): the
 * statement's text is the same however many values the list holds, so a server that keeps prepared statements, and
 * pg_stat_statements, see one statement instead of one per length (#6560). On PostgreSQL the list becomes an array the
 * comparison takes whole (`= ANY`), so an index on `expression` is searched for each value, as for a list of
 * parameters. With `int`, PostgreSQL's text elements are compared as integers.
 */
export function inJsonList(dialect: StorageDialect, expression: string, int = false): string {
	const value = int ? `CAST(value AS ${dialect.types.int})` : "value";
	const values = `SELECT ${value} FROM ${dialect.jsonValues("?")}`;
	return dialect.name === "postgres" ? `${expression} = ANY(ARRAY(${values}))` : `${expression} IN (${values})`;
}
