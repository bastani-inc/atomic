import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, it, type MockInstance, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { removeSavedModelRoutingSettings, runMigrations } from "../src/migrations.js";
import {
	clearDeprecationWarningsForTests,
	loadShownDeprecationNotices,
	saveShownDeprecationNotices,
	showHeldDeprecationWarnings,
} from "../src/utils/deprecation.js";

const ROUTING = { allowedProviders: ["anthropic"] };

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

	it("names an invalid routerModel once across starts", () => {
		writeFileSync(globalPath(), JSON.stringify({ routerModel: " openai/gpt-6.1-sol " }));
		start();
		assert.equal(warnings(/invalid legacy "routerModel"/).length, 1);
		nextProcess();
		start();
		assert.deepEqual(warnings(/routerModel/), []);
	});
});
