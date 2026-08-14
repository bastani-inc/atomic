import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
	getLoadedFileExtensionPaths,
	setLoadedFileExtensionPaths,
} from "../src/core/extensions/loaded-extension-paths.ts";
import herdrExtension, {
	fileIntegrationLoaded,
	type HerdrExtensionApi,
	readHerdrEnv,
	TURN_FAILURE_MESSAGE,
	turnFailureMessage,
} from "../src/extensions/herdr/index.ts";
import { type HerdrSocketFixture, startHerdrSocketFixture } from "./herdr-socket-fixture.ts";

/**
 * A host that records what the factory registers, so "registers no listener"
 * is asserted rather than inferred.
 */
function createRecordingHost(): { host: HerdrExtensionApi; events: string[] } {
	const events: string[] = [];
	const host: HerdrExtensionApi = {
		on(event: string): void {
			events.push(event);
		},
	};
	return { host, events };
}

describe("herdr activation gate", () => {
	let fixture: HerdrSocketFixture;
	let originalEnv: string | undefined;
	let originalPane: string | undefined;
	let originalSocket: string | undefined;
	let originalLoadedPaths: readonly string[];

	beforeEach(async () => {
		fixture = await startHerdrSocketFixture();
		originalEnv = process.env.HERDR_ENV;
		originalPane = process.env.HERDR_PANE_ID;
		originalSocket = process.env.HERDR_SOCKET_PATH;
		originalLoadedPaths = getLoadedFileExtensionPaths();
		setLoadedFileExtensionPaths([]);
	});

	afterEach(async () => {
		if (originalEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = originalEnv;
		if (originalPane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = originalPane;
		if (originalSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = originalSocket;
		setLoadedFileExtensionPaths(originalLoadedPaths);
		await fixture.close();
	});

	function enableHerdrEnv(): void {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-1";
		process.env.HERDR_SOCKET_PATH = fixture.socketPath;
	}

	it("registers nothing and opens no socket when HERDR_ENV is unset", async () => {
		delete process.env.HERDR_ENV;
		process.env.HERDR_PANE_ID = "pane-1";
		process.env.HERDR_SOCKET_PATH = fixture.socketPath;

		const { host, events } = createRecordingHost();
		herdrExtension(host);

		assert.deepEqual(events, []);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(fixture.connectionCount(), 0);
		assert.equal(fixture.requests.length, 0);
	});

	it("registers nothing when HERDR_ENV is present but the pane id or socket path is missing", () => {
		process.env.HERDR_ENV = "1";
		delete process.env.HERDR_PANE_ID;
		process.env.HERDR_SOCKET_PATH = fixture.socketPath;
		const withoutPane = createRecordingHost();
		herdrExtension(withoutPane.host);
		assert.deepEqual(withoutPane.events, []);

		process.env.HERDR_PANE_ID = "pane-1";
		delete process.env.HERDR_SOCKET_PATH;
		const withoutSocket = createRecordingHost();
		herdrExtension(withoutSocket.host);
		assert.deepEqual(withoutSocket.events, []);
	});

	it('registers nothing when HERDR_ENV is set to anything other than "1"', () => {
		enableHerdrEnv();
		process.env.HERDR_ENV = "0";
		const disabled = createRecordingHost();
		herdrExtension(disabled.host);
		assert.deepEqual(disabled.events, []);

		process.env.HERDR_ENV = "true";
		const truthy = createRecordingHost();
		herdrExtension(truthy.host);
		assert.deepEqual(truthy.events, []);
	});

	it("registers its lifecycle listeners inside a Herdr pane", () => {
		enableHerdrEnv();
		const { host, events } = createRecordingHost();
		herdrExtension(host);
		assert.deepEqual(events, [
			"session_start",
			"agent_start",
			"agent_end",
			"agent_settled",
			"agent_blocked",
			"agent_unblocked",
			"session_shutdown",
		]);
	});

	it("keeps reporting even when a file-based herdr integration path loaded this cycle", () => {
		// Supersession happens at load time now: the resource loader skips the
		// installed `herdr-agent-state` files inside a Herdr pane (see
		// herdr-supersession.test.ts), so the builtin never defers to one. A
		// loaded-path entry with that basename — however it got there — must not
		// silence the only reporter the pane has.
		enableHerdrEnv();
		setLoadedFileExtensionPaths(["/home/u/.atomic/agent/extensions/herdr-agent-state.ts"]);
		const { host, events } = createRecordingHost();
		herdrExtension(host);
		assert.equal(events.length, 7);
	});

	it("keeps reporting for a compiled file-based integration path too", () => {
		enableHerdrEnv();
		setLoadedFileExtensionPaths(["/home/u/.atomic/agent/extensions/herdr-agent-state.js"]);
		const { host, events } = createRecordingHost();
		herdrExtension(host);
		assert.equal(events.length, 7);
	});

	it("registers for an unrelated extension that merely loaded", () => {
		enableHerdrEnv();
		setLoadedFileExtensionPaths([
			"/home/u/.atomic/agent/extensions/herdr-agent-state-notes.ts",
			"/home/u/.atomic/agent/extensions/other.ts",
		]);
		const { host, events } = createRecordingHost();
		herdrExtension(host);
		assert.equal(events.length, 7);
	});

	it("still answers whether a loaded-path set carries a file integration", () => {
		// The predicate survives as the historical basename check the loader-side
		// skip is keyed on; the builtin itself no longer consults it.
		assert.equal(fileIntegrationLoaded([]), false);
		assert.equal(fileIntegrationLoaded(["/anywhere/herdr-agent-state.ts"]), true);
		assert.equal(fileIntegrationLoaded(["/anywhere/herdr-agent-state.mjs"]), false);
	});
});

describe("herdr env parsing", () => {
	it("requires all three variables", () => {
		assert.equal(readHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p" }), undefined);
		assert.equal(readHerdrEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" }), undefined);
		assert.equal(readHerdrEnv({ HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/tmp/s" }), undefined);
		assert.deepEqual(readHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/tmp/s" }), {
			paneId: "p",
			socketEndpoint: process.platform === "win32" ? "\\\\.\\pipe\\/tmp/s" : "/tmp/s",
		});
	});

	it("rejects empty values", () => {
		assert.equal(readHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "", HERDR_SOCKET_PATH: "/tmp/s" }), undefined);
		assert.equal(readHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "" }), undefined);
	});
});

describe("herdr turn failure detection", () => {
	it("reports a fixed label, never the provider's own error text", () => {
		// `errorMessage` is whatever the provider or a custom streamSimple put
		// there: error.message, a normalized response body, raw request metadata.
		// Observed examples carry authorization headers and echoed prompt and model
		// output, and none of that may reach the socket.
		const secret = "Authorization: Bearer sk-live-secret; echoed prompt and model output";
		const reported = turnFailureMessage({
			type: "agent_end",
			messages: [
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: secret,
					api: "anthropic-messages",
					provider: "anthropic",
					model: "m",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		});

		assert.equal(reported, TURN_FAILURE_MESSAGE);
		assert.equal(reported, "Agent turn failed");
		assert.equal(reported?.includes("sk-live-secret"), false);
		assert.equal(reported?.includes("Bearer"), false);
		assert.equal(reported?.includes("prompt"), false);
	});

	it("returns undefined for a turn whose final assistant message stopped normally", () => {
		assert.equal(
			turnFailureMessage({
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [],
						stopReason: "stop",
						api: "anthropic-messages",
						provider: "anthropic",
						model: "m",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				],
			}),
			undefined,
		);
	});

	it("returns undefined when the turn has no assistant message at all", () => {
		assert.equal(turnFailureMessage({ type: "agent_end", messages: [] }), undefined);
	});
});
