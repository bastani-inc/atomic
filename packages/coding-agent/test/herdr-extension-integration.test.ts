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
import { getActiveUserBlockLabel, getOpenUserBlocks, openUserBlock } from "../src/core/extensions/user-blocks.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import herdrExtension from "../src/extensions/herdr/index.ts";
import { builtInExtensions, builtInExtensionsForHost } from "../src/extensions/index.ts";
import { hostPresentsTerminalPane } from "../src/main-app-mode.ts";
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

	it("is withheld from a host that presents no terminal pane", () => {
		const headless = builtInExtensionsForHost(false).map((entry) =>
			typeof entry === "function" ? undefined : entry.name,
		);
		assert.deepEqual(headless, ["llama.cpp"], "the Herdr row must not reach a headless factory run");

		const withPane = builtInExtensionsForHost(true).map((entry) =>
			typeof entry === "function" ? undefined : entry.name,
		);
		assert.deepEqual(withPane, ["llama.cpp", "herdr"]);
	});

	it("treats the isolated engine child as a terminal pane and headless modes as not", () => {
		// The engine child is spawned through the RPC client, which passes
		// `--mode rpc`, so it resolves to "rpc" even though it drives the host's
		// terminal UI. Gating on appMode alone would silence the one process that
		// actually reports the pane.
		assert.equal(hostPresentsTerminalPane("rpc", true), true);
		assert.equal(hostPresentsTerminalPane("print", true), true);
		assert.equal(hostPresentsTerminalPane("interactive", false), true);
		assert.equal(hostPresentsTerminalPane("rpc", false), false);
		assert.equal(hostPresentsTerminalPane("json", false), false);
		assert.equal(hostPresentsTerminalPane("print", false), false);
	});

	it("registers zero handlers when the headless builtin set is loaded", async () => {
		// Stronger than "opened no socket": with valid Herdr env, a headless host
		// must not carry the reporter's listeners at all.
		const saved = {
			env: process.env.HERDR_ENV,
			pane: process.env.HERDR_PANE_ID,
			socket: process.env.HERDR_SOCKET_PATH,
		};
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-headless";
		process.env.HERDR_SOCKET_PATH = "/tmp/never-connected.sock";
		const dir = mkdtempSync(join(tmpdir(), "atomic-herdr-headless-"));
		try {
			const runtime = createExtensionRuntime();
			const loaded = await Promise.all(
				builtInExtensionsForHost(false).map((entry) =>
					loadExtensionFromFactory(
						typeof entry === "function" ? entry : entry.factory,
						dir,
						createEventBus(),
						runtime,
						`<inline:${typeof entry === "function" ? "anon" : entry.name}>`,
					),
				),
			);
			for (const eventName of [
				"session_start",
				"session_shutdown",
				"agent_start",
				"agent_end",
				"agent_settled",
				"agent_blocked",
				"agent_unblocked",
			]) {
				const handlers = loaded.flatMap((extension) => extension.handlers.get(eventName) ?? []);
				assert.deepEqual(handlers, [], `headless host registered a ${eventName} handler`);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
			if (saved.env === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = saved.env;
			if (saved.pane === undefined) delete process.env.HERDR_PANE_ID;
			else process.env.HERDR_PANE_ID = saved.pane;
			if (saved.socket === undefined) delete process.env.HERDR_SOCKET_PATH;
			else process.env.HERDR_SOCKET_PATH = saved.socket;
		}
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

	/** Wait until the fixture has at least `count` requests in total. */
	async function waitForNewRequests(count: number): Promise<void> {
		const deadline = Date.now() + 5000;
		while (fixture.requests.length < count) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} requests`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
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

	it("ends idle when a block opens and closes while activation is still pending", async () => {
		// The runner publishes block changes with a detached emit, so the open and
		// close handlers race. When activation suspended, the close handler took
		// the already-active fast path and reported openBlocks 0 first, then the
		// open handler reported 1 — leaving the pane blocked with an empty
		// registry. Nothing here awaits between open and release, which is exactly
		// the interleaving that exposed it.
		const built = await buildRunner("tui", noOpUIContext);
		const before = fixture.requests.length;

		const block = openUserBlock("Approve edit?", "dialog");
		block.release();

		await waitForNewRequests(before + 1);
		await new Promise((resolve) => setTimeout(resolve, 100));

		assert.deepEqual(getOpenUserBlocks(), [], "the registry is empty");
		assert.equal(
			paneStates(fixture.requests).at(-1),
			"idle",
			`pane must not end blocked with no open blocks; saw ${JSON.stringify(paneStates(fixture.requests))}`,
		);
		void built;
	});

	it("keeps open-before-close ordering for several blocks opened during activation", async () => {
		const built = await buildRunner("tui", noOpUIContext);
		const before = fixture.requests.length;

		const first = openUserBlock("First", "dialog");
		const second = openUserBlock("Second", "dialog");
		second.release();
		first.release();

		await waitForNewRequests(before + 1);
		await new Promise((resolve) => setTimeout(resolve, 100));

		assert.deepEqual(getOpenUserBlocks(), []);
		assert.equal(paneStates(fixture.requests).at(-1), "idle");
		void built;
	});

	it("does not activate from a detached callback that lands after shutdown", async () => {
		const built = await buildRunner("tui", noOpUIContext);
		await built.emit({ type: "session_shutdown", reason: "reload" });
		const after = fixture.requests.length;

		// A block change published just after teardown must not revive this
		// instance; the successor owns the pane from here.
		const block = openUserBlock("Too late", "dialog");
		block.release();
		await new Promise((resolve) => setTimeout(resolve, 100));

		assert.equal(fixture.requests.length, after, "a silenced instance writes nothing further");
	});

	it("reports blocked when a block was already open before it activated", async () => {
		// A deferred extension load can land while a dialog is already waiting.
		// Events fired before the factory ran cannot be replayed, so activation
		// must read the registry snapshot — otherwise the pane says idle while a
		// person is being asked something.
		const built = await buildRunner("tui", noOpUIContext);
		const block = openUserBlock("Approve edit?", "dialog");
		try {
			assert.equal(getOpenUserBlocks().length, 1);
			await built.emit({ type: "session_start", reason: "startup" });
			await fixture.waitForRequests(2);

			assert.equal(fixture.requests[0]?.method, "pane.report_agent_session");
			assert.deepEqual(paneStates(fixture.requests), ["blocked"]);
			assert.equal(fixture.requests[1]?.params.message, "Approve edit?");
		} finally {
			block.release();
		}

		// The live event still drives it back out of blocked afterwards.
		await fixture.waitForRequests(3);
		assert.equal(paneStates(fixture.requests).at(-1), "idle");
	});

	it("keeps the oldest open block's label when several span activation", async () => {
		const built = await buildRunner("tui", noOpUIContext);
		const first = openUserBlock("Trust project folder?", "project_trust");
		const second = openUserBlock("Approve edit?", "dialog");
		try {
			assert.equal(getActiveUserBlockLabel(), "Trust project folder?");
			await built.emit({ type: "session_start", reason: "startup" });
			await fixture.waitForRequests(2);
			assert.equal(fixture.requests[1]?.params.state, "blocked");
			assert.equal(fixture.requests[1]?.params.message, "Trust project folder?");
		} finally {
			second.release();
			first.release();
		}
	});

	it("activates from an agent_blocked event alone", async () => {
		const built = await buildRunner("tui", noOpUIContext);
		const block = openUserBlock("Approve edit?", "dialog");
		try {
			// No session_start has reached this instance; the block event is the
			// first lifecycle event it sees and must still bind and report.
			await built.emit({
				type: "agent_blocked",
				blockId: block.id,
				label: block.label,
				reason: block.reason,
				openBlocks: getOpenUserBlocks().length,
				activeLabel: getActiveUserBlockLabel() ?? block.label,
			});
			await fixture.waitForRequests(2);
			assert.equal(fixture.requests[0]?.method, "pane.report_agent_session");
			assert.deepEqual(paneStates(fixture.requests), ["blocked"]);
		} finally {
			block.release();
		}
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

	it("uses .js extensions on its own sibling imports, like the llama builtin", async () => {
		// The ESM `.js` form applies to modules this extension owns. Imports that
		// reach into `src/core` deliberately keep `.ts`: those modules are spelled
		// `.ts` everywhere else in the repository, and
		// `test/unit/module-import-specifier-consistency.test.ts` requires one
		// spelling per module. The llama builtin resolves the same tension the same
		// way, so this asserts the sibling half and leaves the cross-directory half
		// to that repository-wide test.
		const files = ["index.ts", "reporter.ts", "transport.ts", "reducer.ts", "sequence.ts", "types.ts"];
		const relativeImport = /\bfrom\s+"(\.[^"]*)"/g;
		const offenders: string[] = [];
		for (const file of files) {
			const source = await readFile(join(import.meta.dirname, "..", "src", "extensions", "herdr", file), "utf8");
			for (const match of source.matchAll(relativeImport)) {
				const specifier = match[1] ?? "";
				if (!specifier.startsWith("./")) continue;
				if (!specifier.endsWith(".js")) offenders.push(`${file}: ${specifier}`);
			}
		}
		assert.deepEqual(offenders, []);
	});
});
