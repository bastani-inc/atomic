import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionResourceCleanup } from "@bastani/pi-ai/compat";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.js";
import type { AgentSession } from "../src/core/agent-session.js";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getDefaultSessionDirPath } from "../src/core/session-manager-paths.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SessionExistsError, SessionNotFoundError } from "../src/core/storage/session/errors.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { createSessionManager } from "../src/main-session.ts";
import type { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { runCliProcess } from "./cli-test-helpers.ts";
import { createHarness } from "./suite/harness.ts";

const roots: string[] = [];
const REAL_RPC_IDENTITY_TIMEOUT_MS = 120_000;
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-session-identity-"));
	roots.push(cwd);
	return { cwd, directory: join(cwd, "sessions") };
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("CLI resolves a session ID prefix without treating its location as identity", async () => {
	const { cwd, directory } = fixture();
	const original = await SessionManager.create(cwd, directory, { id: "12345678-1234-7123-8123-123456789abc" });
	await original.appendMessage({ role: "user", content: "  verbatim  ", timestamp: Date.now() });
	const resumed = await createSessionManager(
		parseArgs(["--session", "12345678"]),
		cwd,
		directory,
		SettingsManager.inMemory(),
	);
	assert.equal(resumed.getSessionId(), original.getSessionId());
	assert.deepEqual(resumed.getEntries(), original.getEntries());
	await assert.rejects(resumed.openSessionById(original.getSessionFile()!), SessionNotFoundError);
});

test("CLI imports a JSONL export into configured storage with its immutable ID and entries", async () => {
	const { cwd, directory } = fixture();
	const source = await SessionManager.create(cwd, join(cwd, "exports"), { id: "raw-import-id" });
	await source.appendMessage({ role: "user", content: "  raw text  ", timestamp: Date.now() });
	const imported = await createSessionManager(
		parseArgs(["--import", source.getSessionFile()!]),
		cwd,
		directory,
		SettingsManager.inMemory(),
	);
	assert.equal(imported.getSessionId(), source.getSessionId());
	assert.deepEqual(imported.getEntries(), source.getEntries());
	assert.notEqual(imported.getSessionFile(), source.getSessionFile());
	assert.deepEqual((await imported.openSessionById(source.getSessionId())).getEntries(), source.getEntries());
	await assert.rejects(imported.importFromJsonl(source.getSessionFile()!), SessionExistsError);
});

test.each([
	["--session", "source"],
	["--fork", "source"],
	["--session-id", "target"],
	["--continue"],
	["--resume"],
	["--fork", "source", "--session-id", "target"],
	["--session", ""],
	["--fork", ""],
	["--session-id", ""],
])("CLI rejects import selectors %j before writing storage (#3683)", async (...selectors) => {
	const { cwd, directory } = fixture();
	const source = await SessionManager.create(cwd, join(cwd, "exports"), { id: "source" });
	const flags = selectors.filter((value) => value.startsWith("--"));
	for (const memory of [false, true]) {
		await assert.rejects(
			createSessionManager(
				parseArgs(["--import", source.getSessionFile()!, ...selectors, ...(memory ? ["--no-session"] : [])]),
				cwd,
				directory,
				SettingsManager.inMemory(),
			),
			{
				name: "SessionSelectorConflictError",
				code: "SessionSelectorConflict",
				message: `--import cannot be combined with ${flags.join(", ")}. Use --import alone, optionally with --no-session or --session-dir.`,
			},
		);
		assert.equal(existsSync(directory), false);
	}
});

test(
	"CLI reports import conflicts before opening the source (#3683)",
	async () => {
		const { cwd, directory } = fixture();
		const result = await runCliProcess(
			[
				"--no-session",
				"--session-dir",
				directory,
				"--import",
				"missing.jsonl",
				"--fork",
				"source",
				"--session-id",
				"target",
				"-p",
				"unused",
			],
			{ cwd, env: { ...process.env, [ENV_AGENT_DIR]: join(cwd, "agent"), FORCE_COLOR: "0", ATOMIC_OFFLINE: "1" } },
		);
		assert.equal(result.timedOut, false);
		assert.equal(result.code, 1);
		assert.equal(
			result.stderr.trim(),
			"Error: --import cannot be combined with --fork, --session-id. Use --import alone, optionally with --no-session or --session-dir.",
		);
		assert.equal(existsSync(directory), false);
	},
	REAL_RPC_IDENTITY_TIMEOUT_MS,
);

test("JSONL import writes into an explicitly selected memory store", async () => {
	const { cwd, directory } = fixture();
	const source = await SessionManager.create(cwd, directory);
	await source.appendSessionInfo(" raw name ");
	const store = new MemorySessionStore();
	const active = await SessionManager.create(store, cwd);
	const imported = await active.importFromJsonl(source.getSessionFile()!);
	assert.equal(imported.getSessionId(), source.getSessionId());
	assert.equal(imported.getSessionFile(), undefined);
	assert.deepEqual((await store.load(imported.getSessionId())).entries, source.getEntries());
});

test("import and CLI lookup preserve a stored ID verbatim even when it contains path characters", async () => {
	const { cwd, directory } = fixture();
	const source = await JsonlSessionStore.open(join(cwd, "exports"));
	const header = { id: "  session/雪  ", version: 4 as const, createdAt: new Date().toISOString(), cwd };
	try {
		await source.create(header, []);
		const imported = await SessionManager.importFromJsonl(source.locationFor(header), cwd, directory);
		assert.equal(imported.getSessionId(), header.id);
		assert.deepEqual(imported.getHeader(), { type: "session", ...header });
		const resumed = await createSessionManager(
			parseArgs(["--session", header.id]),
			cwd,
			directory,
			SettingsManager.inMemory(),
		);
		assert.equal(resumed.getSessionId(), header.id);
	} finally {
		await source.close();
	}
});

type SelectorHost = {
	sessionManager: SessionManager;
	session: Pick<AgentSession, "setSessionName">;
	keybindings: KeybindingsManager;
	ui: { requestRender(): void };
	showSelector(factory: (done: () => void) => { component: SessionSelectorComponent }): void;
};
test("renaming the active session in the selector appends exactly once and keeps its writer current", async () => {
	const { cwd, directory } = fixture();
	const manager = await SessionManager.create(cwd, directory);
	await manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	const mirror = await manager.openSessionById(manager.getSessionId());
	const harness = await createHarness({ sessionManager: manager });
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	initTheme("dark");
	let selector!: SessionSelectorComponent;
	const host: SelectorHost = {
		sessionManager: mirror,
		session: harness.session,
		keybindings,
		ui: { requestRender() {} },
		showSelector(factory) {
			selector = factory(() => {}).component;
		},
	};
	const show = Reflect.get(InteractiveMode.prototype, "showSessionSelector") as (this: SelectorHost) => void;
	show.call(host);
	try {
		await vi.waitFor(() => assert.equal(selector.getSessionList().getSelectedSessionId(), manager.getSessionId()));
		selector.handleInput("\x1b[114;5u");
		selector.handleInput("new name");
		selector.handleInput("\r");
		await vi.waitFor(() => assert.equal(manager.getSessionName(), "new name"));
		await manager.appendMessage({ role: "user", content: "after rename", timestamp: Date.now() });
		const reopened = await manager.openSessionById(manager.getSessionId());
		assert.equal(reopened.getEntries().filter((entry) => entry.type === "session_info").length, 1);
		assert.deepEqual(reopened.getEntries(), manager.getEntries());
	} finally {
		selector.dispose();
		await harness.cleanup();
	}
});

test.each(["shared-id", "active-id"])(
	"selector rename keeps duplicate project-local IDs in the selected store with active ID %s",
	async (activeId) => {
		const { cwd } = fixture();
		vi.stubEnv(ENV_AGENT_DIR, join(cwd, "agent"));
		const active = await SessionManager.create(cwd, getDefaultSessionDirPath(cwd), { id: activeId });
		const foreignCwd = join(cwd, "foreign");
		const foreign = await SessionManager.create(foreignCwd, getDefaultSessionDirPath(foreignCwd), {
			id: "shared-id",
		});
		await foreign.appendSessionInfo("foreign target");
		const allStores = await JsonlSessionStore.open(join(cwd, "agent", "sessions"));
		const listAll = SessionManager.listAll.bind(SessionManager);
		const listAllStores = vi
			.spyOn(SessionManager, "listAll")
			.mockImplementation(async (_store, onProgress) =>
				listAll(allStores, typeof onProgress === "function" ? onProgress : undefined),
			);
		const harness = await createHarness({ sessionManager: active });
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		initTheme("dark");
		let selector!: SessionSelectorComponent;
		const host: SelectorHost = {
			sessionManager: active,
			session: harness.session,
			keybindings,
			ui: { requestRender() {} },
			showSelector(factory) {
				selector = factory(() => {}).component;
			},
		};
		const show = Reflect.get(InteractiveMode.prototype, "showSessionSelector") as (this: SelectorHost) => void;
		show.call(host);
		try {
			await vi.waitFor(() => assert.equal(selector.getSessionList().getSelectedSessionId(), activeId));
			if (activeId !== "shared-id")
				await SessionManager.create(cwd, getDefaultSessionDirPath(cwd), { id: "shared-id" });
			selector.handleInput("\t");
			await vi.waitFor(() => assert.match(selector.render(120).join("\n"), /foreign target/));
			selector.handleInput("foreign target");
			selector.handleInput("\x1b[114;5u");
			selector.handleInput("renamed ");
			selector.handleInput("\r");
			await vi.waitFor(async () =>
				assert.equal((await foreign.openSessionById("shared-id")).getSessionName(), "renamed foreign target"),
			);
			assert.equal((await active.openSessionById("shared-id")).getSessionName(), undefined);
			assert.equal(active.getSessionName(), undefined);
			await active.appendSessionInfo("active writer still current");
			assert.equal((await active.openSessionById(activeId)).getSessionName(), "active writer still current");
		} finally {
			listAllStores.mockRestore();
			await allStores.close();
			selector.dispose();
			await harness.cleanup();
			vi.unstubAllEnvs();
		}
	},
);

test(
	"real CLI and RPC resume an ID prefix, switch by ID and report a display-only location",
	async () => {
		const { cwd, directory } = fixture();
		const original = await SessionManager.create(cwd, directory, { id: "87654321-1234-7123-8123-123456789abc" });
		const target = await SessionManager.create(cwd, directory, { id: "rpc-target" });
		const client = new RpcClient({
			cwd,
			cliPath: join(import.meta.dirname, "../src/cli.ts"),
			env: { [ENV_AGENT_DIR]: join(cwd, "agent") },
			args: [
				"--session-dir",
				directory,
				"--session",
				"87654321",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
			],
		});
		try {
			await client.start();
			const before = await client.getState();
			assert.equal(before.sessionId, original.getSessionId());
			assert.equal(before.sessionLocation, original.getSessionFile());
			assert.equal("sessionFile" in before, false);
			assert.deepEqual(await client.switchSession(target.getSessionId()), { cancelled: false });
			const after = await client.getState();
			assert.equal(after.sessionId, target.getSessionId());
			assert.equal(after.sessionLocation, target.getSessionFile());
			await assert.rejects(client.switchSession(target.getSessionFile()!));
			assert.equal((await client.getState()).sessionId, target.getSessionId());
		} finally {
			await client.stop();
		}
	},
	REAL_RPC_IDENTITY_TIMEOUT_MS,
);

test(
	"CLI rejects a file path as a session selector without opening or creating a session",
	async () => {
		const { cwd, directory } = fixture();
		const source = await SessionManager.create(cwd, directory, { id: "path-is-not-identity" });
		const path = source.getSessionFile()!;
		const result = await runCliProcess(
			["--session-dir", directory, "--session", path, "--no-extensions", "-p", "unused"],
			{ cwd, env: { ...process.env, [ENV_AGENT_DIR]: join(cwd, "agent"), FORCE_COLOR: "0" } },
		);
		assert.equal(result.timedOut, false);
		assert.equal(result.code, 1);
		assert.equal(result.stderr.trim(), `No session found matching '${path}'`);
		assert.deepEqual(
			(await SessionManager.list(cwd, directory)).map((session) => session.id),
			[source.getSessionId()],
		);
	},
	REAL_RPC_IDENTITY_TIMEOUT_MS,
);

test(
	"RPC explicit memory sessions omit the display location and stay ephemeral after replacement",
	async () => {
		const { cwd } = fixture();
		const client = new RpcClient({
			cwd,
			cliPath: join(import.meta.dirname, "../src/cli.ts"),
			env: { [ENV_AGENT_DIR]: join(cwd, "agent"), ATOMIC_OFFLINE: "1" },
			args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"],
		});
		try {
			await client.start();
			const before = await client.getState();
			assert.equal(typeof before.sessionId, "string");
			assert.equal("sessionLocation" in before, false);
			assert.equal("sessionFile" in before, false);
			assert.deepEqual(await client.newSession(), { cancelled: false });
			const after = await client.getState();
			assert.notEqual(after.sessionId, before.sessionId);
			assert.equal("sessionLocation" in after, false);
		} finally {
			await client.stop();
		}
	},
	REAL_RPC_IDENTITY_TIMEOUT_MS,
);

test(
	"RPC restart resumes an imported session by ID without importing the file a second time",
	async () => {
		const { cwd, directory } = fixture();
		const source = await SessionManager.create(cwd, join(cwd, "exports"), { id: "rpc-import-once" });
		const client = new RpcClient({
			cwd,
			cliPath: join(import.meta.dirname, "../src/cli.ts"),
			env: { [ENV_AGENT_DIR]: join(cwd, "agent"), ATOMIC_OFFLINE: "1" },
			args: ["--session-dir", directory, "--import", source.getSessionFile()!, "--no-extensions"],
		});
		try {
			await client.start();
			const before = await client.getState();
			assert.equal(before.sessionId, source.getSessionId());
			await client.restart(before.sessionId);
			const after = await client.getState();
			assert.equal(after.sessionId, before.sessionId);
			assert.equal(after.sessionLocation, before.sessionLocation);
		} finally {
			await client.stop();
		}
	},
	REAL_RPC_IDENTITY_TIMEOUT_MS,
);

test(
	"RPC restart preserves an empty imported session ID and its persistent store",
	async () => {
		const { cwd, directory } = fixture();
		const source = await JsonlSessionStore.open(join(cwd, "exports"));
		const header = { id: "", version: 4 as const, createdAt: new Date().toISOString(), cwd };
		await source.create(header, []);
		const client = new RpcClient({
			cwd,
			cliPath: join(import.meta.dirname, "../src/cli.ts"),
			env: { [ENV_AGENT_DIR]: join(cwd, "agent"), ATOMIC_OFFLINE: "1" },
			args: ["--session-dir", directory, "--import", source.locationFor(header), "--no-extensions"],
		});
		try {
			await client.start();
			const before = await client.getState();
			assert.equal(before.sessionId, "");
			assert.equal(typeof before.sessionLocation, "string");
			await client.restart(before.sessionId);
			const after = await client.getState();
			assert.equal(after.sessionId, "");
			assert.equal(after.sessionLocation, before.sessionLocation);
			assert.deepEqual(
				(await SessionManager.list(cwd, directory)).map((session) => session.id),
				[""],
			);
			const forked = await createSessionManager(
				parseArgs(["--fork", ""]),
				cwd,
				directory,
				SettingsManager.inMemory(),
			);
			assert.equal(forked.getHeader()?.parentSessionId, "");
		} finally {
			await client.stop();
			await source.close();
		}
	},
	REAL_RPC_IDENTITY_TIMEOUT_MS,
);

test(
	"RPC switch and restart keep a duplicate ID in the selected project store",
	async () => {
		const { cwd, directory } = fixture();
		const foreign = fixture();
		const local = await SessionManager.create(cwd, directory, { id: "shared-rpc-id" });
		const target = await SessionManager.create(foreign.cwd, foreign.directory, { id: "shared-rpc-id" });
		const client = new RpcClient({
			cwd,
			cliPath: join(import.meta.dirname, "../src/cli.ts"),
			env: { [ENV_AGENT_DIR]: join(cwd, "agent"), ATOMIC_OFFLINE: "1" },
			args: ["--session-dir", directory, "--session", local.getSessionId(), "--no-extensions"],
		});
		try {
			await client.start();
			assert.deepEqual(await client.switchSession(target.getSessionId(), undefined, foreign.directory), {
				cancelled: false,
			});
			assert.equal((await client.getState()).sessionLocation, target.getSessionFile());
			await client.restart(target.getSessionId(), { sessionDirectory: foreign.directory, cwd: foreign.cwd });
			assert.equal((await client.getState()).sessionLocation, target.getSessionFile());
		} finally {
			await client.stop();
		}
	},
	REAL_RPC_IDENTITY_TIMEOUT_MS,
);

test.each(["--session-id", "--fork"])(
	"RPC restart consumes the original %s selector before resuming the active ID",
	async (flag) => {
		const { cwd, directory } = fixture();
		const source = await SessionManager.create(cwd, directory, { id: "restart-source" });
		const client = new RpcClient({
			cwd,
			cliPath: join(import.meta.dirname, "../src/cli.ts"),
			env: { [ENV_AGENT_DIR]: join(cwd, "agent"), ATOMIC_OFFLINE: "1" },
			args: ["--session-dir", directory, flag, source.getSessionId(), "--no-extensions"],
		});
		try {
			await client.start();
			const before = await client.getState();
			await client.restart(before.sessionId);
			const after = await client.getState();
			assert.equal(after.sessionId, before.sessionId);
			assert.equal(after.sessionLocation, before.sessionLocation);
		} finally {
			await client.stop();
		}
	},
	REAL_RPC_IDENTITY_TIMEOUT_MS,
);

test("an explicit selected store never falls back to a duplicate ID in another store", async () => {
	const { cwd } = fixture();
	vi.stubEnv(ENV_AGENT_DIR, join(cwd, "agent"));
	try {
		const active = await SessionManager.create(cwd, undefined, { id: "not-in-selected-store" });
		try {
			await assert.rejects(
				active.openSessionById(active.getSessionId(), undefined, join(cwd, "selected-empty-store")),
				SessionNotFoundError,
			);
		} finally {
			await active.getSessionStore().close();
		}
	} finally {
		vi.unstubAllEnvs();
	}
});

test.each(["", "cache-owner"])(
	"disposing session %j never requests another session's provider cache cleanup",
	async (id) => {
		const { cwd } = fixture();
		const store = new MemorySessionStore();
		await store.create({ id, version: 4, createdAt: new Date().toISOString(), cwd }, []);
		const harness = await createHarness({ sessionManager: await SessionManager.open(store, id) });
		const cleanup = vi.fn<(sessionId?: string) => void>();
		const unregister = registerSessionResourceCleanup(cleanup);
		try {
			await harness.cleanup();
			assert.deepEqual(cleanup.mock.calls, id === "" ? [] : [[id]]);
		} finally {
			unregister();
			await harness.cleanup();
			await store.close();
		}
	},
);

test(
	"RPC new sessions preserve an explicitly empty parent session ID",
	async () => {
		const { cwd, directory } = fixture();
		const client = new RpcClient({
			cwd,
			cliPath: join(import.meta.dirname, "../src/cli.ts"),
			env: { [ENV_AGENT_DIR]: join(cwd, "agent"), ATOMIC_OFFLINE: "1" },
			args: ["--session-dir", directory, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"],
		});
		try {
			await client.start();
			assert.deepEqual(await client.newSession(""), { cancelled: false });
			const state = await client.getState();
			const store = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
			try {
				assert.equal((await store.load(state.sessionId)).header.parentSessionId, "");
			} finally {
				await store.close();
			}
		} finally {
			await client.stop();
		}
	},
	REAL_RPC_IDENTITY_TIMEOUT_MS,
);
