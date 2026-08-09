import assert from "node:assert/strict";
import { PiSessionOwnershipError } from "@earendil-works/pi-client";
import { describe, test } from "vitest";
import { RemoteSession } from "../../src/client/remote-session.ts";
import { collectRequests, connectClient, MemoryServer, sessionSnapshot } from "./support.ts";

function respondToAttach(server: MemoryServer, sessionId: string): void {
	server.onMessage((message) => {
		if (message.type !== "request" || message.request.command !== "attach") return;
		server.send({
			type: "response",
			id: message.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot(sessionId) },
		});
	});
}

describe("RemoteSession ownership", () => {
	test("factory opens a session and disposal awaits detach without disconnecting the borrowed client", async () => {
		const server = new MemoryServer();
		const client = await connectClient(server);
		respondToAttach(server, "session-1");
		const remoteSession = await RemoteSession.open(client, "session-1");
		const requests = collectRequests(server);

		const firstDisposal = remoteSession.dispose();
		const secondDisposal = remoteSession.dispose();
		let disposalSettled = false;
		void firstDisposal.then(() => {
			disposalSettled = true;
		});

		assert.strictEqual(secondDisposal, firstDisposal);
		await Promise.resolve();
		assert.equal(disposalSettled, false);
		const detachRequest = requests.at(-1);
		if (!detachRequest) throw new Error("Missing detach request");
		assert.deepEqual(detachRequest.request, { command: "detach", sessionId: "session-1" });
		server.send({
			type: "response",
			id: detachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-1" },
		});
		await firstDisposal;
		assert.equal(remoteSession.disposed, true);
		assert.equal(client.connected, true);
	});

	test("rejects an exclusive coordinator while a direct shared lease is active", async () => {
		const server = new MemoryServer();
		const client = await connectClient(server);
		respondToAttach(server, "session-1");
		server.onMessage((message) => {
			if (message.type !== "request" || message.request.command !== "detach") return;
			server.send({
				type: "response",
				id: message.id,
				ok: true,
				result: { command: "detach", sessionId: "session-1" },
			});
		});
		const directHandle = await client.attachSession("session-1");
		const requests = collectRequests(server);

		await assert.rejects(RemoteSession.open(client, "session-1"), PiSessionOwnershipError);

		assert.deepEqual(requests, []);
		assert.equal(directHandle.active, true);
		await directHandle.detach();
		assert.deepEqual(
			requests.map(({ request }) => request.command),
			["detach"],
		);
	});

	test("factory creates a session", async () => {
		const server = new MemoryServer();
		const client = await connectClient(server);
		server.onMessage((message) => {
			if (message.type !== "request" || message.request.command !== "create") return;
			server.send({
				type: "response",
				id: message.id,
				ok: true,
				result: { command: "create", session: sessionSnapshot("session-1") },
			});
		});

		const remoteSession = await RemoteSession.create(client, { cwd: "/workspace" });

		assert.equal(remoteSession.id, "session-1");
		assert.deepEqual(remoteSession.state.lifecycle, { status: "ready" });
	});

	test("disposal reports cleanup failure without retaining exclusive ownership", async () => {
		const server = new MemoryServer();
		const client = await connectClient(server);
		respondToAttach(server, "session-1");
		const remoteSession = await RemoteSession.open(client, "session-1");
		let detachCount = 0;
		server.onMessage((message) => {
			if (message.type !== "request" || message.request.command !== "detach") return;
			detachCount++;
			if (detachCount === 1) {
				server.send({
					type: "response",
					id: message.id,
					ok: false,
					error: { code: "invalid_request", message: "no" },
				});
			} else {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "detach", sessionId: "session-1" },
				});
			}
		});

		await assert.rejects(remoteSession.dispose(), /no/);
		assert.equal(remoteSession.disposed, true);
		assert.equal(client.connected, true);

		const replacement = await RemoteSession.open(client, "session-1");
		assert.deepEqual(replacement.state.lifecycle, { status: "ready" });
		assert.equal(detachCount, 2);
	});

	test("multiple sessions borrow one client independently", async () => {
		const server = new MemoryServer();
		const client = await connectClient(server);
		server.onMessage((message) => {
			if (message.type !== "request") return;
			if (message.request.command === "attach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "attach", session: sessionSnapshot(message.request.sessionId) },
				});
			}
			if (message.request.command === "detach") {
				server.send({
					type: "response",
					id: message.id,
					ok: true,
					result: { command: "detach", sessionId: message.request.sessionId },
				});
			}
		});

		const first = await RemoteSession.open(client, "session-1");
		const second = await RemoteSession.open(client, "session-2");
		await first.dispose();

		assert.equal(first.disposed, true);
		assert.equal(second.disposed, false);
		assert.equal(client.connected, true);
		await second.dispose();
	});

	test("session disposal treats a client-first disposal as released", async () => {
		const server = new MemoryServer();
		const client = await connectClient(server);
		respondToAttach(server, "session-1");
		const remoteSession = await RemoteSession.open(client, "session-1");
		const requests = collectRequests(server);

		await client.dispose();
		await remoteSession[Symbol.asyncDispose]();

		assert.equal(remoteSession.disposed, true);
		assert.deepEqual(requests, []);
	});
});
