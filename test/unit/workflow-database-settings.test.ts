import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	resetLocalDbosProvisioningForTests,
	resolveDbosSystemDatabaseUrl,
	shouldProvisionLocalDbos,
} from "../../packages/workflows/src/durable/dbos-local-postgres.js";
import { resetDbosProcessOwner } from "../../packages/workflows/src/durable/dbos-process-owner.js";
import {
	DbosSystemDatabaseConflictError,
	explicitDbosSystemDatabaseUrl,
} from "../../packages/workflows/src/durable/dbos-system-database-url.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import {
	prepareWorkflowDatabaseSettings,
	resolveWorkflowDatabaseSettings,
} from "../../packages/workflows/src/extension/workflow-database-settings.js";

const originalUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
const originalDir = process.env.ATOMIC_CODING_AGENT_DIR;
let root: string;
let agentDir: string;
const globalUrl = "postgresql://alice:secret@global.example/db";
const projectUrl = "postgresql://bob:secret@project.example/db";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "atomic-db-settings-"));
	agentDir = join(root, "agent");
	await mkdir(agentDir);
	await mkdir(join(root, ".atomic"));
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	delete process.env.DBOS_SYSTEM_DATABASE_URL;
	resetDbosProcessOwner();
	resetLocalDbosProvisioningForTests();
	setDurableBackend(new InMemoryDurableBackend());
});

afterEach(async () => {
	resetDbosProcessOwner();
	resetLocalDbosProvisioningForTests();
	setDurableBackend(undefined);
	if (originalUrl === undefined) delete process.env.DBOS_SYSTEM_DATABASE_URL;
	else process.env.DBOS_SYSTEM_DATABASE_URL = originalUrl;
	if (originalDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalDir;
	await rm(root, { recursive: true, force: true });
});

async function settings() {
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ workflows: { durability: { systemDatabaseUrl: globalUrl } } }),
	);
	await writeFile(
		join(root, ".atomic/settings.json"),
		JSON.stringify({ workflows: { durability: { systemDatabaseUrl: projectUrl } } }),
	);
}

function directories() {
	return { global: agentDir, project: join(root, ".atomic") };
}

test("CLI honors trusted project then global workflow database settings without local provisioning (#3416)", async () => {
	await settings();
	let provisions = 0;
	resetLocalDbosProvisioningForTests(
		async () => {
			provisions++;
		},
		async () => {
			provisions++;
		},
	);
	await prepareWorkflowDatabaseSettings(root, true);
	assert.equal(explicitDbosSystemDatabaseUrl(), projectUrl);
	await resolveDbosSystemDatabaseUrl();
	assert.equal(provisions, 0);
	assert.equal(shouldProvisionLocalDbos(new Error("connection refused")), false);
	resetDbosProcessOwner();
	await prepareWorkflowDatabaseSettings(root, false);
	assert.equal(explicitDbosSystemDatabaseUrl(), globalUrl);
});

test("environment selection bypasses invalid settings and credential files (#3416)", async () => {
	await writeFile(join(agentDir, "settings.json"), "invalid json");
	process.env.DBOS_SYSTEM_DATABASE_URL = ` ${globalUrl}\n`;
	await prepareWorkflowDatabaseSettings(root, true);
	assert.equal(explicitDbosSystemDatabaseUrl(), globalUrl);
});

