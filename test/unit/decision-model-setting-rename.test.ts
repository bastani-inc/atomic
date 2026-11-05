import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { exitOnDecisionConfigError } from "../../packages/coding-agent/src/cli/settings-startup.js";
import { DecisionConfigError, isDecisionConfigError } from "../../packages/coding-agent/src/core/decision/errors.js";
import { InMemorySettingsStorage, SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { SettingsScope, SettingsStorage } from "../../packages/coding-agent/src/core/settings-types.js";

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

function renamed(scope: SettingsScope | undefined, source: "settings" | "sdk") {
	return (error: unknown): boolean => {
		assert.ok(isDecisionConfigError(error));
		assert.ok(error instanceof DecisionConfigError);
		assert.equal(error.code, "renamed-setting");
		assert.equal(error.field, "routerModel");
		assert.equal(error.source, source);
		assert.equal(error.scope, scope);
		assert.equal(error.retryable, false);
		assert.match(error.hint, /Rename "routerModel" to "decisionModel"/);
		return true;
	};
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("a global settings file with routerModel fails fast with a typed config error (#4358)", () => {
	const { cwd, agentDir } = workspace({ routerModel: "typesafe/jev-latest", theme: "dark" });
	const before = readFileSync(join(agentDir, "settings.json"), "utf8");
	assert.throws(() => SettingsManager.create(cwd, agentDir), renamed("global", "settings"));
	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), before);
});

test("a trusted project's routerModel fails fast; an untrusted project's settings are never read", () => {
	const { cwd, agentDir } = workspace({}, { routerModel: "" });
	assert.throws(() => SettingsManager.create(cwd, agentDir, { projectTrusted: true }), renamed("project", "settings"));
	const untrusted = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	assert.equal(untrusted.getDecisionModel(), "");
	assert.throws(() => untrusted.setProjectTrusted(true), renamed("project", "settings"));
});

test("the check stops loading at the first settings file, before any other read or write", () => {
	const calls: SettingsScope[] = [];
	const storage: SettingsStorage = {
		withLock(scope, fn) {
			calls.push(scope);
			fn(scope === "global" ? JSON.stringify({ routerModel: "auto" }) : JSON.stringify({ routerModel: "auto" }));
		},
	};
	assert.throws(() => SettingsManager.fromStorage(storage), renamed("global", "settings"));
	assert.deepEqual(calls, ["global"]);
});

test("SDK settings with routerModel fail fast, in memory and as overrides", () => {
	assert.throws(
		() => SettingsManager.inMemory({ routerModel: "auto" } as Parameters<typeof SettingsManager.inMemory>[0]),
		renamed(undefined, "sdk"),
	);
	const manager = SettingsManager.inMemory({ decisionModel: "auto" });
	assert.throws(
		() => manager.applyOverrides({ routerModel: "x/y" } as Parameters<typeof manager.applyOverrides>[0]),
		renamed(undefined, "sdk"),
	);
	assert.equal(manager.getDecisionModel(), "auto");
});

test("a reload that finds routerModel fails instead of silently ignoring it", async () => {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify({ decisionModel: "auto" }));
	const manager = SettingsManager.fromStorage(storage);
	storage.withLock("global", () => JSON.stringify({ routerModel: "auto" }));
	await assert.rejects(manager.reload(), renamed("global", "settings"));
});

test("decisionModel loads, and other load failures stay recorded warnings", () => {
	const { cwd, agentDir } = workspace({ decisionModel: "typesafe/jev-latest" });
	assert.equal(SettingsManager.create(cwd, agentDir).getDecisionModel(), "typesafe/jev-latest");
	writeFileSync(join(agentDir, "settings.json"), "{ not json");
	const broken = SettingsManager.create(cwd, agentDir);
	assert.equal(broken.drainErrors().length, 1);
});

test("CLI startup prints the message, which ends with the hint, once and exits 1 without a stack", () => {
	const { cwd, agentDir } = workspace({ routerModel: "typesafe/jev-latest" });
	const printed: string[] = [];
	const exits: number[] = [];
	const io = {
		error: (text: string) => printed.push(text),
		exit: (code: number): never => {
			exits.push(code);
			throw new Error(`exit ${code}`);
		},
	};
	const failure = (() => {
		try {
			SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		} catch (error) {
			return error;
		}
		return undefined;
	})();
	assert.throws(() => exitOnDecisionConfigError(failure, io), /exit 1/);
	assert.deepEqual(exits, [1]);
	assert.equal(printed.length, 1);
	assert.match(printed[0]!, /Error: Renamed setting: "routerModel" in global settings\.json \(renamed-setting\)\./);
	assert.match(printed[0]!, /Rename "routerModel" to "decisionModel" in your global settings\.json\./);
	assert.doesNotMatch(printed[0]!, /\n\s+at /);
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
