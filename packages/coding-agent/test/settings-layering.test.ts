import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { FileSettingsStorage, InMemorySettingsStorage } from "../src/core/settings-storage.ts";

let root: string;
let agentDir: string;
let projectDir: string;
let globalPath: string;
let atomicProjectPath: string;
let piProjectPath: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-settings-layering-"));
	agentDir = join(root, "agent");
	projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".atomic"), { recursive: true });
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	globalPath = join(agentDir, "settings.json");
	atomicProjectPath = join(projectDir, ".atomic", "settings.json");
	piProjectPath = join(projectDir, ".pi", "settings.json");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: object): void {
	writeFileSync(path, JSON.stringify(value));
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function projectManager(atomic: object, pi: object): SettingsManager {
	writeJson(atomicProjectPath, atomic);
	writeJson(piProjectPath, pi);
	return SettingsManager.create(projectDir, agentDir);
}

/** A manager over `~/.atomic/agent` and `~/.pi/agent` style global files, with `atomic` taking precedence. */
function globalLayeredManager(atomic: object, pi: object): SettingsManager {
	const atomicGlobal = join(root, "atomic-agent", "settings.json");
	const piGlobal = join(root, "pi-agent", "settings.json");
	mkdirSync(join(root, "atomic-agent"), { recursive: true });
	mkdirSync(join(root, "pi-agent"), { recursive: true });
	writeJson(atomicGlobal, atomic);
	writeJson(piGlobal, pi);
	const storage = new FileSettingsStorage(projectDir, join(root, "atomic-agent"), {
		globalReadPaths: [atomicGlobal, piGlobal],
		projectReadPaths: [],
	});
	return SettingsManager.fromStorage(storage);
}

test("approval preserves only the settings the user edited that the project actually supplies (#5693)", async () => {
	writeJson(globalPath, { terminal: { showImages: false } });
	writeJson(atomicProjectPath, { terminal: { showImages: true, imageWidthCells: 80 } });
	const manager = await SettingsManager.createAsync(projectDir, agentDir, { projectTrusted: false });
	manager.trackEditsWhileProjectTrustPending(true);
	manager.setShowImages(true);
	manager.setShowImages(false); // Back to its old value is still an explicit choice.
	manager.setTreeFilterMode("all");
	await manager.flush();
	await manager.setProjectTrustedAsync(true);
	manager.trackEditsWhileProjectTrustPending(false);
	expectAfterApproval();
	writeJson(atomicProjectPath, { ...readJson(atomicProjectPath), treeFilterMode: "user-only" });
	await manager.reload();
	assert.equal(manager.getTreeFilterMode(), "user-only", "a later reload is not a setting applied at approval");
	expectAfterApproval();
	manager.setShowImages(false); // A later explicit save to global uses normal project-over-global layering.
	await manager.flush();
	assert.equal(manager.getShowImages(), true);
	assert.equal((readJson(globalPath).terminal as { showImages: boolean }).showImages, false);
	function expectAfterApproval() {
		assert.equal(manager.getShowImages(), false);
		assert.equal(manager.getImageWidthCells(), 80);
		assert.deepEqual(manager.getProjectSettings().terminal, { showImages: true, imageWidthCells: 80 });
	}
});

test("recording a startup notice is not an explicit user preference (#5693)", async () => {
	writeJson(atomicProjectPath, { lastChangelogVersion: "1.0.0" });
	const manager = await SettingsManager.createAsync(projectDir, agentDir, { projectTrusted: false });
	manager.trackEditsWhileProjectTrustPending(true);
	manager.setLastChangelogVersion("2.0.0");
	await manager.flush();
	await manager.setProjectTrustedAsync(true);
	assert.equal(manager.getLastChangelogVersion(), "1.0.0");
});

describe("each settings file is validated on its own (#5049)", () => {
	test("a wrong-typed .atomic value falls through to the valid .pi value (#5049)", () => {
		const manager = projectManager({ extensions: "./bad.ts" }, { extensions: ["./good.ts"] });

		assert.deepEqual(manager.getProjectSettings().extensions, ["./good.ts"]);
		assert.deepEqual(
			manager.drainErrors().map(({ scope, path, invalidKey }) => ({ scope, path, invalidKey })),
			[{ scope: "project", path: atomicProjectPath, invalidKey: "extensions" }],
		);
	});

	test("a wrong-typed .atomic nested block falls through to the .pi block (#5049)", () => {
		const manager = projectManager({ compaction: "bad" }, { compaction: { enabled: false } });

		assert.equal(manager.getCompactionEnabled(), false);
	});

	test("a wrong-typed .pi value is reported naming the .pi file, even when .atomic sets it too (#5049)", () => {
		const manager = projectManager({ extensions: ["./good.ts"] }, { extensions: "./bad.ts" });

		assert.deepEqual(manager.getProjectSettings().extensions, ["./good.ts"]);
		assert.deepEqual(
			manager.drainErrors().map(({ path }) => path),
			[piProjectPath],
		);
	});

	test("an unreadable .pi file is reported naming the .pi file (#5049)", () => {
		writeJson(atomicProjectPath, { theme: "dark" });
		writeFileSync(piProjectPath, "{ not json");

		const manager = SettingsManager.create(projectDir, agentDir);

		assert.deepEqual(
			manager.drainErrors().map(({ scope, path }) => ({ scope, path })),
			[{ scope: "project", path: piProjectPath }],
		);
	});

	test("a wrong-typed ~/.atomic/agent value falls through to ~/.pi/agent (#5049)", () => {
		const manager = globalLayeredManager({ themes: 7 }, { themes: ["./pi-theme.json"] });

		assert.deepEqual(manager.getThemePaths(), ["./pi-theme.json"]);
	});
});

describe("legacy keys are migrated per file before layering (#5049)", () => {
	test(".atomic routerModel wins over .pi decisionModel (#5049)", () => {
		const manager = projectManager({ routerModel: "a/new" }, { decisionModel: "b/old" });
		assert.equal(manager.getProjectSettings().decisionModel, "a/new");
	});

	test(".atomic websockets wins over .pi transport (#5049)", () => {
		const manager = projectManager({ websockets: true }, { transport: "sse" });
		assert.equal(manager.getProjectSettings().transport, "websocket");
	});

	test(".atomic queueMode wins over .pi steeringMode (#5049)", () => {
		const manager = projectManager({ queueMode: "all" }, { steeringMode: "one-at-a-time" });
		assert.equal(manager.getProjectSettings().steeringMode, "all");
	});

	test(".atomic retry.maxDelayMs wins over .pi retry.provider.maxRetryDelayMs (#5049)", () => {
		const manager = projectManager(
			{ retry: { maxDelayMs: 5000 } },
			{ retry: { provider: { maxRetryDelayMs: 1000 } } },
		);
		assert.equal(manager.getProjectSettings().retry?.provider?.maxRetryDelayMs, 5000);
	});

	test("~/.atomic/agent queueMode wins over ~/.pi/agent steeringMode (#5049)", () => {
		const manager = globalLayeredManager({ queueMode: "all" }, { steeringMode: "one-at-a-time" });
		assert.equal(manager.getSteeringMode(), "all");
	});
});

describe("nested setters keep other processes' nested keys (#5049)", () => {
	test("model thinking levels set by two processes are both kept (#5049)", async () => {
		const first = SettingsManager.create(projectDir, agentDir);
		const second = SettingsManager.create(projectDir, agentDir);

		first.setModelThinkingLevel("openai", "gpt-a", "high");
		await first.flush();
		second.setModelThinkingLevel("anthropic", "claude-b", "low");
		await second.flush();

		assert.deepEqual(readJson(globalPath).modelThinkingLevels, {
			"openai/gpt-a": "high",
			"anthropic/claude-b": "low",
		});
	});

	test("removing the last in-memory thinking level keeps another process's entry (#5049)", async () => {
		const first = SettingsManager.create(projectDir, agentDir);
		first.setModelThinkingLevel("openai", "gpt-a", "high");
		await first.flush();
		const second = SettingsManager.create(projectDir, agentDir);
		first.setModelThinkingLevel("anthropic", "claude-b", "low");
		await first.flush();

		second.removeModelThinkingLevel("openai", "gpt-a");
		await second.flush();

		assert.deepEqual(readJson(globalPath).modelThinkingLevels, { "anthropic/claude-b": "low" });
	});

	test("workflow paths and auto-advance set by two processes keep each other and the journal (#5049)", async () => {
		writeJson(globalPath, { workflows: { journal: { memory: true } } });
		const first = SettingsManager.create(projectDir, agentDir);
		const second = SettingsManager.create(projectDir, agentDir);

		first.setWorkflowPaths(["./wf"]);
		await first.flush();
		second.setAutoAdvanceAfterSteer(false);
		await second.flush();

		assert.deepEqual(readJson(globalPath).workflows, {
			journal: { memory: true },
			paths: ["./wf"],
			autoAdvanceAfterSteer: false,
		});
	});

	test("auto-advance set over another process's list-form workflow paths keeps the paths (#5049)", async () => {
		const first = SettingsManager.create(projectDir, agentDir);
		const second = SettingsManager.create(projectDir, agentDir);

		first.setWorkflowPaths(["./wf"]);
		await first.flush();
		second.setAutoAdvanceAfterSteer(false);
		await second.flush();

		assert.deepEqual(readJson(globalPath).workflows, { paths: ["./wf"], autoAdvanceAfterSteer: false });
	});

	test("workflow paths set by a stale process keep another process's auto-advance (#5049)", async () => {
		writeJson(globalPath, { workflows: { journal: { memory: true } } });
		const first = SettingsManager.create(projectDir, agentDir);
		const second = SettingsManager.create(projectDir, agentDir);

		first.setAutoAdvanceAfterSteer(false);
		await first.flush();
		second.setWorkflowPaths(["./wf"]);
		await second.flush();

		assert.deepEqual(readJson(globalPath).workflows, {
			journal: { memory: true },
			autoAdvanceAfterSteer: false,
			paths: ["./wf"],
		});
	});

	test("warning settings write the keys they set and remove the keys they drop (#5049)", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);

		manager.setWarnings({ anthropicExtraUsage: false });
		await manager.flush();
		assert.deepEqual(readJson(globalPath).warnings, { anthropicExtraUsage: false });

		manager.setWarnings({});
		await manager.flush();
		assert.deepEqual(readJson(globalPath).warnings, {});
	});

	test("removing the only thinking level removes the setting from the file (#5049)", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setModelThinkingLevel("openai", "gpt-a", "high");
		await manager.flush();

		manager.removeModelThinkingLevel("openai", "gpt-a");
		await manager.flush();

		assert.equal(Object.hasOwn(readJson(globalPath), "modelThinkingLevels"), false);
	});

	test("list-form workflow paths stay a list unless another process added keys (#5049)", async () => {
		const stale = SettingsManager.create(projectDir, agentDir);
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setWorkflowPaths(["./b"]);
		await manager.flush();
		assert.deepEqual(readJson(globalPath).workflows, ["./b"]);

		manager.setAutoAdvanceAfterSteer(false);
		await manager.flush();
		stale.setWorkflowPaths(["./a"]);
		await stale.flush();

		assert.deepEqual(readJson(globalPath).workflows, { paths: ["./a"], autoAdvanceAfterSteer: false });
	});

	test("project workflow setters keep another process's project workflow keys (#5049)", async () => {
		writeJson(atomicProjectPath, { workflows: { journal: { memory: true } } });
		const first = SettingsManager.create(projectDir, agentDir);
		const second = SettingsManager.create(projectDir, agentDir);

		first.setProjectWorkflowPaths(["./wf"]);
		await first.flush();
		second.setAutoAdvanceAfterSteer(false, "project");
		await second.flush();

		assert.deepEqual(readJson(atomicProjectPath).workflows, {
			journal: { memory: true },
			paths: ["./wf"],
			autoAdvanceAfterSteer: false,
		});
	});
});

