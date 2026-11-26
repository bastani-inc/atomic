/**
 * A running process of an earlier release, updated in place to this build, forks a session (#6560): the session store
 * it loads on demand comes from the update, while the storage modules it loaded as it started (the migrations, the
 * schema catalog, the snapshot blob store) stay the release's. Its forks must share their parent's history and read
 * correctly, on a new database and on one the release set up, on SQLite and on PostgreSQL
 * (`scripts/in-place-update-e2e.mjs`). 0.10.11-alpha.1 is the last release without shared-history forks whose storage
 * modules know the schema catalog; 0.10.10 the stable release before it.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, test } from "vitest";
import { type ForkDatabase, forkAfterUpdate } from "../../scripts/in-place-update-e2e.mjs";
import { moduleDir, npmSpawnPrefix, removePath, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = join(moduleDir(import.meta.url), "..", "..");
/** Packing the seven packages of the build: structural. */
const PACK_TIMEOUT_MS = 300_000;
/** Installing a published release from npm, starting a process of it, updating it and removing it: structural. */
const UPDATE_TIMEOUT_MS = 300_000;
/** Removing the packed build and what an interrupted update left: a directory of thousands of files on Windows. */
const CLEANUP_TIMEOUT_MS = 120_000;
const RELEASES = ["0.10.11-alpha.1", "0.10.10"];

const postgresUrl = process.env.ATOMIC_TEST_POSTGRES_URL || undefined;
const postgresPassword = process.env.ATOMIC_TEST_POSTGRES_PASSWORD;
if (postgresUrl === undefined && process.env.ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED === "1")
	throw new Error("ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED=1 but ATOMIC_TEST_POSTGRES_URL is not set");

let work = "";
let tarballs = "";
beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), "atomic-in-place-update-forks-"));
	tarballs = mkdtempSync(join(work, "build-"));
	const packed = spawnSyncCollect(
		[
			...npmSpawnPrefix(),
			"pack",
			...[
				"@bastani/atomic",
				"@bastani/atomic-ai",
				"@bastani/atomic-agent-core",
				"@bastani/atomic-codemode",
				"@bastani/atomic-schema",
				"@bastani/atomic-telemetry",
				"@bastani/atomic-tui",
			].map((name) => `--workspace=${name}`),
			"--ignore-scripts",
			"--pack-destination",
			tarballs,
		],
		{ cwd: ROOT, timeout: PACK_TIMEOUT_MS },
	);
	assert.equal(packed.exitCode, 0, packed.stderr.toString());
}, PACK_TIMEOUT_MS);

afterAll(async () => {
	if (work !== "") await removePath(work, { recursive: true, force: true, maxRetries: 10 });
}, CLEANUP_TIMEOUT_MS);

/** Runs `body` with two empty PostgreSQL databases on the test server, which it drops after. */
async function withPostgresDatabases(body: (urls: readonly [string, string]) => Promise<void>): Promise<void> {
	// pg takes the password from the URL, where the adapter refuses one.
	const adminUrl = new URL(postgresUrl!);
	if (postgresPassword !== undefined) adminUrl.password = postgresPassword;
	const admin = new pg.Client({ connectionString: adminUrl.href });
	await admin.connect();
	const names = [0, 1].map(() => `atomic_forks_${randomBytes(6).toString("hex")}`);
	try {
		for (const name of names) await admin.query(`CREATE DATABASE ${name}`);
		const urls = names.map((name) => {
			const url = new URL(postgresUrl!);
			url.pathname = `/${name}`;
			return url.href;
		});
		await body([urls[0]!, urls[1]!]);
	} finally {
		try {
			for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
		} finally {
			await admin.end();
		}
	}
}

describe.each(RELEASES)("a running process of %s, updated in place to this build, forks a session", (version) => {
	test(
		"on SQLite, in a new database and in one the release set up",
		async () => {
			const files = mkdtempSync(join(work, "sqlite-"));
			const databases: ForkDatabase[] = [
				{ name: "a new SQLite database", kind: "sqlite", path: join(files, "new.sqlite"), earlier: false },
				{
					name: "a SQLite database the release set up",
					kind: "sqlite",
					path: join(files, "earlier.sqlite"),
					earlier: true,
				},
			];
			assert.deepEqual(await forkAfterUpdate(version, tarballs, work, databases), []);
		},
		UPDATE_TIMEOUT_MS,
	);

	test.skipIf(postgresUrl === undefined)(
		"on PostgreSQL, in a new database and in one the release set up",
		() =>
			withPostgresDatabases(async ([fresh, earlier]) => {
				const password = postgresPassword === undefined ? {} : { password: postgresPassword };
				const databases: ForkDatabase[] = [
					{ name: "a new PostgreSQL database", kind: "postgres", url: fresh, earlier: false, ...password },
					{
						name: "a PostgreSQL database the release set up",
						kind: "postgres",
						url: earlier,
						earlier: true,
						...password,
					},
				];
				assert.deepEqual(await forkAfterUpdate(version, tarballs, work, databases), []);
			}),
		UPDATE_TIMEOUT_MS,
	);
});
