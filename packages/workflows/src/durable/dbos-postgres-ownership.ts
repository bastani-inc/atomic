import { randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { endianness } from "node:os";
import { join } from "node:path";

export interface ManagedPostgresServer {
	readonly port: number;
	readonly pid: number;
	readonly started: number;
	readonly systemIdentifier: string;
}

export interface ManagedPostgresMetadata {
	readonly version: 1;
	readonly clusterId: string;
	readonly dataDir: string;
	readonly directoryIdentity: string;
	readonly major: number;
	readonly server?: ManagedPostgresServer;
}

export interface PostgresConsumer {
	readonly clusterId: string;
	readonly token: string;
	readonly pid: number;
	readonly runtime: string;
}

export interface PostgresConsumerLease {
	readonly record: PostgresConsumer;
	release(): void;
}

function trustedPath(path: string, directory = false): void {
	const stat = lstatSync(path);
	if (
		!(directory ? stat.isDirectory() : stat.isFile()) ||
		(process.getuid !== undefined && stat.uid !== process.getuid()) ||
		(process.platform !== "win32" && (stat.mode & 0o022) !== 0)
	) {
		throw new Error(`Untrusted managed Postgres ownership path: ${path}`);
	}
}

export function postgresOwnershipDirectory(baseDir: string, major: number): string {
	return join(baseDir, `v${major}.shared`);
}

/** PostgreSQL's ControlFileData starts with the native-endian uint64 system identifier. */
export function controlFileSystemIdentifier(dataDir: string): string {
	const controlPath = join(dataDir, "global", "pg_control");
	if (!lstatSync(controlPath).isFile()) throw new Error("Untrusted managed Postgres control file.");
	const control = readFileSync(controlPath);
	return (endianness() === "LE" ? control.readBigUInt64LE(0) : control.readBigUInt64BE(0)).toString();
}

const directoryInode = (identity: string) => /^\d+:(\d+)$/.exec(identity)?.[1];

/**
 * Names the ownership fields that differ. The device half of `directoryIdentity` is not compared:
 * APFS assigns device numbers per boot, so only the inode identifies the directory across reboots.
 */
export function managedPostgresIdentityMismatches(
	expected: ManagedPostgresMetadata,
	current: ManagedPostgresMetadata,
	compareSystemIdentifier = true,
): string[] {
	const inode = directoryInode(expected.directoryIdentity);
	return [
		current.clusterId !== expected.clusterId && "clusterId",
		current.dataDir !== expected.dataDir && "dataDir",
		(inode === undefined || inode !== directoryInode(current.directoryIdentity)) && "inode",
		current.major !== expected.major && "major",
		compareSystemIdentifier &&
			current.server?.systemIdentifier !== expected.server?.systemIdentifier &&
			"systemIdentifier",
	].filter((field): field is string => field !== false);
}

/**
 * Never rewrites identity or initializes data. A record whose directory differs only by device
 * number is returned with the current identity; the setup-lock holder persists it on publish.
 */
export function managedPostgresMetadata(baseDir: string, major: number, create: boolean): ManagedPostgresMetadata {
	if (!lstatSync(join(baseDir, `v${major}`)).isDirectory()) {
		throw new Error("Managed Postgres data must be a real directory, not a link.");
	}
	const dataDir = realpathSync(join(baseDir, `v${major}`));
	const stat = lstatSync(dataDir, { bigint: true });
	if (!stat.isDirectory() || readFileSync(join(dataDir, "PG_VERSION"), "utf8").trim() !== String(major)) {
		throw new Error(`Managed Postgres data directory does not match major ${major}: ${dataDir}`);
	}
	const directoryIdentity = `${stat.dev}:${stat.ino}`;
	const registry = postgresOwnershipDirectory(baseDir, major);
	if (create) mkdirSync(registry, { mode: 0o700 });
	trustedPath(registry, true);
	const path = join(registry, "cluster.json");
	if (create) {
		const record: ManagedPostgresMetadata = {
			version: 1,
			clusterId: randomUUID(),
			dataDir,
			directoryIdentity,
			major,
		};
		const temporary = join(registry, `.cluster-${record.clusterId}`);
		try {
			writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600, flush: true });
			renameSync(temporary, path);
		} finally {
			rmSync(temporary, { force: true });
		}
	}
	trustedPath(path);
	const record = JSON.parse(readFileSync(path, "utf8")) as ManagedPostgresMetadata | null;
	const mismatches = [
		...(record?.version !== 1 ? ["version"] : []),
		...(typeof record?.clusterId !== "string" || !/^[0-9a-f-]{36}$/.test(record.clusterId) ? ["clusterId"] : []),
		...(record?.dataDir !== dataDir ? ["dataDir"] : []),
		...(typeof record?.directoryIdentity !== "string" || directoryInode(record.directoryIdentity) !== String(stat.ino)
			? ["inode"]
			: []),
		...(record?.major !== major ? ["major"] : []),
		...(record?.server !== undefined &&
		(!Number.isInteger(record.server?.port) ||
			record.server.port < 1 ||
			record.server.port > 65535 ||
			!Number.isSafeInteger(record.server.pid) ||
			record.server.pid <= 0 ||
			!Number.isSafeInteger(record.server.started) ||
			record.server.started <= 0 ||
			!/^\d+$/.test(record.server.systemIdentifier))
			? ["server"]
			: []),
	];
	const mismatch = (fields: readonly string[]) =>
		new Error(
			`Managed Postgres cluster identity mismatch (${fields.join(", ")}): ${path}. Preserve the data and ownership records.`,
		);
	if (record === null || mismatches.length > 0) throw mismatch(mismatches);
	if (record.directoryIdentity === directoryIdentity) return record;
	const control = record.server && controlSystemIdentifierIfReadable(dataDir);
	if (control !== undefined && control !== record.server?.systemIdentifier) throw mismatch(["systemIdentifier"]);
	return { ...record, directoryIdentity };
}

