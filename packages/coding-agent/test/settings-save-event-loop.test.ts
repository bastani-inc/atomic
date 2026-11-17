import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, it } from "vitest";
import { bunExecutable, spawnSyncCollect } from "../../../test/helpers/runtime.js";
import { SettingsManager } from "../src/core/settings-manager.ts";

const MANAGER_MODULE = fileURLToPath(new URL("../src/core/settings-manager.ts", import.meta.url));
/** A real Bun child process that saves and exits. */
const EXITING_CHILD_TIMEOUT_MS = 60_000;

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

it(
	"writes a setting saved just before the process exits",
	() => {
		const script = `import { SettingsManager } from ${JSON.stringify(MANAGER_MODULE)};
const manager = SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)}, { projectTrusted: false });
manager.setTheme("dark");
await Promise.resolve();
process.exit(0);`;
		const result = spawnSyncCollect([bunExecutable(), "-e", script]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).theme, "dark");
	},
	EXITING_CHILD_TIMEOUT_MS,
);

it(
	"writes a setting whose save holds the settings lock as the process exits",
	() => {
		const script = `import { watch } from "node:fs";
import { SettingsManager } from ${JSON.stringify(MANAGER_MODULE)};
const watcher = watch(${JSON.stringify(agentDir)}, (_event, name) => {
	if (name?.startsWith("settings.json.lock.holder.") && name.endsWith(".tmp")) process.exit(0);
});
const manager = SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)}, { projectTrusted: false });
manager.setTheme("dark");
await manager.flush();
watcher.close();
process.exit(3);`;
		const result = spawnSyncCollect([bunExecutable(), "-e", script]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).theme, "dark");
	},
	EXITING_CHILD_TIMEOUT_MS,
);

it(
	"writes a setting whose save has just created the settings lock as the process exits",
	() => {
		const script = `import { watch } from "node:fs";
import { SettingsManager } from ${JSON.stringify(MANAGER_MODULE)};
const watcher = watch(${JSON.stringify(agentDir)}, (_event, name) => {
	if (name === "settings.json.lock") process.exit(0);
});
const manager = SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)}, { projectTrusted: false });
manager.setTheme("dark");
await manager.flush();
watcher.close();
process.exit(3);`;
		const result = spawnSyncCollect([bunExecutable(), "-e", script]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).theme, "dark");
		assert.equal(existsSync(join(agentDir, "settings.json.lock")), false);
	},
	EXITING_CHILD_TIMEOUT_MS,
);

it("reads back, in a manager created afterwards, what another manager of this process saved", async () => {
	const first = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	first.setTheme("dark");
	const second = await SettingsManager.createAsync(cwd, agentDir, { projectTrusted: false });
	assert.equal(second.getTheme(), "dark");
});
