import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { endianness } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Client } from "pg";
import {
	assertManagedPostmaster,
	type ManagedPostgresMetadata,
	type ManagedPostgresServer,
} from "./dbos-postgres-ownership.js";

export function preferredPostgresPort(value = process.env.ATOMIC_POSTGRES_PORT): number {
	if (value === undefined) return 5439;
	if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
		throw new Error("ATOMIC_POSTGRES_PORT must be an integer between 1 and 65535.");
	}
	return Number(value);
}

/** Binding is only a probe, not a reservation. The elected starter must handle races. */
export function availablePostgresPort(preferred: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", (error: NodeJS.ErrnoException) => {
			if (preferred !== 0 && error.code === "EADDRINUSE") availablePostgresPort(0).then(resolve, reject);
			else reject(error);
		});
		server.listen({ host: "127.0.0.1", port: preferred, exclusive: true }, () => {
			const address = server.address();
			server.close((error) => {
				if (error) reject(error);
				else if (address && typeof address !== "string") resolve(address.port);
				else reject(new Error("No managed Postgres loopback port available."));
			});
		});
	});
}

/** PostgreSQL resolves timezone data relative to its launch executable, not PGDATA. */
export function managedPostgresRuntimeHealthy(
	metadata: ManagedPostgresMetadata,
	port = metadata.server?.port,
): boolean {
	return postgresRuntimeFilesExist(managedPostgresLaunchExecutable(metadata, port));
}

export function managedPostgresLaunchExecutable(
	metadata: ManagedPostgresMetadata,
	port = metadata.server?.port,
): string {
	const optsPath = join(metadata.dataDir, "postmaster.opts");
	if (!lstatSync(optsPath).isFile()) throw new Error("Managed Postgres launch options are missing or untrusted.");
	const launch =
		/^(.*[\\/]postgres(?:\.exe)?) "-D" "([^"]+)" "-p" "(\d+)" "-c" "listen_addresses=127\.0\.0\.1"\s*$/.exec(
			readFileSync(optsPath, "utf8"),
		);
	if (!launch || !isAbsolute(launch[1]) || !isAbsolute(launch[2])) {
		throw new Error("Managed Postgres launch options do not identify Atomic's PostgreSQL runtime.");
	}
	if (realpathSync(launch[2]) !== metadata.dataDir || (port !== undefined && Number(launch[3]) !== port)) {
		throw new Error("Managed Postgres launch options do not match its owned data directory and port.");
	}
	return launch[1];
}

export function postgresRuntimeFilesExist(postgres: string): boolean {
	const native = dirname(dirname(postgres));
	const timezoneSets = join(native, "share", ...(postgres.endsWith(".exe") ? [] : ["postgresql"]), "timezonesets");
	return (
		lstatSync(postgres, { throwIfNoEntry: false })?.isFile() === true &&
		lstatSync(timezoneSets, { throwIfNoEntry: false })?.isDirectory() === true &&
		lstatSync(join(timezoneSets, "Default"), { throwIfNoEntry: false })?.isFile() === true
	);
}

/** A pidfile is evidence, never permission to signal a process. */
export function managedPostmaster(metadata: ManagedPostgresMetadata): ManagedPostgresServer | undefined {
	const systemIdentifier = managedSystemIdentifier(metadata);
	const path = join(metadata.dataDir, "postmaster.pid");
	if (!existsSync(path)) return undefined;
	if (!lstatSync(path).isFile()) throw new Error("Untrusted managed Postgres postmaster file.");
	const [pidText, , startedText, portText] = readFileSync(path, "utf8").split(/\r?\n/);
	const pid = Number(pidText),
		started = Number(startedText),
		port = Number(portText);
	if (
		!Number.isSafeInteger(pid) ||
		pid <= 0 ||
		!Number.isSafeInteger(started) ||
		started <= 0 ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	)
		throw new Error("Invalid managed Postgres postmaster identity.");
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return undefined;
		throw error;
	}
	assertManagedPostmaster(metadata, port);
	return { pid, started, port, systemIdentifier };
}

