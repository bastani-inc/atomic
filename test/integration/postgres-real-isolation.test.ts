import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "vitest";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";

// Real independent processes, initdb, recovery and owned shutdown are structural work.
const REAL_POSTGRES_PROCESS_TIMEOUT_MS = 120_000;

// #3074: these are real independent clients and a real PostgreSQL server, not lifecycle spies.
test(
	"managed clients survive owner exit and concurrently recover the same persisted cluster",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		try {
			const owner = home.client(listener.port);
			const first = await owner.request<ManagedResult>("ensure");
			assert.notEqual(first.metadata.server.port, listener.port);
			await owner.request(
				"query",
				"CREATE TABLE fault_sentinel (value text); INSERT INTO fault_sentinel VALUES ('preserved')",
			);
			const attached = home.client(listener.port);
			const second = await attached.request<ManagedResult>("ensure");
			assert.deepEqual(second.metadata, first.metadata);
			assert.equal((await attached.request<object[]>("consumers")).length, 2);
			await owner.exit();
			assert.deepEqual(await attached.request("query", "SELECT value FROM fault_sentinel"), [
				{ value: "preserved" },
			]);
			const afterExit = await attached.request<ManagedResult>("ensure");
			assert.equal(
				afterExit.metadata.server.pid,
				first.metadata.server.pid,
				"owner exit must not stop the shared server",
			);
			const reconnect = home.client(listener.port);
			await attached.request("stop");
			const [recovered, concurrent] = await Promise.all([
				attached.request<ManagedResult>("ensure"),
				reconnect.request<ManagedResult>("ensure"),
			]);
			assert.deepEqual(recovered.metadata, concurrent.metadata, "one elected server for recovery and reconnect");
			assert.equal(recovered.metadata.clusterId, first.metadata.clusterId);
			assert.equal(recovered.metadata.directoryIdentity, first.metadata.directoryIdentity);
			assert.equal(recovered.metadata.server.systemIdentifier, first.metadata.server.systemIdentifier);
			assert.equal(recovered.metadata.server.port, first.metadata.server.port);
			assert.equal((await reconnect.request<object[]>("consumers")).length, 2);
			assert.deepEqual(await reconnect.request("query", "SELECT value FROM fault_sentinel"), [
				{ value: "preserved" },
			]);
			const sentinel = await new Promise<string>((resolve, reject) => {
				const socket = connect(listener.port, "127.0.0.1");
				socket.setTimeout(2000, () => socket.destroy(new Error("sentinel timed out")));
				socket.once("error", reject);
				socket.once("data", (data) => {
					resolve(data.toString());
					socket.destroy();
				});
			});
			assert.match(sentinel, /owned non-PostgreSQL sentinel/);
		} finally {
			try {
				await home.cleanup();
			} finally {
				await listener.close();
			}
		}
	},
	REAL_POSTGRES_PROCESS_TIMEOUT_MS,
);

// #3074: the other project's PostgreSQL is disposable too, but not managed by these clients.
test(
	"concurrent starts select one alternate port without changing another project's PostgreSQL",
	async () => {
		const foreign = new RealPostgresHome();
		const own = new RealPostgresHome();
		const reservation = await reserveListener();
		await reservation.close();
		try {
			const other = foreign.client(reservation.port);
			const before = await other.request<ManagedResult>("ensure");
			await other.request(
				"query",
				"CREATE TABLE foreign_sentinel (value text); INSERT INTO foreign_sentinel VALUES ('untouched')",
			);
			const a = own.client(before.metadata.server.port);
			const b = own.client(before.metadata.server.port);
			const [first, second] = await Promise.all([
				a.request<ManagedResult>("ensure"),
				b.request<ManagedResult>("ensure"),
			]);
			assert.notEqual(first.metadata.server.port, before.metadata.server.port);
			assert.deepEqual(first.metadata, second.metadata);
			await a.exit();
			await b.exit();
			const reconnect = await own.client(before.metadata.server.port).request<ManagedResult>("ensure");
			assert.deepEqual(reconnect.metadata, first.metadata);
			assert.deepEqual((await other.request<ManagedResult>("ensure")).metadata, before.metadata);
			assert.deepEqual(await other.request("query", "SELECT value FROM foreign_sentinel"), [{ value: "untouched" }]);
		} finally {
			try {
				await own.cleanup();
			} finally {
				await foreign.cleanup();
			}
		}
	},
	REAL_POSTGRES_PROCESS_TIMEOUT_MS,
);
