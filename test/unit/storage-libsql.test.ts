import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { describe, it, test } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
import { openLibsqlDatabase } from "../fixtures/storage-libsql-wrapper.js";
import { removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { withLibsqlDatabase } from "../helpers/libsql-database.js";
import {
	bunExecutable,
	fileExistsSync,
	makeTempDirectory,
	moduleDir,
	readDirectorySync,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

registerSqliteDatabaseConformance({ describe, it }, "libSQL file", withLibsqlDatabase);

test("libSQL preserves SQL column labels that collide with driver row metadata", async () => {
	await withLibsqlDatabase(async ({ database }) => {
		const sql = 'SELECT 1 AS "0", 2 AS "length", 3 AS "__proto__", 4 AS "constructor"';
		const expected = Object.fromEntries([
			["0", 1],
			["length", 2],
			["__proto__", 3],
			["constructor", 4],
		]);
		assert.deepEqual(await database.get(sql), expected);
		assert.deepEqual(await database.all(sql), [expected]);
		await database.transaction(async (transaction) => {
			assert.deepEqual(await transaction.get(sql), expected);
			assert.deepEqual(await transaction.all(sql), [expected]);
		});
	});
});

for (const scenario of ["local file", "unsupported query", "malformed URL"]) {
	test(`libSQL redacts every encoded duplicate authToken in ${scenario} diagnostics`, async () => {
		const directory = makeTempDirectory("atomic-libsql-credentials-");
		const query = "%61uthToken=fixture%2Dfirst-token&%61uthToken=fixture%2Fsecond+token";
		const base =
			scenario === "local file"
				? pathToFileURL(join(directory, "database.sqlite")).href
				: scenario === "unsupported query"
					? "libsql://example.invalid/database"
					: "not a url";
		const url = `${base}?${query}${scenario === "unsupported query" ? "&unsupported=1" : ""}`;
		const options = { url, authToken: "fixture-option-token" };
		const expected = url
			.replace("fixture%2Dfirst-token", "[redacted]")
			.replace("fixture%2Fsecond+token", "[redacted]");
		const assertSecretFree = (rendered: string) => {
			for (const secret of [
				"fixture%2Dfirst-token",
				"fixture-first-token",
				"fixture%2Fsecond+token",
				"fixture/second token",
				options.authToken,
			]) {
				assert.equal(rendered.includes(secret), false);
			}
		};
		try {
			if (scenario === "local file") {
				const database = await openLibsqlDatabase(options);
				try {
					assert.equal(database.descriptor.location, expected);
					assertSecretFree(inspect(database.descriptor));
					assert.deepEqual(await database.get("SELECT 1 AS value"), { value: 1 });
				} finally {
					await database.close();
				}
			} else {
				await assert.rejects(openLibsqlDatabase(options), (error: Error) => {
					assert.ok(error instanceof StorageUnavailableError);
					assert.equal(error.adapter, "libsql");
					assert.equal(error.location, expected);
					assertSecretFree(inspect(error, { depth: null }));
					return true;
				});
			}
			assert.deepEqual(options, { url, authToken: "fixture-option-token" });
		} finally {
			await removeLibsqlDirectory(directory);
		}
	});
}

const REAL_BUN_CONFORMANCE_TIMEOUT_MS = 120_000;
test(
	"libSQL facade and SQL session conformance pass on Bun",
	() => {
		const directory = makeTempDirectory("atomic-libsql-bun-");
		try {
			// The synchronous spawn returns only after the child exits and releases its native file handles.
			const result = spawnSyncCollect(
				[bunExecutable(), "test", join(moduleDir(import.meta.url), "../fixtures/storage-libsql.bun.ts")],
				{ env: { ...process.env, ATOMIC_TEST_LIBSQL_ROOT: directory } },
			);
			assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
			assert.ok(readDirectorySync(directory).length > 0, "child must create its databases under the owned root");
		} finally {
			assert.doesNotThrow(() => removeTempDirectory(directory));
			assert.equal(fileExistsSync(directory), false);
		}
	},
	REAL_BUN_CONFORMANCE_TIMEOUT_MS,
);

test("the built package has no bundled custom driver or adapter export", () => {
	const result = spawnSyncCollect(
		[
			process.execPath,
			"--input-type=module",
			"-e",
			`
		import assert from 'node:assert/strict';
		import { registerHooks } from 'node:module';
		class DriverBlockedError extends Error {}
		const failure = new DriverBlockedError('driver blocked by fixture');
		let loads = 0;
		registerHooks({ resolve(specifier, context, next) {
			if (specifier === '@libsql/client' || specifier === 'libsql') {
				loads++;
				throw failure;
			}
			return next(specifier, context);
		}});
		const main = await import('@bastani/atomic');
		const storage = await import('@bastani/atomic/storage');
		assert.equal(loads, 0);
		assert.equal('openLibsqlDatabase' in main, false);
		assert.equal('openLibsqlDatabase' in storage, false);
		`,
		],
		{ cwd: join(moduleDir(import.meta.url), "../../packages/coding-agent") },
	);
	assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
	assert.equal(result.stdout.toString(), "");
	assert.equal(result.stderr.toString(), "");
});
