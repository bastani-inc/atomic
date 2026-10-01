import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.js";
import {
	LATEST_PROTOCOL_VERSION,
	McpConnectionClosedError,
	McpTimeoutError,
} from "../../src/extensions/mcp/client/index.js";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.js";
import { createDefaultTransport, McpServerConnection } from "../../src/extensions/mcp/runtime.js";
import { closeServers, listen, readBody } from "./helpers.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function setup({ toolStatus = 404, resourceStatus = 404, timeout = 60, holdDeletion = false } = {}) {
	const started = { tool: deferred(), resource: deferred() };
	const release = { tool: deferred(), resource: deferred(), deletion: deferred() };
	const deleted: string[] = [];
	const requests: { session: string; method: string }[] = [];
	let sessions = 0;
	let mutations = 0;
	const origin = await listen(async (request, response) => {
		const session = String(request.headers["mcp-session-id"] ?? "");
		if (request.method === "DELETE") {
			deleted.push(session);
			if (holdDeletion) await release.deletion.promise;
			response.writeHead(204).end();
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		const message = JSON.parse(await readBody(request)) as { id?: number; method: string };
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		const reply = (result: object, headers: Record<string, string> = {}) => {
			response.writeHead(200, { "content-type": "application/json", ...headers });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		};
		if (message.method === "initialize") {
			reply(
				{
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					serverInfo: { name: "expiry", version: "1" },
				},
				{ "mcp-session-id": String(++sessions) },
			);
			return;
		}
		requests.push({ session, method: message.method });
		const kind = message.method === "tools/call" ? "tool" : "resource";
		const status = session === "1" ? (kind === "tool" ? toolStatus : resourceStatus) : 200;
		if (kind === "tool" && status === 200) mutations++;
		if (session === "1") {
			started[kind].resolve();
			await release[kind].promise;
			if (status === 404) {
				response.writeHead(404).end("expired");
				return;
			}
		}
		reply(
			message.method === "tools/call"
				? { content: [{ type: "text", text: "ok" }] }
				: { contents: [{ uri: "docs://a", text: "ok" }] },
		);
	});
	const connection = new McpServerConnection({
		entry: { name: "expiry", source: "test", config: { url: `${origin}/mcp`, timeout } },
		cwd: process.cwd(),
		createTransport: createDefaultTransport,
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		onTools: () => {},
	});
	await connection.getClient();
	return { connection, started, release, deleted, requests, sessions: () => sessions, mutations: () => mutations };
}

