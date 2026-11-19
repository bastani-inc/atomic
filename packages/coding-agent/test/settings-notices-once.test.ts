import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, it, type MockInstance, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { removeSavedModelRoutingSettings, runMigrations } from "../src/migrations.js";
import {
	clearDeprecationWarningsForTests,
	loadShownDeprecationNotices,
	saveShownDeprecationNotices,
	setDeprecationWarningSink,
	showHeldDeprecationWarnings,
} from "../src/utils/deprecation.js";

const ROUTING = { allowedProviders: ["anthropic"] };
/** A child Node process loads the deprecation module from source: structural, not a slow test. */
const CHILD_PROCESS_TIMEOUT_MS = 60_000;
/** How long each process of the concurrent-save test stays between reading the record and replacing it. */
const INSIDE_SAVE_MS = 800;
// Atomic's sources import `.js` specifiers that name `.ts` files; this hook resolves them for Node.
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`;

describe("settings notices are shown once", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	let warn: MockInstance<typeof console.warn>;

	const globalPath = () => join(agentDir, "settings.json");
	const warnings = (pattern: RegExp) =>
		warn.mock.calls.map((call) => String(call[0])).filter((line) => pattern.test(line));
	/** One Atomic start as main.ts runs it: the shown-notice record, then the bootstrap settings load. */
	const start = () => {
		loadShownDeprecationNotices(agentDir);
		return SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	};
	/** The process exits, saving the record, and a new one starts with nothing shown yet. */
	const nextProcess = () => {
		saveShownDeprecationNotices();
		clearDeprecationWarningsForTests();
		warn.mockClear();
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-settings-notices-once-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		clearDeprecationWarningsForTests();
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
		vi.unstubAllEnvs();
		clearDeprecationWarningsForTests();
		rmSync(root, { recursive: true, force: true });
	});

	it("removed workflow settings are as silent as unknown settings and record no notice", async () => {
		const projectPath = join(cwd, ".atomic", "settings.json");
		mkdirSync(join(cwd, ".atomic"));
		const noticeRecord = join(agentDir, "shown-notices.json");
		// The same files with the removed names, then with names Atomic never had, each in a fresh process.
		const run = async (workflows: string, showUnknownTargetWarnings: string) => {
			writeFileSync(globalPath(), JSON.stringify({ [workflows]: ["./recipes"] }));
			writeFileSync(
				projectPath,
				JSON.stringify({ [workflows]: { paths: ["flow.ts"] }, intercom: { [showUnknownTargetWarnings]: true } }),
			);
			rmSync(noticeRecord, { force: true });
			const manager = start();
			manager.setProjectTrusted(true);
			await manager.reload();
			const settings = JSON.stringify(manager.getSettings());
			const shown = warn.mock.calls.map((call) => String(call[0]));
			nextProcess();
			return { settings, shown, record: existsSync(noticeRecord) ? readFileSync(noticeRecord, "utf8") : undefined };
		};
		const unknown = await run("neverASetting", "neverAnIntercomSetting");
		const removed = await run("workflows", "showUnknownTargetWarnings");
		assert.deepEqual(removed, {
			...unknown,
			settings: unknown.settings
				.replaceAll("neverASetting", "workflows")
				.replaceAll("neverAnIntercomSetting", "showUnknownTargetWarnings"),
		});
		assert.deepEqual(removed.shown, []);
	});

	it("gives one modelRouting notice when another process holds the file at startup and the migration then removes it", () => {
		writeFileSync(globalPath(), JSON.stringify({ theme: "dark", modelRouting: ROUTING }));
		const release = lockfile.lockSync(globalPath(), { realpath: false, stale: 60_000 });
		let bootstrap: SettingsManager;
		try {
			removeSavedModelRoutingSettings(cwd, { retryLater: true });
			bootstrap = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		} finally {
			release();
		}
		runMigrations(cwd, { projectTrusted: false });

		assert.equal(bootstrap.getSettings().theme, "dark");
		assert.deepEqual(JSON.parse(readFileSync(globalPath(), "utf-8")), { theme: "dark" });
		const shown = warnings(/modelRouting/);
		assert.equal(shown.length, 1, shown.join("\n"));
		assert.match(shown[0]!, /Removed the "modelRouting" setting from global settings/);
	});

	it("gives one modelRouting notice, the ignored one, when the migration cannot remove it either", () => {
		writeFileSync(globalPath(), JSON.stringify({ theme: "dark", modelRouting: ROUTING }));
		const release = lockfile.lockSync(globalPath(), { realpath: false, stale: 60_000 });
		try {
			removeSavedModelRoutingSettings(cwd, { retryLater: true });
			SettingsManager.create(cwd, agentDir, { projectTrusted: false });
			assert.deepEqual(warnings(/modelRouting/), [], "held while the migration may still remove it");
			runMigrations(cwd, { projectTrusted: false });
		} finally {
			release();
		}
		const shown = warnings(/modelRouting/);
		assert.equal(shown.length, 1, shown.join("\n"));
		assert.match(shown[0]!, /Ignored removed setting "modelRouting"/);
	});

	it("still names the ignored modelRouting when a command exits before startup's migration runs", () => {
		writeFileSync(globalPath(), JSON.stringify({ theme: "dark", modelRouting: ROUTING }));
		const release = lockfile.lockSync(globalPath(), { realpath: false, stale: 60_000 });
		try {
			removeSavedModelRoutingSettings(cwd, { retryLater: true });
			SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		} finally {
			release();
		}
		showHeldDeprecationWarnings();
		const shown = warnings(/modelRouting/);
		assert.equal(shown.length, 1, shown.join("\n"));
		assert.match(shown[0]!, /Ignored removed setting "modelRouting"/);
	});

	it("names an ignored routerModel once across starts without rewriting settings.json, and again when it changes", () => {
		const saved = JSON.stringify({ decisionModel: "auto", routerModel: "openai/gpt-6.1-sol" });
		writeFileSync(globalPath(), saved);

		start();
		assert.equal(warnings(/routerModel/).length, 1);
		nextProcess();
		start();
		assert.deepEqual(warnings(/routerModel/), [], "a later start shows nothing");
		assert.equal(readFileSync(globalPath(), "utf-8"), saved, "settings.json is never rewritten for routerModel");
		assert.ok(existsSync(join(agentDir, "shown-notices.json")), "the record is Atomic's own state");

		writeFileSync(globalPath(), JSON.stringify({ decisionModel: "auto", routerModel: "anthropic/claude-sonnet-5" }));
		nextProcess();
		start();
		assert.equal(warnings(/routerModel/).length, 1, "a changed value is named again");
	});

	it(
		"records a held warning that an exiting process shows, so the next start says nothing",
		() => {
			const deprecation = pathToFileURL(fileURLToPath(new URL("../src/utils/deprecation.ts", import.meta.url))).href;
			const script = `
			import { holdDeprecationWarnings, loadShownDeprecationNotices, warnDeprecation } from ${JSON.stringify(deprecation)};
			loadShownDeprecationNotices(${JSON.stringify(agentDir)});
			holdDeprecationWarnings("settings.json");
			warnDeprecation("Ignored removed setting", { hold: "settings.json", once: "settings.json\\0value" });
		`;
			const exitingStart = () =>
				spawnSync(
					process.execPath,
					[
						"--import",
						`data:text/javascript,${encodeURIComponent(RESOLVE_TS_SOURCES)}`,
						"--input-type=module",
						"--eval",
						script,
					],
					{ cwd: root, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
				).stderr;
			assert.match(exitingStart(), /Ignored removed setting/);
			assert.ok(existsSync(join(agentDir, "shown-notices.json")), "the record names the warning the exit showed");
			assert.doesNotMatch(exitingStart(), /Ignored removed setting/, "the next start says nothing");
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	it(
		"keeps the notices of every process that saves the record at the same time",
		async () => {
			const deprecation = pathToFileURL(fileURLToPath(new URL("../src/utils/deprecation.ts", import.meta.url))).href;
			// Each process stays inside its save, between reading the record and replacing it, long enough for the other to
			// read it too: without a lock the second rename replaces the first process's record.
			const script = (notice: string) => `
				import fs from "node:fs";
				import { syncBuiltinESMExports } from "node:module";
				const rename = fs.renameSync;
				fs.renameSync = (from, to) => {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${INSIDE_SAVE_MS});
					rename(from, to);
				};
				syncBuiltinESMExports();
				const { loadShownDeprecationNotices, warnDeprecation } = await import(${JSON.stringify(deprecation)});
				loadShownDeprecationNotices(${JSON.stringify(agentDir)});
				warnDeprecation(${JSON.stringify(notice)}, { once: ${JSON.stringify(`${notice} file`)} });
			`;
			const run = (notice: string) =>
				new Promise<number | null>((resolveExit) => {
					const child = spawn(
						process.execPath,
						[
							"--import",
							`data:text/javascript,${encodeURIComponent(RESOLVE_TS_SOURCES)}`,
							"--input-type=module",
							"--eval",
							script(notice),
						],
						{ cwd: root, stdio: "ignore", env: { ...process.env, NO_COLOR: "1" } },
					);
					child.on("close", resolveExit);
				});
			assert.deepEqual(await Promise.all([run("first notice"), run("second notice")]), [0, 0]);
			const record = JSON.parse(readFileSync(join(agentDir, "shown-notices.json"), "utf-8")) as { shown: string[] };
			assert.equal(record.shown.length, 2, "both processes' notices are in the record");
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	it("shows a notice printed before the UI started in the UI, and records it once shown there", () => {
		writeFileSync(globalPath(), JSON.stringify({ decisionModel: "auto", routerModel: "openai/gpt-6.1-sol" }));
		start();
		const ui: string[] = [];
		const restore = setDeprecationWarningSink((message) => ui.push(message));
		restore();
		assert.equal(ui.filter((message) => message.includes("routerModel")).length, 1, "the UI shows it");
		nextProcess();
		start();
		const later: string[] = [];
		setDeprecationWarningSink((message) => later.push(message))();
		assert.deepEqual(warnings(/routerModel/), []);
		assert.deepEqual(later, [], "a later start shows nothing, on stderr or in the UI");
	});

	it("does not name an ignored routerModel again when a later start saves another setting", async () => {
		writeFileSync(globalPath(), JSON.stringify({ decisionModel: "auto", routerModel: "openai/gpt-6.1-sol" }));
		start();
		nextProcess();
		const manager = start();
		manager.setTheme("light");
		await manager.flush();
		assert.deepEqual(warnings(/routerModel/), []);
	});

	it.skipIf(process.platform === "win32")("keeps the record readable by its owner only", () => {
		writeFileSync(globalPath(), JSON.stringify({ decisionModel: "auto", routerModel: "openai/gpt-6.1-sol" }));
		start();
		saveShownDeprecationNotices();
		assert.equal(statSync(join(agentDir, "shown-notices.json")).mode & 0o777, 0o600);
		writeFileSync(globalPath(), JSON.stringify({ decisionModel: "auto", routerModel: "anthropic/claude-sonnet-5" }));
		nextProcess();
		start();
		saveShownDeprecationNotices();
		assert.equal(statSync(join(agentDir, "shown-notices.json")).mode & 0o777, 0o600, "kept when it is replaced");
	});

	it("registers one exit handler that shows held warnings and then saves the record", async () => {
		vi.resetModules();
		const fresh = await import("../src/utils/deprecation.js");
		const before = process.listenerCount("exit");
		fresh.loadShownDeprecationNotices(agentDir);
		fresh.holdDeprecationWarnings("settings.json");
		fresh.deferDeprecationWarnings();
		const added = process.listeners("exit").slice(before);
		try {
			assert.equal(added.length, 1);
		} finally {
			for (const listener of added) process.removeListener("exit", listener);
			fresh.clearDeprecationWarningsForTests();
		}
	});

	it("names an invalid routerModel once across starts", () => {
		writeFileSync(globalPath(), JSON.stringify({ routerModel: " openai/gpt-6.1-sol " }));
		start();
		assert.equal(warnings(/invalid legacy "routerModel"/).length, 1);
		nextProcess();
		start();
		assert.deepEqual(warnings(/routerModel/), []);
	});
});
