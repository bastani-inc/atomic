import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { setLoadedFileExtensionPaths } from "../src/core/extensions/loaded-extension-paths.ts";
import { loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { noOpUIContext } from "../src/core/extensions/runner-ui.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { getOpenUserBlocks } from "../src/core/extensions/user-blocks.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import herdrExtension from "../src/extensions/herdr/index.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { type HerdrSocketFixture, type RecordedRequest, startHerdrSocketFixture } from "./herdr-socket-fixture.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("herdr builtin registration", () => {
	it("is the second builtin row and does not displace llama.cpp", () => {
		const named = builtInExtensions.map((entry) => (typeof entry === "function" ? undefined : entry.name));
		assert.deepEqual(named, ["llama.cpp", "herdr"]);
	});

	it("ships hidden and bundled like the other builtins", () => {
		const herdr = builtInExtensions.find((entry) => typeof entry !== "function" && entry.name === "herdr");
		assert.ok(herdr && typeof herdr !== "function");
		assert.equal(herdr.hidden, true);
		assert.equal(herdr.bundled, true);
	});
});

describe("herdr extension end to end", () => {
	let fixture: HerdrSocketFixture;
	let tempDir: string;
	let runner: ExtensionRunner | undefined;
	let saved: { env?: string; pane?: string; socket?: string };

	beforeEach(async () => {
		fixture = await startHerdrSocketFixture();
		tempDir = mkdtempSync(join(tmpdir(), "atomic-herdr-e2e-"));
		saved = {
			env: process.env.HERDR_ENV,
			pane: process.env.HERDR_PANE_ID,
			socket: process.env.HERDR_SOCKET_PATH,
		};
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-e2e";
		process.env.HERDR_SOCKET_PATH = fixture.socketPath;
		setLoadedFileExtensionPaths([]);
	});

	afterEach(async () => {
		runner?.detachUserBlocks();
		runner = undefined;
		if (saved.env === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = saved.env;
		if (saved.pane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = saved.pane;
		if (saved.socket === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = saved.socket;
		rmSync(tempDir, { recursive: true, force: true });
		await fixture.close();
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	async function buildRunner(mode: "tui" | "rpc", ui: ExtensionUIContext): Promise<ExtensionRunner> {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			herdrExtension,
			tempDir,
			createEventBus(),
			runtime,
			"<inline:herdr>",
		);
		const modelRegistry = await createModelRegistry(AuthStorage.create(join(tempDir, "auth.json")));
		const built = new ExtensionRunner([extension], runtime, tempDir, SessionManager.inMemory(), modelRegistry);
		built.setUIContext(ui, mode);
		runner = built;
		return built;
	}

	function paneStates(requests: RecordedRequest[]): string[] {
		return requests
			.filter((request) => request.method === "pane.report_agent")
			.map((request) => String(request.params.state));
	}

	it("reports the pane through the real runner, socket, and block door", async () => {
		let openDuringDialog = 0;
		const ui: ExtensionUIContext = {
			...noOpUIContext,
			confirm: async () => {
				openDuringDialog = getOpenUserBlocks().length;
				// Give the detached agent_blocked emit a chance to reach the socket.
				await fixture.waitForRequests(3);
				return true;
			},
		};
		const built = await buildRunner("tui", ui);

		await built.emit({ type: "session_start", reason: "startup" });
		await fixture.waitForRequests(2);
		assert.equal(fixture.requests[0]?.method, "pane.report_agent_session");
		assert.deepEqual(paneStates(fixture.requests), ["idle"]);

		await built.emit({ type: "agent_start" });
		await fixture.waitForRequests(3);
		assert.deepEqual(paneStates(fixture.requests), ["idle", "working"]);

		assert.equal(await built.createContext().ui.confirm("Approve edit?", "really"), true);
		assert.equal(openDuringDialog, 1);
		// Blocked while the dialog was open, then back to working once it closed.
		await fixture.waitForRequests(5);
		assert.deepEqual(paneStates(fixture.requests), ["idle", "working", "blocked", "working"]);
		assert.equal(
			fixture.requests.find((request) => request.params.state === "blocked")?.params.message,
			"Approve edit?",
		);

		await built.emit({ type: "agent_settled" });
		await fixture.waitForRequests(6);
		assert.equal(paneStates(fixture.requests).at(-1), "idle");

		await built.emit({ type: "session_shutdown", reason: "quit" });
		await fixture.waitForRequests(7);
		assert.equal(fixture.requests.at(-1)?.method, "pane.release_agent");
	});

	it("never touches the socket outside a TUI session", async () => {
		const built = await buildRunner("rpc", noOpUIContext);
		await built.emit({ type: "session_start", reason: "startup" });
		await built.emit({ type: "agent_start" });
		await built.emit({ type: "agent_settled" });
		await built.emit({ type: "session_shutdown", reason: "quit" });
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.equal(fixture.connectionCount(), 0);
		assert.equal(fixture.requests.length, 0);
	});

	it("activates on a later lifecycle event when it loaded after session_start", async () => {
		// The deferred-startup path loads extensions after the first frame, so this
		// instance can miss the session_start that already fired. It must still
		// bind the session, report its identity, and describe the running turn.
		const built = await buildRunner("tui", noOpUIContext);

		await built.emit({ type: "agent_start" });
		await fixture.waitForRequests(2);

		assert.equal(fixture.requests[0]?.method, "pane.report_agent_session");
		assert.equal(paneStates(fixture.requests).at(-1), "working");

		await built.emit({ type: "agent_settled" });
		await fixture.waitForRequests(fixture.requests.length + 1);
		assert.equal(paneStates(fixture.requests).at(-1), "idle");
	});

	it("binds and reports even when agent_settled is the first event it ever sees", async () => {
		const built = await buildRunner("tui", noOpUIContext);
		await built.emit({ type: "agent_settled" });
		await fixture.waitForRequests(2);

		assert.equal(fixture.requests[0]?.method, "pane.report_agent_session");
		assert.deepEqual(paneStates(fixture.requests), ["idle"]);
	});

	it("stands down at activation when a file integration loaded after the factory ran", async () => {
		// Factory-time the loaded set is clean, so listeners register; the file
		// integration lands afterwards, and the builtin must never become the
		// second writer for the pane.
		const built = await buildRunner("tui", noOpUIContext);
		setLoadedFileExtensionPaths(["/home/u/.atomic/agent/extensions/herdr-agent-state.ts"]);

		await built.emit({ type: "session_start", reason: "startup" });
		await built.emit({ type: "agent_start" });
		await built.emit({ type: "agent_settled" });
		await built.emit({ type: "session_shutdown", reason: "quit" });
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.equal(fixture.connectionCount(), 0);
		assert.equal(fixture.requests.length, 0);
	});

	it("registers nothing at all when the file integration loaded before the factory ran", async () => {
		setLoadedFileExtensionPaths(["/home/u/.atomic/agent/extensions/herdr-agent-state.js"]);
		const built = await buildRunner("tui", noOpUIContext);

		await built.emit({ type: "session_start", reason: "startup" });
		await built.emit({ type: "agent_start" });
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.equal(fixture.connectionCount(), 0);
		assert.equal(fixture.requests.length, 0);
	});

	it("uses no package assets, so it needs no __dirname or asset resolution", async () => {
		const sources = await Promise.all(
			["index.ts", "reporter.ts", "transport.ts", "reducer.ts", "sequence.ts", "types.ts"].map((file) =>
				readFile(join(import.meta.dirname, "..", "src", "extensions", "herdr", file), "utf8"),
			),
		);
		for (const source of sources) {
			assert.equal(source.includes("__dirname"), false);
			assert.equal(source.includes("import.meta.dirname"), false);
			assert.equal(source.includes("readFile"), false);
		}
	});
});
