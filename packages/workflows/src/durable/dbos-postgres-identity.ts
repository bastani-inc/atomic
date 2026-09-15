import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { endianness } from "node:os";
import { join } from "node:path";
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
	started: string;
	system_identifier: string;
}
export type PostgresIdentityProbe = (port: number) => Promise<PostgresIdentityRow | undefined>;

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
		const result = await client.query<PostgresIdentityRow>(`SELECT current_setting('data_directory') AS data_dir,
			inet_server_port() AS port, host(inet_server_addr()) AS host,
			floor(extract(epoch FROM pg_postmaster_start_time()))::text AS started,
			system_identifier::text FROM pg_control_system()`);
		return result.rows[0];
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (
			code === "ECONNREFUSED" ||
			code === "57P03" ||
			(error instanceof Error && /timeout|timed out/i.test(error.message))
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
	if (before.port !== port || (expectedPid !== undefined && before.pid !== expectedPid)) {
		throw new Error("Managed Postgres process/port identity mismatch.");
	}
	const row = await probe(port);
	if (!row) return undefined;
	if (
		realpathSync(row.data_dir) !== metadata.dataDir ||
		row.port !== port ||
		row.host !== "127.0.0.1" ||
		Number(row.started) !== before.started ||
		row.system_identifier !== before.systemIdentifier ||
		JSON.stringify(managedPostmaster(metadata)) !== JSON.stringify(before)
	) {
		throw new Error(
			"Managed Postgres SQL/data/process identity mismatch. Preserve the cluster and ownership records.",
		);
	}
	return before;
}
