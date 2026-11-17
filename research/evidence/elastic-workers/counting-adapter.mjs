// A storage adapter that counts the shared store's write commits (#4768): it wraps the adapter COUNTING_INNER_ADAPTER
// names and appends one line per committed write to `<COUNTING_DIR>/<pid>.log`, from every process that opens the
// journal through it (the root, its coordinator, worker hosts and their workers). A write commit is a batch, a
// transaction or a statement outside both that wrote: one request to the shared writer on a server, one commit on a
// file. Each line is the commit's kind and its first written table.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE)\b)/i;
const inner = (await import(process.env.COUNTING_INNER_ADAPTER)).default;
const directory = process.env.COUNTING_DIR;
mkdirSync(directory, { recursive: true });
const log = join(directory, `${process.pid}.log`);

function tableOf(sql) {
	const match = /\b(?:INTO|UPDATE|FROM|TABLE(?: IF NOT EXISTS)?)\s+("?[\w.]+"?)/i.exec(sql);
	return match?.[1]?.replaceAll('"', "") ?? "?";
}
function record(kind, sql) {
	appendFileSync(log, `${kind} ${tableOf(sql)}\n`);
}

function counted(database) {
	const writing = (executor, wrote) => ({
		exec: async (sql) => {
			const result = await executor.exec(sql);
			if (WRITE.test(sql)) wrote(sql);
			return result;
		},
		run: async (sql, ...params) => {
			const result = await executor.run(sql, ...params);
			if (WRITE.test(sql)) wrote(sql);
			return result;
		},
		get: async (sql, ...params) => {
			const result = await executor.get(sql, ...params);
			if (WRITE.test(sql)) wrote(sql);
			return result;
		},
		all: async (sql, ...params) => {
			const result = await executor.all(sql, ...params);
			if (WRITE.test(sql)) wrote(sql);
			return result;
		},
	});
	const top = writing(database, (sql) => record("statement", sql));
	return {
		...database,
		...top,
		descriptor: database.descriptor,
		dialect: database.dialect,
		transaction: async (body, options) => {
			let first;
			const result = await database.transaction(
				(tx) => body(writing(tx, (sql) => (first ??= sql))),
				options,
			);
			if (first !== undefined) record(options?.kind === "fenced" ? "fenced" : "transaction", first);
			return result;
		},
		...(database.batch === undefined
			? {}
			: {
					batch: async (statements, options) => {
						const result = await database.batch(statements, options);
						const first = statements.find((statement) => WRITE.test(statement.sql) && !/_pool_fence/.test(statement.sql));
						if (first !== undefined) record("batch", first.sql);
						return result;
					},
				}),
		close: () => database.close(),
	};
}

export default {
	...inner,
	atomicStorageAdapter: 1,
	async openDatabase(options, context) {
		return counted(await inner.openDatabase(options, context));
	},
};