function controlSystemIdentifierIfReadable(dataDir: string): string | undefined {
	try {
		return controlFileSystemIdentifier(dataDir);
	} catch {
		return undefined;
	}
}

/** Publish only under the setup lock, after SQL and local identity agree. */
export function publishPostgresServer(
	baseDir: string,
	metadata: ManagedPostgresMetadata,
	server: ManagedPostgresServer,
): void {
	const current = managedPostgresMetadata(baseDir, metadata.major, false);
	if (current.clusterId !== metadata.clusterId) throw new Error("Managed Postgres cluster identity changed.");
	const path = join(postgresOwnershipDirectory(baseDir, metadata.major), "cluster.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify({ ...current, server }), { flag: "wx", mode: 0o600, flush: true });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Lifetime leases do not expire by age: a stalled event loop is still a consumer. */
export function acquirePostgresConsumer(
	baseDir: string,
	metadata: ManagedPostgresMetadata,
	runtime: string,
): PostgresConsumerLease {
	const registry = postgresOwnershipDirectory(baseDir, metadata.major);
	trustedPath(registry, true);
	const record: PostgresConsumer = { clusterId: metadata.clusterId, token: randomUUID(), pid: process.pid, runtime };
	const path = join(registry, `${record.token}.consumer`);
	const contents = JSON.stringify(record);
	writeFileSync(path, contents, { flag: "wx", mode: 0o600, flush: true });
	return {
		record,
		release() {
			try {
				trustedPath(path);
				// A displaced lease cannot delete a replacement, even in the same PID.
				if (readFileSync(path, "utf8") === contents) rmSync(path);
			} catch {
				// Missing or uncertain ownership is retained, never swept on shutdown.
			}
		},
	};
}

/** Only ESRCH proves abandonment. PID reuse/EPERM retain the record conservatively. */
export function inspectPostgresConsumers(
	baseDir: string,
	metadata: ManagedPostgresMetadata,
	isProcessAlive: (pid: number) => boolean = processIsAlive,
	prune = true,
): readonly PostgresConsumer[] {
	const registry = postgresOwnershipDirectory(baseDir, metadata.major);
	trustedPath(registry, true);
	const consumers: PostgresConsumer[] = [];
	for (const name of readdirSync(registry)) {
		if (!name.endsWith(".consumer")) continue;
		const path = join(registry, name);
		try {
			trustedPath(path);
			const contents = readFileSync(path, "utf8");
			const record = JSON.parse(contents) as PostgresConsumer | null;
			if (
				record?.clusterId !== metadata.clusterId ||
				typeof record.token !== "string" ||
				name !== `${record.token}.consumer` ||
				!Number.isSafeInteger(record.pid) ||
				record.pid <= 0 ||
				typeof record.runtime !== "string"
			) {
				throw new Error(`Invalid managed Postgres consumer record: ${path}`);
			}
			if (isProcessAlive(record.pid)) consumers.push(record);
			else if (prune && readFileSync(path, "utf8") === contents) rmSync(path);
		} catch (error) {
			// Orderly exit can unlink a consumer after directory enumeration.
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	return consumers;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}
/** Local identity evidence only; never convert a pidfile into signal authority. */
export function assertManagedPostmaster(metadata: ManagedPostgresMetadata, port: number): void {
	const [pid, dataDir, started, actualPort] = readFileSync(join(metadata.dataDir, "postmaster.pid"), "utf8").split(
		/\r?\n/,
	);
	if (
		!Number.isSafeInteger(Number(pid)) ||
		Number(pid) <= 0 ||
		dataDir === undefined ||
		realpathSync(dataDir) !== metadata.dataDir ||
		!Number.isFinite(Number(started)) ||
		Number(started) <= 0 ||
		Number(actualPort) !== port ||
		!processIsAlive(Number(pid))
	) {
		throw new Error("Managed Postgres postmaster identity does not match the shared data directory and port.");
	}
}