test("URL files trim whitespace and resolve relative to the selected settings scope (#3416)", async () => {
	await writeFile(join(agentDir, "direct.url"), ` ${globalUrl}\n`);
	await writeFile(join(root, ".atomic/direct.url"), ` ${projectUrl}\n`);
	const global = { workflows: { durability: { systemDatabaseUrlFile: "direct.url" } } };
	const project = { workflows: { durability: { systemDatabaseUrlFile: "direct.url" } } };
	assert.equal(await resolveWorkflowDatabaseSettings(global, {}, directories()), globalUrl);
	assert.equal(await resolveWorkflowDatabaseSettings(global, project, directories()), projectUrl);
	assert.equal(
		await resolveWorkflowDatabaseSettings(
			global,
			{ workflows: { durability: { systemDatabaseUrl: projectUrl } } },
			directories(),
		),
		projectUrl,
	);
	assert.equal(
		await resolveWorkflowDatabaseSettings(
			{},
			{ workflows: { durability: { systemDatabaseUrlFile: join(agentDir, "direct.url") } } },
			directories(),
		),
		globalUrl,
	);
	const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	process.env.HOME = root;
	process.env.USERPROFILE = root;
	try {
		assert.equal(
			await resolveWorkflowDatabaseSettings(
				{ workflows: { durability: { systemDatabaseUrlFile: "~/agent/direct.url" } } },
				{},
				directories(),
			),
			globalUrl,
		);
	} finally {
		for (const [name, value] of Object.entries(originalHome)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("relative URL files resolve beside the legacy settings file that declares them (#3416)", async () => {
	await mkdir(join(root, ".pi"));
	await writeFile(
		join(root, ".pi/settings.json"),
		JSON.stringify({ workflows: { durability: { systemDatabaseUrlFile: "direct.url" } } }),
	);
	await writeFile(join(root, ".pi/direct.url"), projectUrl);
	await writeFile(join(root, ".atomic/settings.json"), JSON.stringify({ workflows: { paths: ["local.ts"] } }));
	await writeFile(join(root, ".atomic/direct.url"), "postgresql://eve:secret@decoy.example/db");
	await prepareWorkflowDatabaseSettings(root, true);
	assert.equal(explicitDbosSystemDatabaseUrl(), projectUrl);
});

test("invalid explicit settings fail without exposing credentials or selecting another database (#3416)", async () => {
	await writeFile(join(agentDir, "empty.url"), " \n");
	for (const durability of [
		{ systemDatabaseUrl: " " },
		{ systemDatabaseUrl: "https://user:secret@wrong.example" },
		{ systemDatabaseUrlFile: "missing.url" },
		{ systemDatabaseUrlFile: "empty.url" },
		{ systemDatabaseUrl: globalUrl, systemDatabaseUrlFile: "missing.url" },
	]) {
		await assert.rejects(
			resolveWorkflowDatabaseSettings({ workflows: { durability } }, {}, directories()),
			(error: Error) => !error.message.includes("secret"),
		);
	}
	assert.equal(await resolveWorkflowDatabaseSettings({}, {}, directories()), undefined);
});

test("malformed database selections in settings files fail instead of starting a local database (#3416)", async () => {
	for (const workflows of [globalUrl, { durability: { systemDatabaseURL: globalUrl } }]) {
		resetDbosProcessOwner();
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ workflows }));
		await assert.rejects(
			prepareWorkflowDatabaseSettings(root, true),
			(error: Error) => error instanceof TypeError && !error.message.includes("secret"),
		);
		assert.equal(explicitDbosSystemDatabaseUrl(), undefined);
	}
	await settings();
	await writeFile(join(root, ".atomic/settings.json"), JSON.stringify({ workflows: { durability: null } }));
	resetDbosProcessOwner();
	await assert.rejects(prepareWorkflowDatabaseSettings(root, true), TypeError);
	assert.equal(explicitDbosSystemDatabaseUrl(), undefined);
	await mkdir(join(root, ".pi"));
	await writeFile(
		join(root, ".pi/settings.json"),
		JSON.stringify({ workflows: { durability: { systemDatabaseUrl: "postgresql://eve:secret@legacy.example/db" } } }),
	);
	await writeFile(join(root, ".atomic/settings.json"), JSON.stringify({ workflows: "bad-shape" }));
	resetDbosProcessOwner();
	await assert.rejects(
		prepareWorkflowDatabaseSettings(root, true),
		(error: Error) => error instanceof TypeError && !error.message.includes("secret"),
	);
	assert.equal(explicitDbosSystemDatabaseUrl(), undefined);
	resetDbosProcessOwner();
	await prepareWorkflowDatabaseSettings(root, false);
	assert.equal(explicitDbosSystemDatabaseUrl(), globalUrl);
});

test("workflow paths retain array compatibility and preserve database settings when edited (#3416)", async () => {
	await settings();
	const manager = SettingsManager.create(root, agentDir);
	manager.setWorkflowPaths(["global.ts"]);
	manager.setProjectWorkflowPaths(["project.ts"]);
	await manager.flush();
	assert.deepEqual(manager.getWorkflowPaths(), ["project.ts"]);
	assert.equal(
		await resolveWorkflowDatabaseSettings(manager.getGlobalSettings(), manager.getProjectSettings(), directories()),
		projectUrl,
	);
	assert.deepEqual(SettingsManager.inMemory({ workflows: ["legacy.ts"] }).getWorkflowPaths(), ["legacy.ts"]);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ workflows: ["legacy.ts"] }));
	await writeFile(
		join(root, ".atomic/settings.json"),
		JSON.stringify({ workflows: { durability: { systemDatabaseUrl: projectUrl } } }),
	);
	assert.deepEqual(SettingsManager.create(root, agentDir).getWorkflowPaths(), ["legacy.ts"]);
});

test("database conflicts reveal only the host, never URL credentials or options (#3416)", () => {
	const error = new DbosSystemDatabaseConflictError(
		"postgresql://alice:secret@db.example/private?sslpassword=hidden#token",
	);
	assert.match(error.message, /db.example/);
	for (const secret of ["alice", "secret", "private", "hidden", "token"])
		assert.equal(error.message.includes(secret), false);
});

test("extension retries repaired credential files and rechecks a changed trust decision (#3416)", async () => {
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ workflows: { durability: { systemDatabaseUrlFile: "direct.url" } } }),
	);
	await writeFile(
		join(root, ".atomic/settings.json"),
		JSON.stringify({ workflows: { durability: { systemDatabaseUrl: projectUrl } } }),
	);
	let trusted = false;
	const pi = { getResourceLoaderInheritanceSnapshot: () => ({ projectTrusted: trusted }) } as ExtensionAPI;
	const state = createWorkflowExtensionRuntimeState(pi, {} as never, { resolveHostCwd: () => root });
	await assert.rejects(state.runtimeProxy.dispatch({ action: "list" }), /Cannot read/);
	await writeFile(join(agentDir, "direct.url"), globalUrl);
	await state.runtimeProxy.dispatch({ action: "list" });
	assert.equal(explicitDbosSystemDatabaseUrl(), globalUrl);
	trusted = true;
	await state.runtimeProxy.dispatch({ action: "list" });
	assert.equal(explicitDbosSystemDatabaseUrl(), projectUrl);
});
