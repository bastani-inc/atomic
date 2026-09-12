import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { ExtensionAPI, LoadedExtensionInfo } from "../src/core/extensions/types.js";
import { withMandatoryResourceLoader } from "../src/core/mandatory-resource-loader.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";

let root: string;
let cwd: string;
let agentDir: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "feedback-inventory-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function inventory(loader: Pick<DefaultResourceLoader, "getExtensions">): LoadedExtensionInfo[] {
	return loader.getExtensions().extensions.map(({ path: name, sourceInfo }) => ({
		name,
		configurationOrigin: sourceInfo.configurationOrigin,
	}));
}

// #2799: feedback must include extensions with no registered tools, using final provenance.
test("publishes final inline and file extensions after overrides and refreshes on reload", async () => {
	const extensionPath = join(agentDir, "extensions", "empty.ts");
	mkdirSync(join(agentDir, "extensions"));
	writeFileSync(extensionPath, "export default function () {}\n");
	let readInventory: () => readonly LoadedExtensionInfo[] = () => [];
	let calls = 0;
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		extensionFactories: [
			(pi: ExtensionAPI) => {
				calls++;
				readInventory = () => pi.getLoadedExtensions?.() ?? [];
			},
		],
		extensionsOverride: (result) => ({
			...result,
			extensions: result.extensions.filter(({ path }) => !path.endsWith("empty.ts")),
		}),
	});
	assert.deepEqual(inventory(loader), []);
	await loader.reload();
	assert.equal(calls, 1);
	assert.equal(inventory(loader).length, 1);
	assert.deepEqual(readInventory(), inventory(loader));
	const copy = readInventory() as Array<{
		name: string;
		configurationOrigin: LoadedExtensionInfo["configurationOrigin"];
	}>;
	copy[0].name = "mutated";
	copy.length = 0;
	assert.deepEqual(readInventory(), inventory(loader));
	await loader.reload();
	assert.equal(calls, 2);
	assert.deepEqual(readInventory(), inventory(loader));
});

test("deferred resources do not invent loaded extensions before a full reload", async () => {
	let calls = 0;
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		extensionFactories: [
			() => {
				calls++;
			},
		],
	});
	assert.deepEqual(loader.getExtensions().runtime.getLoadedExtensions?.() ?? [], []);
	await loader.reload({ deferResources: true, deferExtensions: true });
	assert.equal(calls, 0);
	assert.deepEqual(loader.getExtensions().runtime.getLoadedExtensions?.() ?? [], []);
	await loader.reload();
	assert.equal(calls, 1);
	assert.deepEqual(loader.getExtensions().runtime.getLoadedExtensions?.(), inventory(loader));
});

test("reuses pre-trust extension APIs and publishes newly trusted project extensions", async () => {
	const projectPath = join(cwd, ".atomic", "extensions", "project.ts");
	mkdirSync(join(projectPath, ".."), { recursive: true });
	writeFileSync(projectPath, "export default function () {}\n");
	let readInventory: () => readonly LoadedExtensionInfo[] = () => [];
	let calls = 0;
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
		extensionFactories: [
			(pi: ExtensionAPI) => {
				calls++;
				readInventory = () => pi.getLoadedExtensions?.() ?? [];
			},
		],
	});
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			assert.equal(calls, 1);
			assert.deepEqual(
				readInventory(),
				extensionsResult.extensions.map(({ path: name, sourceInfo }) => ({
					name,
					configurationOrigin: sourceInfo.configurationOrigin,
				})),
			);
			assert.ok(!readInventory().some(({ name }) => name === projectPath));
			return true;
		},
	});
	assert.equal(calls, 1);
	assert.ok(readInventory().some(({ name }) => name === projectPath));
	assert.deepEqual(readInventory(), inventory(loader));
});

test("deferred trust keeps the same API inventory through mandatory restoration and completion", async () => {
	let readInventory: () => readonly LoadedExtensionInfo[] = () => [];
	let complete: (() => Promise<void>) | undefined;
	let trustCalls = 0;
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
		extensionFactories: [
			(pi: ExtensionAPI) => {
				readInventory = () => pi.getLoadedExtensions?.() ?? [];
			},
		],
	});
	await loader.reload({
		resolveProjectTrust: async () => {
			trustCalls++;
			return true;
		},
		deferProjectTrust: (continuation) => {
			complete = continuation;
		},
	});
	assert.equal(trustCalls, 0);
	assert.ok(complete);
	assert.deepEqual(readInventory(), inventory(loader));
	assert.ok(readInventory().some(({ configurationOrigin }) => configurationOrigin === "bundled"));
	await complete();
	assert.equal(trustCalls, 1);
	assert.deepEqual(readInventory(), inventory(loader));
	assert.ok(readInventory().some(({ configurationOrigin }) => configurationOrigin === "bundled"));
});

test("mandatory wrapper publishes restored Intercom without dropping caller-owned extensions", async () => {
	let readInventory: () => readonly LoadedExtensionInfo[] = () => [];
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		extensionFactories: [
			(pi: ExtensionAPI) => {
				readInventory = () => pi.getLoadedExtensions?.() ?? [];
			},
		],
	});
	await loader.reload();
	const before = inventory(loader);
	const wrapped = await withMandatoryResourceLoader(loader, cwd);
	assert.deepEqual(readInventory(), inventory(wrapped));
	assert.equal(readInventory().length, before.length + 1);
	const intercom = wrapped.getExtensions().extensions.find(({ tools }) => tools.has("intercom"));
	assert.ok(intercom);
	assert.equal(readInventory().find(({ name }) => name === intercom.path)?.configurationOrigin, "bundled");
	await wrapped.reload();
	assert.deepEqual(readInventory(), inventory(wrapped));
	assert.equal(readInventory().length, before.length + 1);
});

test("transactional reload publishes only its candidate inventory on commit", async () => {
	const readers: Array<() => readonly LoadedExtensionInfo[]> = [];
	const settings = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		extensionFactories: [
			(pi: ExtensionAPI) => {
				readers.push(() => pi.getLoadedExtensions?.() ?? []);
			},
		],
	});
	await loader.reload();
	const oldRuntime = loader.getExtensions().runtime;
	const oldInventory = readers[0]();
	const extensionPath = join(agentDir, "extensions", "later.ts");
	mkdirSync(join(extensionPath, ".."), { recursive: true });
	writeFileSync(extensionPath, "export default function () {}\n");
	const candidate = await loader.prepareReload(settings);
	assert.equal(loader.getExtensions().runtime, oldRuntime);
	assert.deepEqual(readers[0](), oldInventory);
	assert.deepEqual(readers[1](), inventory(candidate.loader));
	assert.ok(readers[1]().some(({ name }) => name === extensionPath));
	candidate.activate(settings);
	candidate.commit();
	assert.equal(loader.getExtensions().runtime, candidate.loader.getExtensions().runtime);
	assert.deepEqual(readers[1](), inventory(loader));
});

test("deferred resource overrides publish their supplied extension set rather than stale activity", async () => {
	const initial = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [() => {}, () => {}] });
	await initial.reload();
	const result = initial.getExtensions();
	assert.equal(result.runtime.getLoadedExtensions?.().length, 2);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		extensionsOverride: () => ({ ...result, extensions: result.extensions.slice(0, 1) }),
	});
	await loader.reload({ deferResources: true });
	assert.equal(inventory(loader).length, 1);
	assert.deepEqual(loader.getExtensions().runtime.getLoadedExtensions?.(), inventory(loader));
});