describe("applyOverrides last for the run (#5049)", () => {
	test("overrides survive a setting write (#5049)", () => {
		const manager = SettingsManager.inMemory({ theme: "dark" });
		manager.applyOverrides({ theme: "light", compaction: { enabled: false } });

		manager.setDefaultThinkingLevel("high");

		assert.equal(manager.getTheme(), "light");
		assert.equal(manager.getCompactionEnabled(), false);
	});

	test("changing an overridden setting replaces only that override (#5049)", () => {
		const manager = SettingsManager.inMemory({ theme: "dark" });
		manager.applyOverrides({
			theme: "light",
			compaction: { enabled: false, reserveTokens: 1234 },
			workflows: ["./override-wf"],
		});

		manager.setTheme("solarized");
		manager.setCompactionEnabled(true);
		manager.setAutoAdvanceAfterSteer(false);

		assert.equal(manager.getTheme(), "solarized");
		assert.equal(manager.getCompactionEnabled(), true);
		assert.equal(manager.getCompactionReserveTokens(), 1234, "the other overridden compaction key stays");
		assert.deepEqual(manager.getWorkflowPaths(), ["./override-wf"], "list-form workflow paths stay");

		manager.setWorkflowPaths(["./wf"]);
		assert.deepEqual(manager.getWorkflowPaths(), ["./wf"]);
	});

	test("replacing a whole object setting replaces its override (#5049)", () => {
		const manager = SettingsManager.inMemory();
		manager.applyOverrides({ storage: { path: "./override.db" } });

		manager.setStorage({ path: "./chosen.db" });

		assert.deepEqual(manager.getSettings().storage, { path: "./chosen.db" });
	});

	test("overrides survive reload and prepared reloads (#5049)", async () => {
		const manager = SettingsManager.inMemory({ theme: "dark" });
		manager.applyOverrides({ theme: "light" });

		await manager.reload();
		assert.equal(manager.getTheme(), "light");

		const prepared = await manager.prepareReload();
		assert.equal(prepared.settingsManager.getTheme(), "light");
		prepared.commit();
		assert.equal(manager.getTheme(), "light");
	});

	test("overrides survive project trust changes (#5049)", () => {
		writeJson(atomicProjectPath, { theme: "dark" });
		const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
		manager.applyOverrides({ theme: "light" });

		manager.setProjectTrusted(true);
		assert.equal(manager.getTheme(), "light");
		manager.setProjectTrusted(false);
		assert.equal(manager.getTheme(), "light");
	});

	test("overrides are not written to the settings file (#5049)", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.applyOverrides({ theme: "light" });

		manager.setDefaultThinkingLevel("high");
		await manager.flush();

		assert.deepEqual(readJson(globalPath), { defaultThinkingLevel: "high" });
	});
});

