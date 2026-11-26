import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "vitest";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { dropLibsqlScope } from "../helpers/storage-backends.js";

/**
 * Opening stores again on a libSQL server (sqld) whose schema they set up already (#6560). Runs only when a server is
 * named with `ATOMIC_TEST_LIBSQL_URL` (and `ATOMIC_TEST_LIBSQL_TOKEN_FILE` when it checks tokens). Each test works under
 * a table prefix of its own, so the server may be shared.
 */
const serverUrl = process.env.ATOMIC_TEST_LIBSQL_URL;
const tokenFile = process.env.ATOMIC_TEST_LIBSQL_TOKEN_FILE;

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

/** Counts the HTTP requests sent to the server until the test ends. */
function countRequests() {
	const original = globalThis.fetch;
	let sent = 0;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		sent += 1;
		return original(input, init);
	}) as typeof fetch;
	restores.push(() => {
		globalThis.fetch = original;
	});
	return {
		take() {
			const counted = sent;
			sent = 0;
			return counted;
		},
	};
}

function opener() {
	const authToken = tokenFile === undefined ? undefined : readFileSync(tokenFile, "utf8").trim();
	return () => openLibsqlDatabase({ url: serverUrl!, ...(authToken === undefined ? {} : { authToken }) });
}

describe.skipIf(serverUrl === undefined)("opening stores on a libSQL server whose schema is current (#6560)", () => {
	test("a broker reopened sends a few requests, not a write transaction for every store", async () => {
		const open = opener();
		const prefix = `cat_${randomUUID().replaceAll("-", "_").slice(0, 12)}_`;
		const openBroker = async () => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: open, prefix });
			await bus.close();
			await state.close();
		};
		try {
			await openBroker();
			const requests = countRequests();
			await openBroker();
			// 74 requests before, about 6.4 seconds 80 ms away from the server: each store's setup took the server's one
			// write lock in a transaction of its own, three requests each, though the tables were there.
			const sent = requests.take();
			assert.ok(sent <= 8, `${sent} requests`);
		} finally {
			const database = await open();
			await dropLibsqlScope(database, prefix);
			await database.close();
		}
	});

	test("a broker reopened after another prefix changed the schema checks its stores in one write transaction", async () => {
		const open = opener();
		const prefix = `cat_${randomUUID().replaceAll("-", "_").slice(0, 12)}_`;
		const openBroker = async () => {
			const { state, bus } = await openIntercomBrokerState({ openDatabase: open, prefix });
			await bus.close();
			await state.close();
		};
		try {
			await openBroker();
			// Another prefix's table on the same server, as concurrent tests and other teams create them: the schema
			// version the stamps record moves on.
			const other = await open();
			await other.exec(`CREATE TABLE ${prefix}other (value)`);
			await other.close();
			const requests = countRequests();
			await openBroker();
			// No transaction per store: one seeds the counters, checks every store and stamps them all, 7 requests here.
			const stale = requests.take();
			assert.ok(stale <= 8, `${stale} requests`);
		} finally {
			const database = await open();
			await database.exec(`DROP TABLE IF EXISTS ${prefix}other`);
			await dropLibsqlScope(database, prefix);
			await database.close();
		}
	});

	test("a session store reopened reads its schema in one request, not a request for every table and column", async () => {
		const open = opener();
		const prefix = `cat_${randomUUID().replaceAll("-", "_").slice(0, 12)}_`;
		const database = await open();
		try {
			await (await SqlSessionStore.open(database, { prefix })).close();
			const requests = countRequests();
			await (await SqlSessionStore.open(database, { prefix })).close();
			// 40 requests before, most on streams of their own and many on new connections.
			const sent = requests.take();
			assert.ok(sent <= 10, `${sent} requests`);
		} finally {
			await dropLibsqlScope(database, prefix);
			await database.close();
		}
	});
});
