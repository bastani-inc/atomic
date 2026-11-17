import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

/** How often the probe timer ticks while a save waits for a lock another process holds. */
const PROBE_INTERVAL_MS = 5;
/** Ticks the probe must see during that wait, which lasts about 200 ms: a blocked event loop sees none. */
const MIN_PROBE_TICKS = 5;

let directory: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-settings-save-loop-")));
	cwd = join(directory, "project");
	agentDir = join(directory, "agent");
	mkdirSync(join(cwd, ".atomic"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light" }));
	writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify({ quietStartup: true }));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

it("waits for another process's settings lock without blocking the event loop", async () => {
	// A fresh lock with no holder record: another process holds it, and it is not stale.
	mkdirSync(join(agentDir, "settings.json.lock"));
	const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	manager.setTheme("dark");
	let ticks = 0;
	const probe = setInterval(() => {
		ticks += 1;
	}, PROBE_INTERVAL_MS);
	try {
		await manager.flush();
	} finally {
		clearInterval(probe);
	}
	const errors = manager.drainErrors().map(({ error }) => error.message);
	assert.equal(errors.length, 1);
	assert.match(errors[0]!, /already being held/);
	assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).theme, "light");
	assert.ok(ticks >= MIN_PROBE_TICKS, `the event loop ran only ${ticks} times while the save waited`);
});

it("loads the same settings asynchronously as synchronously", async () => {
	const loaded = SettingsManager.create(cwd, agentDir);
	const loadedAsync = await SettingsManager.createAsync(cwd, agentDir);
	assert.deepEqual(loadedAsync.getSettings(), loaded.getSettings());
	assert.equal(loadedAsync.getTheme(), "light");
	assert.equal(loadedAsync.getQuietStartup(), true);
	assert.deepEqual(loadedAsync.drainErrors(), loaded.drainErrors());
});

it("serves the project settings it reads once trust is granted, without blocking", async () => {
	const manager = await SettingsManager.createAsync(cwd, agentDir, { projectTrusted: false });
	assert.equal(manager.getQuietStartup(), false);
	await manager.setProjectTrustedAsync(true);
	assert.equal(manager.isProjectTrusted(), true);
	assert.equal(manager.getQuietStartup(), true);
});