describe("settings files are read without the scope's write lock (#5049, #5161)", () => {
	for (const scope of ["global", "project"] as const) {
		test(`reading the ${scope} files goes on while a writer holds the ${scope} lock (#5161)`, () => {
			const path = scope === "global" ? globalPath : atomicProjectPath;
			writeJson(globalPath, {});
			writeJson(atomicProjectPath, {});
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const release = lockfile.lockSync(path, { realpath: false });
			try {
				// Saves replace the file whole with a rename, so a read never needs the lock.
				assert.deepEqual(storage.readLayers(scope), [{ path, content: "{}" }]);
			} finally {
				release();
			}
		});
	}
});

describe("wrong-typed values are reported again after being fixed (#5049)", () => {
	test("a value that becomes invalid again is reported again (#5049)", async () => {
		writeJson(globalPath, { extensions: "./x.ts" });
		const manager = SettingsManager.create(projectDir, agentDir);
		assert.equal(manager.drainErrors().length, 1);

		await manager.reload();
		await manager.reload();
		assert.equal(manager.drainErrors().length, 0, "an unchanged file is not reported twice");

		writeJson(globalPath, { extensions: ["./x.ts"] });
		await manager.reload();
		assert.equal(manager.drainErrors().length, 0);

		writeJson(globalPath, { extensions: "./x.ts" });
		await manager.reload();
		assert.deepEqual(
			manager.drainErrors().map(({ invalidKey }) => invalidKey),
			["extensions"],
		);
	});
});

describe("legacy skills.customDirectories entries are validated (#5049)", () => {
	test("wrong-typed legacy entries are dropped and reported (#5049)", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ skills: { customDirectories: [1, "./a"] } }));

		const manager = SettingsManager.fromStorage(storage);

		assert.deepEqual(manager.getGlobalSettings().skills, ["./a"]);
		assert.deepEqual(
			manager.drainErrors().map(({ invalidKey, error }) => ({ invalidKey, message: error.message })),
			[
				{
					invalidKey: "skills.customDirectories[0]",
					message: '"skills.customDirectories[0]" must be string, not number; ignoring it.',
				},
			],
		);
	});
});
