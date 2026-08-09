import assert from "node:assert/strict";
import type { RequestEnvelope } from "@earendil-works/pi-protocol";
import { describe, test } from "vitest";
import { collectRequests, connectClient, MemoryServer, openRemoteSession, sessionSnapshot } from "./support.ts";

function nextRequest(server: MemoryServer, command: RequestEnvelope["request"]["command"]): Promise<RequestEnvelope> {
	return new Promise((resolve) => {
		const unsubscribe = server.onMessage((message) => {
			if (message.type !== "request" || message.request.command !== command) return;
			unsubscribe();
			resolve(message);
		});
	});
}

describe("RemoteSession lifecycle", () => {
	test("opens a replacement before detaching the current session", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"));
		const requests = collectRequests(server);

		const opening = remoteSession.open("session-2");
		const attachRequest = requests.at(-1);
		if (!attachRequest) throw new Error("Missing attach request");
		const detachRequestPromise = nextRequest(server, "detach");
		server.send({
			type: "response",
			id: attachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-2") },
		});
		const detachRequest = await detachRequestPromise;
		assert.deepEqual(detachRequest.request, { command: "detach", sessionId: "session-1" });
		server.send({
			type: "response",
			id: detachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-1" },
		});
		await opening;

		assert.equal(remoteSession.id, "session-2");
	});

	test("rejects another mutation while replacement attachment is pending", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"));
		const requests = collectRequests(server);

		const opening = remoteSession.open("session-2");
		await assert.rejects(remoteSession.submit("race"), /Remote session is busy with open/);
		await assert.rejects(remoteSession.create({ cwd: "/other" }), /Remote session is busy with open/);
		assert.deepEqual(
			requests.map(({ request }) => request),
			[{ command: "attach", sessionId: "session-2" }],
		);

		const attachRequest = requests[0];
		if (!attachRequest) throw new Error("Missing attach request");
		const detachRequestPromise = nextRequest(server, "detach");
		server.send({
			type: "response",
			id: attachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-2") },
		});
		const detachRequest = await detachRequestPromise;
		server.send({
			type: "response",
			id: detachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-1" },
		});
		await opening;
	});

	test("rolls back a replacement when the current server session becomes active", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"));
		const requests = collectRequests(server);

		const opening = remoteSession.open("session-2");
		const attachRequest = requests.at(-1);
		if (!attachRequest) throw new Error("Missing attach request");
		const detachRequestPromise = nextRequest(server, "detach");
		server.send({
			type: "event",
			event: {
				type: "session_snapshot",
				snapshot: sessionSnapshot("session-1", { phase: "turn", revision: 2 }),
			},
		});
		server.send({
			type: "response",
			id: attachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-2") },
		});
		const detachRequest = await detachRequestPromise;
		assert.deepEqual(detachRequest.request, { command: "detach", sessionId: "session-2" });
		server.send({
			type: "response",
			id: detachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-2" },
		});

		await assert.rejects(opening, /Cannot open a session while session is turn/);
		assert.equal(remoteSession.id, "session-1");
		assert.deepEqual(remoteSession.state.lifecycle, { status: "ready" });
	});

	test("dispose awaits attachment cleanup started by reconnect", async () => {
		const server = new MemoryServer();
		const client = await connectClient(server);
		const remoteSession = await openRemoteSession(client, server, sessionSnapshot("session-1"));
		client.disconnect("test reconnect");
		const attachRequestPromise = nextRequest(server, "attach");

		const reconnecting = remoteSession.reconnect();
		const attachRequest = await attachRequestPromise;
		const disposing = remoteSession.dispose();
		let disposalSettled = false;
		void disposing.then(() => {
			disposalSettled = true;
		});
		await assert.rejects(reconnecting, /Remote session is disposed/);
		const detachRequestPromise = nextRequest(server, "detach");
		server.send({
			type: "response",
			id: attachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-1", { revision: 2 }) },
		});
		const detachRequest = await detachRequestPromise;
		assert.equal(disposalSettled, false);
		server.send({
			type: "response",
			id: detachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-1" },
		});

		await disposing;
		assert.equal(disposalSettled, true);
		assert.equal(client.connected, true);
	});

	test("dispose immediately preempts pending work and awaits attachment cleanup", async () => {
		const server = new MemoryServer();
		const client = await connectClient(server);
		const remoteSession = await openRemoteSession(client, server, sessionSnapshot("session-1"));
		const states: string[] = [];
		remoteSession.subscribe(({ lifecycle }) => states.push(lifecycle.status));
		const requests = collectRequests(server);

		const opening = remoteSession.open("session-2");
		const attachRequest = requests.find(({ request }) => request.command === "attach");
		if (!attachRequest) throw new Error("Missing attach request");
		const disposing = remoteSession.dispose();
		const currentDetachRequest = requests.find(
			({ request }) => request.command === "detach" && request.sessionId === "session-1",
		);
		if (!currentDetachRequest) throw new Error("Missing current detach request");

		assert.equal(client.connected, true);
		assert.deepEqual(remoteSession.state.lifecycle, { status: "disposed" });
		await assert.rejects(opening);
		const replacementDetachRequestPromise = nextRequest(server, "detach");
		server.send({
			type: "response",
			id: attachRequest.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-2") },
		});
		server.send({
			type: "response",
			id: currentDetachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-1" },
		});
		const replacementDetachRequest = await replacementDetachRequestPromise;
		assert.deepEqual(replacementDetachRequest.request, { command: "detach", sessionId: "session-2" });
		server.send({
			type: "response",
			id: replacementDetachRequest.id,
			ok: true,
			result: { command: "detach", sessionId: "session-2" },
		});
		await disposing;
		assert.ok(states.includes("disposed"));
		assert.throws(() => remoteSession.subscribe(() => {}), /Remote session is disposed/);
	});
});
