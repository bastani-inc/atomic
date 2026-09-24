import assert from "node:assert/strict";
import { chmod, lstat, readdir } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
	bunExecutable,
	decodeStream,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
} from "./runtime.js";

const RPC_TIMEOUT_MS = 45_000;
const CLEANUP_TIMEOUT_MS = 20_000;
async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
export async function reserveListener() {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.end("owned non-PostgreSQL sentinel\n");
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return {
		port: address.port,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				// Protocol failure can leave unread startup bytes on a half-closed socket.
				// server.close alone waits forever; only destroy connections we accepted.
				for (const socket of sockets) socket.destroy();
			}),
	};
}
export interface ManagedResult {
	url: string;
	metadata: {
		clusterId: string;
		directoryIdentity: string;
		server: { pid: number; port: number; systemIdentifier: string };
	};
}
export class RealPostgresClient {
	private readonly child: SpawnedProcess;
	private sequence = 0;
	private readonly pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
	private readonly output: Promise<void>;
	private readonly errors: Promise<string>;
	constructor(
		readonly home: string,
		port: number,
		extra: Record<string, string> = {},
		fixture = "real-postgres-client.ts",
	) {
		assert.notEqual(process.getuid?.(), 0, "Run disposable managed cluster tests as an unprivileged account");
		this.child = spawnProcess([bunExecutable(), join(moduleDir(import.meta.url), "../fixtures", fixture)], {
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				ATOMIC_FAULT_TEST_HOME: home,
				ATOMIC_POSTGRES_PORT: String(port),
				DBOS_SYSTEM_DATABASE_URL: undefined,
				ATOMIC_POSTGRES_RUNTIME_DIR: undefined,
				...extra,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.errors = readStreamText(this.child.stderr);
		this.output = this.drain();
	}
	private async drain() {
		const reader = decodeStream(this.child.stdout!).getReader();
		let buffer = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += value;
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (!line.startsWith('{"id":')) continue;
					const message = JSON.parse(line) as { id: number; result: never; error?: string };
					const request = this.pending.get(message.id);
					if (message.error) request?.reject(new Error(message.error));
					else request?.resolve(message.result);
				}
			}
		} finally {
			for (const request of this.pending.values())
				request.reject(new Error(`Postgres fixture exited: ${await this.errors}`));
		}
	}
	async request<T = object>(command: string, sql?: string, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
		const id = ++this.sequence;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await new Promise<T>((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				timer = setTimeout(
					() => reject(new Error(`Postgres fixture ${command} exceeded ${timeoutMs}ms`)),
					timeoutMs,
				);
				this.child.stdin!.write(`${JSON.stringify({ id, command, sql })}\n`);
			});
		} finally {
			clearTimeout(timer);
			this.pending.delete(id);
		}
	}
	async exit() {
		try {
			if (this.child.exitCode === null) await this.request("exit", undefined, CLEANUP_TIMEOUT_MS);
			// An exit acknowledgement precedes process.exit; allow graceful termination.
			await bounded(this.child.exited, 5000, "Postgres fixture graceful exit");
		} finally {
			if (this.child.exitCode === null) this.child.kill("SIGKILL");
			await bounded(Promise.all([this.child.exited, this.output]), 5000, "Postgres fixture process cleanup");
		}
	}
}
async function makeRuntimeRemovable(path: string): Promise<void> {
	const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!entry || entry.isSymbolicLink()) return;
	await chmod(path, entry.isDirectory() ? 0o700 : 0o600);
	if (entry.isDirectory()) {
		for (const name of await readdir(path)) await makeRuntimeRemovable(join(path, name));
	}
}

export class RealPostgresHome {
	readonly path = makeTempDirectory("atomic-real-postgres-");
	readonly clients: RealPostgresClient[] = [];
	client(port: number, extra?: Record<string, string>, fixture?: string) {
		const client = new RealPostgresClient(this.path, port, extra, fixture);
		this.clients.push(client);
		return client;
	}
	async cleanup() {
		// Detach observers before stopping the server so health polling cannot restart it during cleanup.
		const errors: Error[] = [];
		const exits = await Promise.allSettled(this.clients.map((client) => client.exit()));
		for (const result of exits) {
			if (result.status === "rejected")
				errors.push(new Error("Postgres fixture exit failed", { cause: result.reason }));
		}
		// This client never provisions or starts a health observer.
		const cleanup = this.client(5439);
		try {
			await cleanup.request("stop", undefined, CLEANUP_TIMEOUT_MS);
		} catch (error) {
			errors.push(new Error("Postgres fixture stop failed", { cause: error }));
		}
		const stopped = await Promise.allSettled([cleanup.exit()]);
		for (const result of stopped) {
			if (result.status === "rejected")
				errors.push(new Error("Postgres cleanup client exit failed", { cause: result.reason }));
		}
		if (errors.length) {
			throw new AggregateError(errors, `Postgres fixture cleanup failed; preserved ${this.path}`);
		}
		await makeRuntimeRemovable(join(this.path, ".atomic", "postgres", "pg-runtime"));
		removeTempDirectory(this.path);
	}
}
