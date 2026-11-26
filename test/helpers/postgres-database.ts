import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { openPostgresDatabase, type PostgresDatabaseOptions } from "../../packages/storage-postgres/postgres.js";

/**
 * The server the Postgres tests run against: `ATOMIC_TEST_POSTGRES_URL` (a URL without a password) and
 * `ATOMIC_TEST_POSTGRES_PASSWORD`. Without the URL the tests are skipped, unless
 * `ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED=1` (CI's storage conformance job) makes that a failure.
 */
export const postgresTestUrl = process.env.ATOMIC_TEST_POSTGRES_URL || undefined;
export const postgresTestPassword = passwordOutsideCheckout(process.env.ATOMIC_TEST_POSTGRES_PASSWORD);

/**
 * `password`, refused when it is part of this checkout's path. Atomic removes a database's password from every error
 * message and stack it reports, and these stacks name files in the checkout. So with a password such as `atomic` and a
 * checkout under `~/projects/atomic`, an error comes back as a redacted copy, and the tests that check they get the very
 * error they raised fail for no fault in the code.
 */
function passwordOutsideCheckout(password: string | undefined): string | undefined {
	if (!password) return password;
	const checkout = fileURLToPath(new URL("../..", import.meta.url));
	for (const path of [checkout, realpathSync(checkout)])
		if (path.includes(password))
			throw new Error(
				`ATOMIC_TEST_POSTGRES_PASSWORD is part of this checkout's path (${path}). Atomic redacts the password from the stacks of the errors it reports, which name files in the checkout, so tests that compare errors would fail. Give the test server another password.`,
			);
	return password;
}

if (postgresTestUrl === undefined && process.env.ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED === "1")
	throw new Error("ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED=1 but ATOMIC_TEST_POSTGRES_URL is not set");

/** Why the Postgres tests do not run here, or undefined when they do. */
export const postgresSkipReason = postgresTestUrl === undefined ? "ATOMIC_TEST_POSTGRES_URL is not set" : undefined;

function requiredUrl(): string {
	if (postgresTestUrl === undefined) throw new Error(postgresSkipReason);
	return postgresTestUrl;
}

/** The test server's URL with its database replaced by `database`. */
export function postgresUrlFor(database: string): string {
	const url = new URL(requiredUrl());
	url.pathname = `/${database}`;
	return url.href;
}

/** Opens the test server's maintenance database, as the administrator. */
export function openPostgresAdmin(options: Partial<PostgresDatabaseOptions> = {}): Promise<SqliteDatabase> {
	return openPostgresDatabase({
		url: requiredUrl(),
		...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
		...options,
	});
}

export interface PostgresScope {
	/** The isolated database's name. */
	readonly name: string;
	readonly url: string;
	/** Opens another facade on the isolated database, closed when the scope ends. */
	open(options?: Partial<PostgresDatabaseOptions>): Promise<SqliteDatabase>;
	/** A facade on the maintenance database. */
	readonly admin: SqliteDatabase;
}

/** Runs `body` against a database of its own, dropped afterwards with every facade it opened. */
export async function withPostgresDatabase<T>(body: (scope: PostgresScope) => Promise<T>): Promise<T> {
	const admin = await openPostgresAdmin();
	const name = `atomic_p2_${randomUUID().replaceAll("-", "")}`;
	const url = postgresUrlFor(name);
	const opened: SqliteDatabase[] = [];
	await admin.exec(`CREATE DATABASE ${name}`);
	try {
		return await body({
			name,
			url,
			admin,
			async open(options = {}) {
				const database = await openPostgresDatabase({
					url,
					...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
					...options,
				});
				opened.push(database);
				return database;
			},
		});
	} finally {
		await Promise.allSettled(opened.map((database) => database.close()));
		await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
		await admin.close();
	}
}

/** This checkout's PostgreSQL adapter by path, so a process the test starts never resolves a published copy. */
export const postgresAdapterPath = fileURLToPath(
	new URL("../../packages/storage-postgres/postgres.js", import.meta.url),
);

/** A database of its own on the test server, for processes to share until `drop`. */
export async function createPostgresDatabase(): Promise<{ readonly url: string; drop(): Promise<void> }> {
	const admin = await openPostgresAdmin();
	const name = `atomic_p2_${randomUUID().replaceAll("-", "")}`;
	try {
		await admin.exec(`CREATE DATABASE ${name}`);
	} catch (error) {
		await admin.close();
		throw error;
	}
	return {
		url: postgresUrlFor(name),
		async drop() {
			try {
				await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
			} finally {
				await admin.close();
			}
		},
	};
}

/**
 * The `ATOMIC_STORAGE` value that opens `url` through this checkout's adapter. The password is read from
 * `ATOMIC_TEST_POSTGRES_PASSWORD` in the process that opens it, never written into the selection.
 */
export function postgresStorageSelection(url: string): string {
	return JSON.stringify({
		adapter: postgresAdapterPath,
		options: { url },
		...(postgresTestPassword === undefined
			? {}
			: { secrets: { password: { env: "ATOMIC_TEST_POSTGRES_PASSWORD" } } }),
	});
}
