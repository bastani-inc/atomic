import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import { DbosDependencyError, isDbosDependencyError } from "./dbos-admission.js";
import { databaseError } from "./dbos-admission-pool.js";
import { type DbosRowAuthority, installDbosRowGuard } from "./dbos-row-guard.js";

export type ExecutorLiveness = "alive" | "dead" | "unknown";

interface OwnerWriteContext {
	readonly fence: DbosOwnerFence;
	readonly workflows: ReadonlyMap<string, boolean>;
}

const contextKey = Symbol.for("atomic-workflows/dbos-owner-write-context@1");
const contextBag = globalThis as typeof globalThis & { [contextKey]?: AsyncLocalStorage<OwnerWriteContext> };
contextBag[contextKey] ??= new AsyncLocalStorage<OwnerWriteContext>();
const writeContext = contextBag[contextKey];

const rowContextKey = Symbol.for("atomic-workflows/dbos-row-authority@1");
const rowContextBag = globalThis as typeof globalThis & { [rowContextKey]?: AsyncLocalStorage<DbosRowAuthority> };
rowContextBag[rowContextKey] ??= new AsyncLocalStorage<DbosRowAuthority>();
const rowContext = rowContextBag[rowContextKey];

const CLIENT_TERMINATION_TIMEOUT_MS = 5_000;

