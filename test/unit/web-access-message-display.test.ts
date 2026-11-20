import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@bastani/atomic";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, describe, it, vi } from "vitest";
import { type CustomMessageEntry, SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";

interface CuratorCallbacks {
	onSubmit(payload: { selectedQueryIndices: number[]; rawResults: boolean }): void;
}

const web = vi.hoisted(() => ({
	cookiesAllowed: false,
	cookies: null as object | null,
	email: null as string | null,
	curator: null as CuratorCallbacks | null,
	opened: () => {},
	saved: [] as object[],
}));

vi.mock("../../packages/web-access/web-search-config.js", async (actual) => ({
	...(await actual<object>()),
	loadConfigForExtensionInit: async () => ({}),
	resolveWorkflow: () => "none",
	saveConfig: async (updates: object) => {
		web.saved.push(updates);
	},
	loadCuratorBootstrap: async () => ({ availableProviders: {}, defaultProvider: "exa", timeoutSeconds: 1 }),
	normalizeQueryList: (queries: string[]) => queries,
}));
vi.mock("../../packages/web-access/web-search-features.js", () => ({ registerWebSearchFeatures() {} }));
vi.mock("../../packages/web-access/storage.js", async (actual) => ({
	...(await actual<object>()),
	createResultStorage: () => ({ deleteResult() {}, getAllResults: () => [] }),
}));
vi.mock("../../packages/web-access/gemini-web-config.ts", async (actual) => ({
	...(await actual<object>()),
	isBrowserCookieAccessAllowed: async () => web.cookiesAllowed,
}));
vi.mock("../../packages/web-access/gemini-web.js", async (actual) => ({
	...(await actual<object>()),
	isGeminiWebAvailable: async () => web.cookies,
	getActiveGoogleEmail: async () => web.email,
}));
vi.mock("../../packages/web-access/curator-server.js", () => ({
	startCuratorServer: async (_options: object, callbacks: CuratorCallbacks) => {
		web.curator = callbacks;
		return { url: "http://example.test", close() {}, searchesDone() {} };
	},
}));
vi.mock("../../packages/web-access/web-search-browser.js", () => ({
	openCuratorWindow: async () => web.opened(),
}));
vi.mock("../../packages/web-access/web-search-summary.js", () => ({
	loadSummaryModelChoices: async () => ({ summaryModels: [], defaultSummaryModel: null }),
	resolveSummaryForSubmit: () => ({ approvedSummary: "", summaryMeta: undefined }),
}));

interface CommandModule {
	registerWebSearchCommand(
		pi: ExtensionAPI,
		deps: {
			state: { activeCurator: { close(): void } | null };
			closeCurator(): void;
			buildSearchReturn(
				options: object,
			): Promise<{ content: Array<{ type: string; text: string }>; details: object }>;
		},
	): void;
}

const { default: webAccessCommands } = await vi.importActual<{ default: (pi: ExtensionAPI) => Promise<void> }>(
	"../../packages/web-access/index-heavy.js",
);
const { registerWebSearchCommand } = await vi.importActual<CommandModule>(
	"../../packages/web-access/web-search-command.js",
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function directory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "web-access-display-"));
	cleanups.push(() => rm(path, { recursive: true, force: true }));
	return path;
}

/** Run /curator, /google-account and /websearch as a user would, then return the session to reopen. */
async function runCommands(manager: SessionManager): Promise<void> {
	const harness = await createHarness({
		sessionManager: manager,
		extensionFactories: [
			webAccessCommands,
			(pi: ExtensionAPI) =>
				registerWebSearchCommand(pi, {
					state: { activeCurator: null },
					closeCurator() {},
					buildSearchReturn: async () => ({ content: [{ type: "text", text: "Search results" }], details: {} }),
				}),
		],
	});
	cleanups.push(async () => harness.cleanup());
	harness.setResponses(Array.from({ length: 5 }, (_, i) => fauxAssistantMessage(`reply ${i}`)));
	await harness.session.bindExtensions({});
	await harness.session.prompt("start");
	const runner = harness.session.extensionRunner;
	const run = async (name: string, args = "") => {
		const command = runner.getCommand(name);
		assert.ok(command, name);
		await command.handler(args, runner.createCommandContext());
		await harness.session.agent.waitForIdle();
	};
	web.saved = [];
	await run("curator", "on");
	await run("curator", "off");
	assert.deepEqual(web.saved, [{ workflow: "summary-review" }, { workflow: "none" }]);
	web.cookiesAllowed = false;
	await run("google-account");
	web.cookiesAllowed = true;
	web.cookies = null;
	await run("google-account");
	web.cookies = {};
	web.email = "someone@example.com";
	await run("google-account");
	const opened = Promise.withResolvers<void>();
	web.opened = opened.resolve;
	const search = run("websearch", "release notes");
	await opened.promise;
	web.curator?.onSubmit({ selectedQueryIndices: [], rawResults: true });
	await search;
}

const NOTICES: Array<[string, boolean]> = [
	["curator-config", true],
	["curator-config", true],
	["google-account", true],
	["google-account", true],
	["google-account", true],
	["web-search-results", true],
];

function notices(manager: SessionManager): Array<[string, boolean]> {
	return manager
		.getEntries()
		.filter((entry): entry is CustomMessageEntry => entry.type === "custom_message")
		.map((entry) => [entry.customType, entry.display]);
}

describe("/curator, /google-account and /websearch messages (#6097)", () => {
	it("save a boolean display and reopen from JSONL (#6097)", async () => {
		const dir = await directory();
		const manager = await SessionManager.create(dir, dir);
		await runCommands(manager);
		const path = manager.getSessionFile();
		assert.ok(path);
		const saved = (await readFile(path, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; customType?: string; display?: unknown });
		assert.deepEqual(
			saved.filter((entry) => entry.type === "custom_message").map((entry) => [entry.customType, entry.display]),
			NOTICES,
		);
		assert.deepEqual(notices(await SessionManager.open(path)), NOTICES);
	});

	it("save a boolean display and reopen from SQLite (#6097)", async () => {
		const dir = await directory();
		const database = await openNodeSqliteDatabase(join(dir, "sessions.db"));
		const store = await SqlSessionStore.open(database);
		cleanups.push(async () => {
			await store.close();
			await database.close();
		});
		const manager = await SessionManager.create(store, dir);
		await runCommands(manager);
		const rows = await database.all<{ entry_json: string }>(
			"SELECT entry_json FROM session_entries WHERE session_id = ? ORDER BY seq",
			manager.getSessionId(),
		);
		const saved = rows.map(
			(row) => JSON.parse(row.entry_json) as { type: string; customType?: string; display?: unknown },
		);
		assert.deepEqual(
			saved.filter((entry) => entry.type === "custom_message").map((entry) => [entry.customType, entry.display]),
			NOTICES,
		);
		assert.deepEqual(notices(await SessionManager.open(store, manager.getSessionId())), NOTICES);
	});
});