describe("concurrent native MCP session expiry", () => {
	afterEach(closeServers);

	it("retries each concurrent expired tool and resource request once without closing its sibling (#3389)", async () => {
		const server = await setup();
		const tool = server.connection.callTool("echo", {}, {});
		const resource = server.connection.readResource("docs://a", {});
		const results = Promise.allSettled([tool, resource]);
		try {
			await Promise.all([server.started.tool.promise, server.started.resource.promise]);
			server.release.tool.resolve();
			await tool;
			assert.deepEqual(server.deleted, []);
			server.release.resource.resolve();
			assert.deepEqual(await results, [
				{ status: "fulfilled", value: { content: [{ type: "text", text: "ok" }] } },
				{ status: "fulfilled", value: { contents: [{ uri: "docs://a", text: "ok" }] } },
			]);
			assert.equal(server.sessions(), 2);
			assert.deepEqual(server.requests, [
				{ session: "1", method: "tools/call" },
				{ session: "1", method: "resources/read" },
				{ session: "2", method: "tools/call" },
				{ session: "2", method: "resources/read" },
			]);
			await vi.waitFor(() => assert.deepEqual(server.deleted, ["1"]));
		} finally {
			server.release.tool.resolve();
			server.release.resource.resolve();
			await server.connection.close();
			await results;
		}
		assert.deepEqual(server.deleted, ["1", "2"]);
	});

	it("preserves an already-executed mutation while a concurrent resource expires without duplicating it (#3389)", async () => {
		const server = await setup({ toolStatus: 200 });
		const tool = server.connection.callTool("mutate", {}, {});
		const resource = server.connection.readResource("docs://a", {});
		const results = Promise.allSettled([tool, resource]);
		try {
			await Promise.all([server.started.tool.promise, server.started.resource.promise]);
			assert.equal(server.mutations(), 1);
			server.release.resource.resolve();
			assert.deepEqual(await resource, { contents: [{ uri: "docs://a", text: "ok" }] });
			assert.deepEqual(server.deleted, []);
			server.release.tool.resolve();
			assert.deepEqual(await tool, { content: [{ type: "text", text: "ok" }] });
			assert.equal(server.mutations(), 1);
			assert.equal(server.sessions(), 2);
			assert.deepEqual(server.requests, [
				{ session: "1", method: "tools/call" },
				{ session: "1", method: "resources/read" },
				{ session: "2", method: "resources/read" },
			]);
			await vi.waitFor(() => assert.deepEqual(server.deleted, ["1"]));
		} finally {
			server.release.tool.resolve();
			server.release.resource.resolve();
			await server.connection.close();
			await results;
		}
		assert.deepEqual(server.deleted, ["1", "2"]);
	});

	it("keeps a detached client's pending request bounded by its normal timeout, then retires it (#3389)", async () => {
		const server = await setup({ timeout: 1 });
		const tool = server.connection.callTool("echo", {}, {});
		const resource = server.connection.readResource("docs://a", {}).catch((error: unknown) => error);
		try {
			await Promise.all([server.started.tool.promise, server.started.resource.promise]);
			server.release.tool.resolve();
			await tool;
			assert.deepEqual(server.deleted, []);
			const error = await resource;
			assert.ok(error instanceof McpTimeoutError);
			assert.equal(error.timeoutMs, server.connection.timeoutMs);
			assert.deepEqual(server.requests, [
				{ session: "1", method: "tools/call" },
				{ session: "1", method: "resources/read" },
				{ session: "2", method: "tools/call" },
			]);
			await vi.waitFor(() => assert.deepEqual(server.deleted, ["1"]));
		} finally {
			server.release.tool.resolve();
			server.release.resource.resolve();
			await server.connection.close();
			await Promise.allSettled([tool, resource]);
		}
		assert.deepEqual(server.deleted, ["1", "2"]);
	});

	it("shutdown forces detached requests closed and drains their coalesced retirement (#3389)", async () => {
		const server = await setup({ holdDeletion: true });
		const tool = server.connection.callTool("echo", {}, {});
		const resource = server.connection.readResource("docs://a", {}).catch((error: unknown) => error);
		try {
			await Promise.all([server.started.tool.promise, server.started.resource.promise]);
			server.release.tool.resolve();
			await tool;
			assert.deepEqual(server.deleted, []);
			let closed = false;
			const shutdown = server.connection.close().then(() => {
				closed = true;
			});
			assert.ok((await resource) instanceof McpConnectionClosedError);
			await vi.waitFor(() => assert.deepEqual([...server.deleted].sort(), ["1", "2"]));
			assert.equal(closed, false);
			server.release.deletion.resolve();
			await shutdown;
			assert.equal(server.connection.state, "closed");
			assert.equal(server.sessions(), 2);
			assert.equal(server.requests.filter((request) => request.method === "resources/read").length, 1);
		} finally {
			server.release.tool.resolve();
			server.release.resource.resolve();
			server.release.deletion.resolve();
			await server.connection.close();
			await Promise.allSettled([tool, resource]);
		}
		assert.deepEqual([...server.deleted].sort(), ["1", "2"]);
	});

	it("bounds shutdown with a stalled detached request and unresponsive session deletion (#3389)", async () => {
		const server = await setup({ holdDeletion: true });
		const tool = server.connection.callTool("echo", {}, {});
		const resource = server.connection.readResource("docs://a", {}).catch((error: unknown) => error);
		try {
			await Promise.all([server.started.tool.promise, server.started.resource.promise]);
			server.release.tool.resolve();
			await tool;
			assert.deepEqual(server.deleted, []);
			await server.connection.close();
			assert.ok((await resource) instanceof McpConnectionClosedError);
			assert.deepEqual([...server.deleted].sort(), ["1", "2"]);
			assert.equal(server.connection.state, "closed");
			await assert.rejects(server.connection.getClient(), /shut down/);
		} finally {
			server.release.tool.resolve();
			server.release.resource.resolve();
			server.release.deletion.resolve();
			await server.connection.close();
			await Promise.allSettled([tool, resource]);
		}
	});
});
