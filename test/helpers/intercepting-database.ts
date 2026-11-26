import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue } from "@bastani/atomic/storage";

/** Replaces one executor method; `next` runs the statement on the executor it was sent to. */
export interface StatementInterceptors {
	readonly exec?: (sql: string, next: (sql: string) => Promise<void>) => Promise<void>;
	readonly all?: (
		sql: string,
		params: readonly SqliteValue[],
		next: (sql: string, ...params: readonly SqliteValue[]) => Promise<SqliteRow[]>,
	) => Promise<SqliteRow[]>;
}

/** `executor` with `replaced` in place of its own methods; every other field is the executor's own. */
function overriding<Executor extends SqliteExecutor>(executor: Executor, replaced: Partial<Executor>): Executor {
	return new Proxy(executor, {
		get(target, key) {
			const value = (key in replaced ? Reflect.get(replaced, key) : Reflect.get(target, key, target)) as
				| Executor[keyof Executor]
				| undefined;
			return typeof value === "function" && !(key in replaced) ? value.bind(target) : value;
		},
	});
}

function intercepted<Executor extends SqliteExecutor>(executor: Executor, hooks: StatementInterceptors): Executor {
	const { exec, all } = hooks;
	const replaced: Partial<SqliteExecutor> = {};
	if (exec !== undefined) replaced.exec = (sql) => exec(sql, (next) => executor.exec(next));
	if (all !== undefined)
		replaced.all = ((sql: string, ...params: SqliteValue[]) =>
			all(sql, params, (next, ...nextParams) => executor.all(next, ...nextParams))) as SqliteExecutor["all"];
	return overriding(executor, replaced as Partial<Executor>);
}

/**
 * `database`, where `hooks` see every `exec` and `all`, whether sent directly or inside a transaction, so a fake
 * failure reaches statements a store runs in its schema transactions too.
 */
export function interceptingDatabase(database: SqliteDatabase, hooks: StatementInterceptors): SqliteDatabase {
	const outer = intercepted(database, hooks);
	const tryMaintenance = database.tryMaintenance?.bind(database);
	return overriding(outer, {
		transaction: (callback, options) =>
			database.transaction((transaction) => callback(intercepted(transaction, hooks)), options),
		...(tryMaintenance === undefined
			? {}
			: {
					tryMaintenance: (callback) => tryMaintenance((transaction) => callback(intercepted(transaction, hooks))),
				}),
	});
}
