import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { describe, test } from "vitest";
import { openAdapterSelectionDatabase } from "../../packages/coding-agent/src/core/storage/adapter-open.js";
import { selectStorage } from "../../packages/coding-agent/src/core/storage/selection.js";
import libsqlAdapter, { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import postgresAdapter, { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import { postgresSkipReason, postgresTestPassword, withPostgresDatabase } from "../helpers/postgres-database.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

const guide = readFileSync(resolve(moduleDir(import.meta.url), "../../packages/coding-agent/docs/storage.md"), "utf8");
const tuning = guide.slice(
	guide.indexOf("## Tuning for many concurrent agents"),
	guide.indexOf("## Exporting and importing sessions"),
);

const pgbouncerGuide = readFileSync(
	resolve(moduleDir(import.meta.url), "../../packages/coding-agent/docs/guides/postgres-pgbouncer.md"),
	"utf8",
);

function blocks(language: string, text = tuning): string[] {
	return [...text.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"))].map((match) => match[1]!);
}

const POSTGRES = "@bastani/atomic-storage-postgres";
const LIBSQL = "@bastani/atomic-storage-libsql";
const libsqlTestUrl = process.env.ATOMIC_TEST_LIBSQL_URL || undefined;

type Example = {
	storage: { adapter: string; options: Record<string, unknown>; secrets: Record<string, { file: string }> };
};
const settingsExamples = (adapter: string, text = tuning) =>
	blocks("json", text)
		.map((block) => JSON.parse(block) as Example)
		.filter((example) => example.storage.adapter === adapter);
const sdkExamples = (opener: string, text = tuning) =>
	blocks("typescript", text).filter((source) => source.includes(`${opener}({`));

/** The literal options an SDK example passes to `opener`, with `process.env` values as `undefined`. */
function sdkOptions(source: string, opener: string): Record<string, unknown> {
	const body = new RegExp(`${opener}\\(\\{([\\s\\S]*?)\\}\\)`).exec(source)?.[1];
	assert.ok(body !== undefined, source);
	const options: Record<string, unknown> = {};
	for (const line of body.split("\n")) {
		const entry = /^\s*(\w+):\s*(.+?),?\s*$/.exec(line);
		if (entry === null) continue;
		const [, key, value] = entry as unknown as [string, string, string];
		options[key] = value.startsWith('"')
			? JSON.parse(value)
			: value.startsWith("process.env.")
				? undefined
				: Number(value);
	}
	return options;
}

/** `url` and `listenUrl` pointed at the test database, keeping every other option as the guide wrote it. */
function onTestDatabase(options: Record<string, unknown>, url: string): Record<string, unknown> {
	return {
		...options,
		url,
		...(options.listenUrl === undefined ? {} : { listenUrl: url }),
	};
}

/** Opens each settings example through the selection Atomic makes from `settings.json`, then the guide's checks. */
async function openSettingsExamples(
	examples: readonly Example[],
	url: string,
	secretValue: string,
	adapter: typeof postgresAdapter | typeof libsqlAdapter,
	check: (database: SqliteDatabase, options: Record<string, unknown>) => Promise<void>,
): Promise<void> {
	const agentDir = makeTempDirectory("storage-docs-tuning-");
	try {
		for (const { storage } of examples) {
			for (const { file } of Object.values(storage.secrets)) {
				mkdirSync(dirname(join(agentDir, file)), { recursive: true });
				writeFileSync(join(agentDir, file), secretValue);
			}
			const selection = selectStorage(
				{ ...storage, options: onTestDatabase(storage.options, url) } as never,
				"settings",
				"storage",
				join(agentDir, "storage.sqlite"),
			);
			assert.equal(selection.kind, "adapter");
			const database = await openAdapterSelectionDatabase(
				selection as never,
				{ agentDir, domain: "sessions" },
				adapter,
			);
			try {
				await check(database, storage.options);
			} finally {
				await database.close();
			}
		}
	} finally {
		removeTempDirectory(agentDir);
	}
}

/** The SDK examples' option names match their settings twins in order. */
function assertTwins(
	sources: readonly string[],
	opener: string,
	examples: readonly Example[],
	secretKey: string,
): void {
	assert.equal(sources.length, examples.length);
	for (const [index, source] of sources.entries())
		assert.deepEqual(
			Object.keys(sdkOptions(source, opener))
				.filter((key) => key !== secretKey)
				.sort(),
			Object.keys(examples[index]!.storage.options).sort(),
		);
}

describe.skipIf(postgresSkipReason !== undefined)("storage guide PostgreSQL tuning examples (#6560)", () => {
	test("every PostgreSQL settings.json example is a valid selection that opens with its options", async () => {
		const examples = settingsExamples(POSTGRES);
		assert.equal(examples.length, 2);
		await withPostgresDatabase(({ url }) =>
			openSettingsExamples(examples, url, postgresTestPassword ?? "", postgresAdapter, async (database, options) => {
				assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
				assert.equal(typeof database.openReader, options.readerMaxConnections === 0 ? "undefined" : "function");
			}),
		);
	});

	test("every PostgreSQL SDK example opens with the options of its settings.json twin", async () => {
		const sources = sdkExamples("openPostgresDatabase");
		assertTwins(sources, "openPostgresDatabase", settingsExamples(POSTGRES), "password");
		await withPostgresDatabase(async ({ url }) => {
			for (const source of sources) {
				const database = await openPostgresDatabase({
					...(onTestDatabase(sdkOptions(source, "openPostgresDatabase"), url) as { url: string }),
					...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
				});
				try {
					assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
				} finally {
					await database.close();
				}
			}
		});
	});

	test("the PgBouncer guide's settings.json and SDK examples open with their options", async () => {
		const examples = settingsExamples(POSTGRES, pgbouncerGuide);
		assert.equal(examples.length, 1);
		const sources = sdkExamples("openPostgresDatabase", pgbouncerGuide);
		assertTwins(sources, "openPostgresDatabase", examples, "password");
		await withPostgresDatabase(async ({ url }) => {
			await openSettingsExamples(examples, url, postgresTestPassword ?? "", postgresAdapter, async (database) => {
				assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
			});
			for (const source of sources) {
				const database = await openPostgresDatabase({
					...(onTestDatabase(sdkOptions(source, "openPostgresDatabase"), url) as { url: string }),
					...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
				});
				try {
					assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
				} finally {
					await database.close();
				}
			}
		});
	});

	test("every SQL query in the tuning section and the PgBouncer guide's monitoring query runs", async () => {
		const statements = [
			...blocks("sql"),
			...blocks("sql", pgbouncerGuide).filter((sql) => sql.includes("pg_stat_activity")),
		]
			.flatMap((text) => text.split(";"))
			.map((statement) => statement.replace(/--.*$/gm, "").trim())
			.filter((statement) => statement !== "");
		assert.ok(statements.length >= 7, String(statements.length));
		await withPostgresDatabase(async ({ open, name }) => {
			const database = await open();
			for (const statement of statements) await database.all(statement.replaceAll("'atomic'", `'${name}'`));
		});
	});
});

describe.skipIf(libsqlTestUrl === undefined)("storage guide libSQL tuning examples (#6560)", () => {
	test("every libSQL settings.json and SDK example opens with its options", async () => {
		const examples = settingsExamples(LIBSQL);
		assert.equal(examples.length, 1);
		const url = libsqlTestUrl!;
		await openSettingsExamples(examples, url, "", libsqlAdapter, async (database) => {
			assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
		});
		const sources = sdkExamples("openLibsqlDatabase");
		assertTwins(sources, "openLibsqlDatabase", examples, "authToken");
		for (const source of sources) {
			const database = await openLibsqlDatabase(
				onTestDatabase(sdkOptions(source, "openLibsqlDatabase"), url) as never,
			);
			try {
				assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
			} finally {
				await database.close();
			}
		}
	});
});
