import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { exitOnDecisionConfigError } from "../../packages/coding-agent/src/cli/settings-startup.js";
import { DecisionConfigError } from "../../packages/coding-agent/src/core/decision/errors.js";
import { InMemorySettingsStorage, SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { clearDeprecationWarningsForTests } from "../../packages/coding-agent/src/utils/deprecation.js";

const directories: string[] = [];

function workspace(global?: object, project?: object): { cwd: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "atomic-decision-rename-"));
	directories.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".atomic"), { recursive: true });
	if (global) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global));
	if (project) writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify(project));
	return { cwd, agentDir };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
	clearDeprecationWarningsForTests();
});

test("a global routerModel migrates without blocking startup or rewriting the file (#4526)", () => {
	const { cwd, agentDir } = workspace({ routerModel: "typesafe/jev-latest", theme: "dark" });
	const before = readFileSync(join(agentDir, "settings.json"), "utf8");
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const manager = SettingsManager.create(cwd, agentDir);
	assert.equal(manager.getDecisionModel(), "typesafe/jev-latest");
	assert.equal(Object.hasOwn(manager.getSettings(), "routerModel"), false);
	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), before);
	assert.equal(warning.mock.calls.length, 0);
});

test("a project's routerModel migrates only after trust, and distrusting drops it (#4526)", () => {
	const { cwd, agentDir } = workspace({ decisionModel: "global/model" }, { routerModel: "project/model" });
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	assert.equal(settings.getDecisionModel(), "global/model");
	assert.deepEqual(settings.getProjectSettings(), {});
	settings.setProjectTrusted(true);
	assert.equal(settings.isProjectTrusted(), true);
	assert.equal(settings.getDecisionModel(), "project/model");
	assert.deepEqual(settings.getProjectSettings(), { decisionModel: "project/model" });
	assert.equal(SettingsManager.create(cwd, agentDir).getDecisionModel(), "project/model");
	settings.setProjectTrusted(false);
	assert.equal(settings.getDecisionModel(), "global/model");
	assert.deepEqual(settings.getProjectSettings(), {});
});

test("SDK routerModel settings migrate in memory and as overrides without mutating input (#4526)", () => {
	const input = { routerModel: "auto" };
	const manager = SettingsManager.inMemory(input as Parameters<typeof SettingsManager.inMemory>[0]);
	assert.equal(manager.getDecisionModel(), "auto");
	const overrides = { routerModel: "x/y" };
	manager.applyOverrides(overrides as Parameters<typeof manager.applyOverrides>[0]);
	assert.equal(manager.getDecisionModel(), "x/y");
	assert.equal(Object.hasOwn(manager.getSettings(), "routerModel"), false);
	assert.deepEqual(input, { routerModel: "auto" });
	assert.deepEqual(overrides, { routerModel: "x/y" });
});

test("reload migrates routerModel like other legacy settings (#4526)", async () => {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify({ decisionModel: "auto" }));
	const manager = SettingsManager.fromStorage(storage);
	storage.withLock("global", () => JSON.stringify({ routerModel: "x/y" }));
	await manager.reload();
	assert.equal(manager.getDecisionModel(), "x/y");
	assert.equal(Object.hasOwn(manager.getSettings(), "routerModel"), false);
});

test("decisionModel wins over routerModel with a one-time warning in every settings scope (#4526)", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const input = { routerModel: "old/model", decisionModel: "new/model" };
	const { cwd, agentDir } = workspace(input, input);
	const manager = SettingsManager.create(cwd, agentDir);
	assert.deepEqual(manager.getGlobalSettings(), { decisionModel: "new/model" });
	assert.deepEqual(manager.getProjectSettings(), { decisionModel: "new/model" });
	await manager.reload();
	const sdk = SettingsManager.inMemory(input);
	sdk.applyOverrides(input);
	assert.equal(sdk.getDecisionModel(), "new/model");
	assert.equal(Object.hasOwn(sdk.getSettings(), "routerModel"), false);
	assert.equal(warning.mock.calls.length, 1);
	assert.match(warning.mock.calls[0]![0], /routerModel.*decisionModel/);
});

test("invalid routerModel values are dropped with a one-time warning, not a startup error (#4526)", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	for (const routerModel of [null, 42, false, {}, [], " padded/model", "model/id "]) {
		const input = { routerModel };
		const { cwd, agentDir } = workspace(input, input);
		const manager = SettingsManager.create(cwd, agentDir);
		assert.equal(manager.getDecisionModel(), "");
		assert.deepEqual(manager.getGlobalSettings(), {});
		assert.deepEqual(manager.getProjectSettings(), {});
		await manager.reload();
		const sdk = SettingsManager.inMemory(input as Parameters<typeof SettingsManager.inMemory>[0]);
		assert.equal(sdk.getDecisionModel(), "");
		sdk.setDecisionModel("keep/model");
		sdk.applyOverrides(input as Parameters<typeof sdk.applyOverrides>[0]);
		assert.equal(sdk.getDecisionModel(), "keep/model");
		assert.equal(Object.hasOwn(sdk.getSettings(), "routerModel"), false);
	}
	assert.equal(warning.mock.calls.length, 1);
	assert.match(warning.mock.calls[0]![0], /invalid.*routerModel/i);
});

test("decisionModel loads, and other load failures stay recorded warnings", () => {
	const { cwd, agentDir } = workspace({ decisionModel: "typesafe/jev-latest" });
	assert.equal(SettingsManager.create(cwd, agentDir).getDecisionModel(), "typesafe/jev-latest");
	writeFileSync(join(agentDir, "settings.json"), "{ not json");
	const broken = SettingsManager.create(cwd, agentDir);
	assert.equal(broken.drainErrors().length, 1);
});

test("CLI startup prints an invalid-setting message and hint once and exits 1 without a stack", () => {
	const printed: string[] = [];
	const exits: number[] = [];
	const io = {
		error: (text: string) => printed.push(text),
		exit: (code: number): never => {
			exits.push(code);
			throw new Error(`exit ${code}`);
		},
	};
	const failure = new DecisionConfigError({
		code: "invalid-setting",
		source: "settings",
		field: "decisionModel",
		scope: "global",
	});
	assert.throws(() => exitOnDecisionConfigError(failure, io), /exit 1/);
	assert.deepEqual(exits, [1]);
	assert.equal(printed.length, 1);
	assert.ok(printed[0]!.endsWith(failure.message));
	assert.doesNotMatch(printed[0]!, /\n\s+at /);
});

test("CLI startup writes to stderr and exits the process by default", () => {
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
		throw new Error(`process exit ${code}`);
	});
	assert.throws(
		() =>
			exitOnDecisionConfigError(
				new DecisionConfigError({ code: "invalid-setting", source: "settings", field: "decisionModel" }),
			),
		/process exit 1/,
	);
	assert.equal(errorSpy.mock.calls.length, 1);
	assert.match(errorSpy.mock.calls[0]![0], /Invalid decision model setting/);
	assert.deepEqual(exitSpy.mock.calls, [[1]]);
});

test("CLI startup rethrows any other failure untouched", () => {
	const io = {
		error: () => assert.fail("nothing to print"),
		exit: (): never => assert.fail("no exit"),
	};
	const unrelated = new TypeError("storage exploded");
	assert.throws(
		() => exitOnDecisionConfigError(unrelated, io),
		(error: unknown) => error === unrelated,
	);
	assert.throws(
		() => exitOnDecisionConfigError("text", io),
		(error: unknown) => error === "text",
	);
});