function managedSystemIdentifier(metadata: ManagedPostgresMetadata): string {
	const controlPath = join(metadata.dataDir, "global", "pg_control");
	if (!lstatSync(controlPath).isFile()) throw new Error("Untrusted managed Postgres control file.");
	const control = readFileSync(controlPath);
	// PostgreSQL's ControlFileData starts with the native-endian uint64 system identifier.
	const systemIdentifier = (
		endianness() === "LE" ? control.readBigUInt64LE(0) : control.readBigUInt64BE(0)
	).toString();
	if (metadata.server && metadata.server.systemIdentifier !== systemIdentifier) {
		throw new Error("Managed Postgres system identity mismatch. Preserve the existing data.");
	}
	return systemIdentifier;
}

export interface PostgresIdentityRow {
	data_dir: string;
	port: number;
	host: string;
	/** MyStartTime from the server's postmaster.pid, not the separately sampled PgStartTime. */
	started: string;
	system_identifier: string;
	server_version?: string;
}
export type PostgresIdentityProbe = (port: number) => Promise<PostgresIdentityRow | undefined>;

export const POSTGRES_IDENTITY_SQL = `SELECT current_setting('data_directory') AS data_dir,
	inet_server_port() AS port, host(inet_server_addr()) AS host,
	split_part(pg_read_file('postmaster.pid'), E'\\n', 3) AS started,
	system_identifier::text, current_setting('server_version') AS server_version FROM pg_control_system()`;

/** Read-only transaction-local setting that reloads PostgreSQL's timezone-abbreviation file. */
export const POSTGRES_TIMEZONE_SQL = "SELECT set_config('timezone_abbreviations', 'Default', true)";

export async function probePostgresTimezoneData(port: number): Promise<void> {
	const client = new Client({
		host: "127.0.0.1",
		port,
		user: "postgres",
		password: "atomic",
		database: "postgres",
		ssl: false,
		connectionTimeoutMillis: 1000,
		query_timeout: 1000,
		statement_timeout: 1000,
	});
	client.on("error", () => {});
	try {
		await client.connect();
		await client.query(POSTGRES_TIMEZONE_SQL);
	} finally {
		await client.end();
	}
}

export async function probePostgresIdentity(port: number): Promise<PostgresIdentityRow | undefined> {
	const client = new Client({
		host: "127.0.0.1",
		port,
		user: "postgres",
		password: "atomic",
		database: "postgres",
		ssl: false,
		connectionTimeoutMillis: 1000,
		query_timeout: 1000,
		statement_timeout: 1000,
	});
	client.on("error", () => {}); // Connection loss is reported by the pending connect/query.
	try {
		await client.connect();
		const result = await client.query<PostgresIdentityRow>(POSTGRES_IDENTITY_SQL);
		return result.rows[0];
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (
			code === "ECONNREFUSED" ||
			code === "ECONNRESET" ||
			code === "EPIPE" ||
			code === "57P01" ||
			code === "57P02" ||
			code === "57P03" ||
			(error instanceof Error && /timeout|timed out|connection terminated/i.test(error.message))
		)
			return undefined;
		throw error;
	} finally {
		await client.end();
	}
}

export async function verifyPostgresIdentity(
	metadata: ManagedPostgresMetadata,
	port: number,
	expectedPid?: number | null,
	probe: PostgresIdentityProbe = probePostgresIdentity,
): Promise<ManagedPostgresServer | undefined> {
	const before = managedPostmaster(metadata);
	if (!before) return undefined;
	const mismatches: string[] = [];
	const compare = (
		field: string,
		expected: string | number | null | undefined,
		actual: string | number | undefined,
	) => {
		if (expected !== actual)
			mismatches.push(`${field}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
	};
	const rejectMismatch = (kind: string) => {
		if (mismatches.length)
			throw new Error(
				`Managed Postgres ${kind} identity mismatch (${mismatches.join("; ")}). Preserve the cluster and ownership records.`,
			);
	};
	compare("process.port", port, before.port);
	if (expectedPid !== undefined) compare("process.pid", expectedPid, before.pid);
	rejectMismatch("process/port");
	const row = await probe(port);
	if (!row) return undefined;
	compare("sql.data_dir", metadata.dataDir, realpathSync(row.data_dir));
	compare("sql.port", port, row.port);
	compare("sql.host", "127.0.0.1", row.host);
	compare("sql.started", before.started, Number(row.started));
	compare("sql.system_identifier", before.systemIdentifier, row.system_identifier);
	const after = managedPostmaster(metadata);
	for (const field of ["pid", "port", "started", "systemIdentifier"] as const) {
		compare(`process.after.${field}`, before[field], after?.[field]);
	}
	rejectMismatch("SQL/data/process");
	return before;
}