function lockKey(identity: string): readonly [number, number] {
	const digest = createHash("sha256").update(`atomic-workflow-fence:${identity}`).digest();
	return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export function isDatabaseExecutor(executorId: string | undefined): executorId is string {
	return /^atomic-db-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(executorId ?? "");
}

export class DbosOwnerFence {
	private lifetime: Promise<PoolClient> | undefined;
	private readonly endedClients = new WeakSet<PoolClient>();
	private readonly protectedClients = new Set<PoolClient>();
	private readonly retirements = new WeakMap<PoolClient, Promise<void>>();
	private readonly terminatingClients = new Set<Promise<void>>();
	private terminationError: Error | undefined;
	private lost = false;
	private closing: Promise<void> | undefined;
	closed = false;
	get invalidated(): boolean {
		return this.lost;
	}

	constructor(
		private readonly pool: () => Pool,
		readonly executorId: string,
		private readonly endPool: () => Promise<void>,
	) {}

	private fail(): DbosDependencyError {
		this.lost = true;
		return new DbosDependencyError(
			"Workflow database unavailable: ownership connection was lost; this execution generation cannot write again",
		);
	}

	private owner(): Promise<PoolClient> {
		if (this.lost) return Promise.reject(this.fail());
		this.lifetime ??= (async () => {
			const client = await this.pool().connect();
			client.on("error", () => {
				this.fail();
			});
			client.on("end", () => {
				this.endedClients.add(client);
				this.fail();
			});
			try {
				await client.query("SELECT set_config('application_name', $1, false)", [`atomic-owner:${this.executorId}`]);
				const held = await client.query<{ held: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS held", [
					...lockKey(this.executorId),
				]);
				if (!held.rows[0]?.held || this.lost) throw this.fail();
				await client.query("SELECT pg_advisory_lock_shared($1, $2)", [...lockKey(this.executorId)]);
				await client.query("SELECT pg_advisory_unlock($1, $2)", [...lockKey(this.executorId)]);
				return client;
			} catch (error) {
				this.fail();
				await this.retireClient(client);
				throw error;
			}
		})().catch((error: Error) => {
			this.fail();
			throw error;
		});
		return this.lifetime;
	}

	async liveness(executorId: string | undefined): Promise<ExecutorLiveness> {
		if (!isDatabaseExecutor(executorId)) return "unknown";
		const client = await this.pool().connect();
		try {
			await client.query("BEGIN");
			const result = await client.query<{ held: boolean }>("SELECT pg_try_advisory_xact_lock($1, $2) AS held", [
				...lockKey(executorId),
			]);
			return result.rows[0]?.held ? "dead" : "alive";
		} finally {
			try {
				await client.query("ROLLBACK");
			} finally {
				client.release();
			}
		}
	}

	async recover<T>(executorId: string | undefined, callback: () => Promise<T>): Promise<T | undefined> {
		if (!isDatabaseExecutor(executorId)) return undefined;
		const client = await this.pool().connect();
		const fail = () => {
			this.fail();
		};
		client.on("error", fail);
		client.on("end", fail);
		try {
			await client.query("BEGIN");
			const result = await client.query<{ held: boolean }>("SELECT pg_try_advisory_xact_lock($1, $2) AS held", [
				...lockKey(executorId),
			]);
			if (!result.rows[0]?.held) return undefined;
			return await callback();
		} finally {
			try {
				await client.query("ROLLBACK");
			} finally {
				client.removeListener("error", fail);
				client.removeListener("end", fail);
				client.release();
			}
		}
	}

	async write<T>(workflowId: string, callback: () => Promise<T>, claim = false): Promise<T> {
		try {
			return await this.writeLocked(workflowId, callback, claim);
		} catch (error) {
			const mapped = databaseError(error);
			throw this.lost && isDbosDependencyError(mapped) ? this.fail() : mapped;
		}
	}

	private async writeLocked<T>(workflowId: string, callback: () => Promise<T>, claim: boolean): Promise<T> {
		const context = writeContext.getStore();
		const active = context?.fence === this ? context.workflows : undefined;
		if (active?.has(workflowId)) {
			if (this.lost) throw this.fail();
			return await callback();
		}
		const owner = await this.owner();
		const client = await this.pool().connect();
		const fail = () => {
			this.fail();
		};
		client.on("error", fail);
		client.on("end", fail);
		try {
			await client.query("BEGIN");
			await client.query("SELECT set_config('application_name', $1, false)", [`atomic-guard:${workflowId}`]);
			await client.query("SET LOCAL statement_timeout = '10000ms'");
			await client.query("SELECT pg_advisory_xact_lock_shared($1, $2)", [...lockKey(this.executorId)]);
			await client.query("SELECT pg_advisory_xact_lock($1, $2)", [...lockKey(`workflow:${workflowId}`)]);
			if (claim) await client.query("SELECT pg_advisory_xact_lock($1, $2)", [...lockKey(`sql:${workflowId}`)]);
			if (this.lost) throw this.fail();
			try {
				await owner.query("SELECT 1");
			} catch {
				throw this.fail();
			}
			if (this.lost) throw this.fail();
			return await writeContext.run(
				{ fence: this, workflows: new Map([...(active ?? []), [workflowId, claim]]) },
				callback,
			);
		} finally {
			try {
				await client.query("ROLLBACK");
			} finally {
				client.removeListener("error", fail);
				client.removeListener("end", fail);
				client.release();
			}
		}
	}

	async withRowAuthority<T>(authority: DbosRowAuthority, callback: () => Promise<T>): Promise<T> {
		return await rowContext.run(authority, callback);
	}

	async compactMetadata(authority: DbosRowAuthority, retainedId: string): Promise<void> {
		if (this.lost) throw this.fail();
		const metadataId = `${authority.root}:checkpoint:__atomic_metadata`;
		if (retainedId !== metadataId && !retainedId.startsWith(`${metadataId}:`))
			throw new Error("Metadata compaction requires a metadata checkpoint");
		const client = await this.pool().connect();
		try {
			await installDbosRowGuard(client);
			await client.query("BEGIN");
			await client.query("SELECT pg_advisory_xact_lock_shared($1, $2)", [...lockKey(this.executorId)]);
			await client.query("SELECT set_config('atomic.row_authority', $1, true)", [JSON.stringify(authority)]);
			if (this.lost) throw this.fail();
			const retained = await client.query(
				"UPDATE dbos.workflow_status SET inputs = NULL WHERE workflow_uuid = $1 AND status = 'SUCCESS' RETURNING workflow_uuid",
				[retainedId],
			);
			if (retained.rowCount !== 1) throw new Error("Latest workflow metadata is unavailable for compaction");
			await client.query(
				"DELETE FROM dbos.workflow_status WHERE (workflow_uuid = $1 OR starts_with(workflow_uuid, $1 || ':')) AND workflow_uuid <> $2",
				[metadataId, retainedId],
			);
			await client.query(
				"DELETE FROM dbos.atomic_guard_rows WHERE root = $1 AND (workflow_uuid = $2 OR starts_with(workflow_uuid, $2 || ':')) AND NOT EXISTS (SELECT 1 FROM dbos.workflow_status WHERE workflow_status.workflow_uuid = atomic_guard_rows.workflow_uuid)",
				[authority.root, metadataId],
			);
			if (this.lost) throw this.fail();
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release(true);
		}
	}

	protectPool(pool: Pool): Pool {
		const connect = pool.connect.bind(pool);
		const acquire = async (): Promise<PoolClient> => {
			const active = writeContext.getStore();
			const client = await connect();
			if (active !== undefined) {
				active.fence.protectedClients.add(client);
				client.once("end", () => active.fence.endedClients.add(client));
			}
			try {
				if (active?.fence.lost) throw active.fence.fail();
				await installDbosRowGuard(client);
				await client.query("SELECT set_config('atomic.row_authority', $1, false)", [
					JSON.stringify(rowContext.getStore() ?? null),
				]);
			} catch (error) {
				if (active === undefined) client.release(true);
				else void active.fence.retireClient(client);
				throw error;
			}
			if (active === undefined) return client;
			const fence = active.fence;
			try {
				if (fence.lost) throw fence.fail();
				await client.query("SELECT set_config('application_name', $1, false)", [
					`atomic-sql:${[...active.workflows.keys()][0]}`,
				]);
				for (const identity of [
					fence.executorId,
					...[...active.workflows].filter(([, claim]) => !claim).map(([id]) => `sql:${id}`),
				]) {
					if (fence.lost) throw fence.fail();
					const held = await client.query<{ held: boolean }>(
						"SELECT pg_try_advisory_lock_shared($1, $2) AS held",
						[...lockKey(identity)],
					);
					if (!held.rows[0]?.held) throw fence.fail();
				}
				try {
					await (await fence.owner()).query("SELECT 1");
				} catch {
					throw fence.fail();
				}
				if (fence.lost) throw fence.fail();
			} catch (error) {
				void fence.retireClient(client);
				throw error;
			}
			let released = false;
			const release = (): void => {
				if (released) return;
				released = true;
				void fence.retireClient(client);
			};
			const query = new Proxy(client.query, {
				apply: (target, _receiver, args: Parameters<PoolClient["query"]>) => {
					if (!fence.lost && !released) return Reflect.apply(target, client, args);
					const error = fence.fail();
					const callback = args.at(-1);
					if (typeof callback === "function") {
						queueMicrotask(() => (callback as (error: Error, result?: QueryResult) => void)(error));
						return;
					}
					return Promise.reject(error);
				},
			});
			return new Proxy(client, {
				get(target, property, receiver) {
					if (property === "release") return release;
					if (property === "query") return query;
					return Reflect.get(target, property, receiver);
				},
			});
		};
		function scopedConnect(): Promise<PoolClient>;
		function scopedConnect(
			callback: (
				error: Error | undefined,
				client: PoolClient | undefined,
				done: (error?: Error | boolean) => void,
			) => void,
		): void;
		function scopedConnect(
			callback?: (
				error: Error | undefined,
				client: PoolClient | undefined,
				done: (error?: Error | boolean) => void,
			) => void,
		): Promise<PoolClient> | undefined {
			const pending = acquire();
			if (callback === undefined) return pending;
			void pending.then(
				(client) => callback(undefined, client, client.release),
				(error: Error) => callback(error, undefined, () => {}),
			);
		}
		pool.connect = scopedConnect;
		return pool;
	}

	private retireClient(client: PoolClient): Promise<void> {
		const existing = this.retirements.get(client);
		if (existing !== undefined) return existing;
		const pending = this.releaseClient(client)
			.catch((error: Error) => {
				this.terminationError ??= error;
			})
			.finally(() => {
				this.terminatingClients.delete(pending);
				this.protectedClients.delete(client);
			});
		this.terminatingClients.add(pending);
		this.retirements.set(client, pending);
		return pending;
	}

	private async releaseClient(client: PoolClient): Promise<void> {
		if (this.endedClients.has(client)) {
			client.release(true);
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onEnd = () => {};
		try {
			await new Promise<void>((resolve, reject) => {
				onEnd = resolve;
				client.once("end", onEnd);
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`Workflow ownership connection did not terminate within ${CLIENT_TERMINATION_TIMEOUT_MS}ms`,
							),
						),
					CLIENT_TERMINATION_TIMEOUT_MS,
				);
				client.release(true);
			});
		} finally {
			clearTimeout(timer);
			client.removeListener("end", onEnd);
		}
	}

	close(): Promise<void> {
		this.closed = true;
		this.lost = true;
		this.closing ??= (async () => {
			try {
				for (const client of this.protectedClients) void this.retireClient(client);
				if (this.lifetime !== undefined) {
					const client = await this.lifetime.catch(() => undefined);
					if (client !== undefined) await this.retireClient(client);
				}
			} finally {
				await this.endPool();
			}
			while (this.terminatingClients.size > 0) await Promise.all(this.terminatingClients);
			if (this.terminationError !== undefined) throw this.terminationError;
		})();
		return this.closing;
	}
}
