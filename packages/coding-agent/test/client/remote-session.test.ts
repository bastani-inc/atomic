import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { collectRequests, connectClient, MemoryServer, openRemoteSession, sessionSnapshot } from "./support.ts";

describe("RemoteSession operations", () => {
	test("projects progress for subscribers without changing the authoritative snapshot", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(
			await connectClient(server),
			server,
			sessionSnapshot("session-1", {
				phase: "turn",
				transcript: [
					{
						id: "assistant-1",
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
						status: "streaming",
						model: { provider: "faux", id: "model" },
						timestamp: 1,
					},
				],
			}),
		);
		const views: string[] = [];
		remoteSession.subscribe((state) => {
			const item = state.transcript[0];
			if (item?.role === "assistant" && item.content[0]?.type === "text") views.push(item.content[0].text);
		});

		server.send({
			type: "event",
			event: {
				type: "session_progress",
				sessionId: "session-1",
				progress: {
					type: "assistant_delta",
					messageId: "assistant-1",
					contentIndex: 0,
					kind: "text",
					delta: " world",
				},
			},
		});

		assert.deepEqual(views, ["hello", "hello world"]);
		assert.deepEqual(remoteSession.snapshot?.transcript[0]?.content, [{ type: "text", text: "hello" }]);
	});

	test("becomes unbound and can reopen after its session is removed", async () => {
		const server = new MemoryServer();
		const client = await connectClient(server);
		const remoteSession = await openRemoteSession(client, server, sessionSnapshot("session-1"));

		server.send({ type: "event", event: { type: "session_removed", sessionId: "session-1" } });

		assert.equal(remoteSession.id, undefined);
		assert.equal(remoteSession.snapshot, undefined);
		assert.deepEqual(remoteSession.state.transcript, []);
		assert.deepEqual(remoteSession.state.lifecycle, { status: "unbound" });

		const requests = collectRequests(server);
		const reopening = remoteSession.open("session-1");
		const request = requests.at(-1);
		if (!request) throw new Error("Missing attach request");
		assert.deepEqual(request.request, { command: "attach", sessionId: "session-1" });
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-1", { revision: 2 }) },
		});
		await reopening;
		assert.deepEqual(remoteSession.state.lifecycle, { status: "ready" });
	});

	test("exposes the active operation while prompting", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"));
		const requests = collectRequests(server);
		const lifecycles: string[] = [];
		remoteSession.subscribe(({ lifecycle }) => {
			lifecycles.push(lifecycle.status === "busy" ? `${lifecycle.status}:${lifecycle.operation}` : lifecycle.status);
		});

		const prompting = remoteSession.submit("  first prompt  ");
		const request = requests.at(-1);
		if (!request) throw new Error("Missing prompt request");
		assert.deepEqual(request.request, { command: "prompt", sessionId: "session-1", text: "first prompt" });
		assert.equal(remoteSession.operation, "submit");
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: { command: "prompt", session: sessionSnapshot("session-1", { revision: 2, phase: "turn" }) },
		});
		await prompting;

		assert.deepEqual(lifecycles, ["ready", "busy:submit", "busy:submit", "ready"]);
		assert.deepEqual(remoteSession.state.lifecycle, { status: "ready" });
	});

	test("steers when the server session is in a turn", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(
			await connectClient(server),
			server,
			sessionSnapshot("session-1", { phase: "turn" }),
		);
		const requests = collectRequests(server);

		const steering = remoteSession.submit("adjust");
		const request = requests.at(-1);
		if (!request) throw new Error("Missing steer request");
		assert.deepEqual(request.request, { command: "steer", sessionId: "session-1", text: "adjust" });
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: { command: "steer", session: sessionSnapshot("session-1", { revision: 2, phase: "turn" }) },
		});
		await steering;
	});

	test("aborts while a prompt response is pending", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"));
		const requests = collectRequests(server);

		const prompting = remoteSession.submit("hello");
		const promptRequest = requests.at(-1);
		if (!promptRequest) throw new Error("Missing prompt request");
		server.send({
			type: "event",
			event: { type: "session_snapshot", snapshot: sessionSnapshot("session-1", { revision: 2, phase: "turn" }) },
		});

		const aborting = remoteSession.abort();
		const abortRequest = requests.at(-1);
		if (!abortRequest) throw new Error("Missing abort request");
		assert.deepEqual(abortRequest.request, { command: "abort", sessionId: "session-1" });
		assert.equal(remoteSession.operation, "abort");
		server.send({
			type: "response",
			id: promptRequest.id,
			ok: true,
			result: { command: "prompt", session: sessionSnapshot("session-1", { revision: 3, phase: "turn" }) },
		});
		await prompting;
		assert.equal(remoteSession.operation, "abort");
		server.send({
			type: "response",
			id: abortRequest.id,
			ok: true,
			result: { command: "abort", session: sessionSnapshot("session-1", { revision: 4 }) },
		});
		await aborting;
		assert.deepEqual(remoteSession.state.lifecycle, { status: "ready" });
	});

	test("rejects conflicting operations while locally busy", async () => {
		const server = new MemoryServer();
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"));

		const requests = collectRequests(server);
		const prompting = remoteSession.submit("hello");
		await assert.rejects(remoteSession.setThinking("high"), /Remote session is busy with submit/);
		await assert.rejects(remoteSession.open("session-2"), /Remote session is busy with submit/);
		const request = requests.at(-1);
		if (!request) throw new Error("Missing prompt request");
		server.send({
			type: "response",
			id: request.id,
			ok: true,
			result: { command: "prompt", session: sessionSnapshot("session-1", { revision: 2, phase: "turn" }) },
		});
		await prompting;
	});

	test("reports subscriber failures without interrupting other subscribers", async () => {
		const server = new MemoryServer();
		const listenerErrors: Error[] = [];
		const remoteSession = await openRemoteSession(await connectClient(server), server, sessionSnapshot("session-1"), {
			onListenerError: (error) => listenerErrors.push(error),
		});
		remoteSession.subscribe(() => {
			throw new Error("render failed");
		});
		let notified = false;
		remoteSession.subscribe(() => {
			notified = true;
		});

		assert.deepEqual(
			listenerErrors.map(({ message }) => message),
			["render failed"],
		);
		assert.equal(notified, true);
	});
});
