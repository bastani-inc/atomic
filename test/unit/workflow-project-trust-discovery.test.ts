import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "vitest";
import factory, {
	type ExtensionAPI,
	type PiExecuteContext,
	type PiToolOpts,
	type WorkflowToolArgs,
} from "../../packages/workflows/src/extension/index.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { store } from "../../packages/workflows/src/shared/store.js";

const originalCwd = process.cwd();
const originalEnv = {
	ATOMIC_CODING_AGENT_DIR: process.env.ATOMIC_CODING_AGENT_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
};
const roots: string[] = [];

afterEach(async () => {
	process.chdir(originalCwd);
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	store.clear();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Project {
	readonly project: string;
	/** Written by the project-local module's top-level code when it is imported. */
	readonly localMarker: string;
	/** Written by the module the project workflow config names when it is imported. */
	readonly configuredMarker: string;
}

/** A project whose workflow modules each record, at import time, that they were loaded. */
async function makeProject(label: string): Promise<Project> {
	const root = await mkdtemp(join(tmpdir(), `atomic-${label}-`));
	roots.push(root);
	const project = join(root, "project");
	const home = join(root, "home");
	await mkdir(join(home, ".atomic", "agent"), { recursive: true });
	await mkdir(project, { recursive: true });
	process.chdir(project);
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.ATOMIC_CODING_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
	const localMarker = join(root, "local-module-loaded");
	const configuredMarker = join(root, "configured-module-loaded");
	await writeMarkerWorkflow(join(project, ".atomic/workflows/local.ts"), "project-local-flow", localMarker);
	await writeMarkerWorkflow(join(project, "configured/configured.ts"), "project-configured-flow", configuredMarker);
	await mkdir(join(project, ".atomic/extensions/workflow"), { recursive: true });
	await writeFile(
		join(project, ".atomic/extensions/workflow/config.json"),
		JSON.stringify({ workflows: { configured: { path: "configured/configured.ts" } } }),
	);
	return { project, localMarker, configuredMarker };
}

async function writeMarkerWorkflow(path: string, name: string, marker: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		[
			`import { writeFileSync } from "node:fs";`,
			`import { workflow } from "@bastani/atomic/workflows";`,
			`writeFileSync(${JSON.stringify(marker)}, "loaded");`,
			`export default workflow({`,
			`  name: ${JSON.stringify(name)},`,
			`  description: "records that it was loaded",`,
			`  inputs: {},`,
			`  outputs: {},`,
			`  run: async (ctx) => { await ctx.stage("emit").prompt("go"); return {}; },`,
			`});`,
		].join("\n"),
	);
}

/** The workflow extension as a host that reports the project trust decision `trusted()` loads it under. */
function loadExtension(trusted: () => boolean | undefined) {
	let tool: PiToolOpts<WorkflowToolArgs, WorkflowToolResult> | undefined;
	const pi: ExtensionAPI = {
		registerCommand: () => undefined,
		registerTool: (options) => {
			tool = options as unknown as PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
		},
		registerMessageRenderer: () => undefined,
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		sendMessage: () => undefined,
		on: () => undefined,
		ui: { setWidget: () => undefined },
		disableAsyncDiscovery: true,
		getResourceLoaderInheritanceSnapshot: () => {
			const projectTrusted = trusted();
			return projectTrusted === undefined ? {} : { projectTrusted };
		},
	};
	factory(pi);
	assert.ok(tool);
	const execute = async (args: WorkflowToolArgs): Promise<WorkflowToolResult> =>
		(
			await tool!.execute("trust-call", args, undefined, undefined, {
				hasUI: false,
				sessionId: "trust-owner",
			} as PiExecuteContext)
		).details;
	return {
		async listedAfterReload(): Promise<string[]> {
			const reload = await execute({ action: "reload" });
			assert.equal(reload.action, "reload");
			assert.equal(reload.outcome, "applied");
			const listed = await execute({ action: "list" });
			assert.equal(listed.action, "list");
			return listed.items.map((item) => item.name);
		},
	};
}

describe("project workflow discovery follows project trust", () => {
	test.sequential("an untrusted project's workflow modules are neither imported nor listed", async () => {
		const { localMarker, configuredMarker } = await makeProject("workflow-untrusted");
		const listed = await loadExtension(() => false).listedAfterReload();

		assert.equal(listed.includes("project-local-flow"), false);
		assert.equal(listed.includes("project-configured-flow"), false);
		assert.equal(existsSync(localMarker), false);
		assert.equal(existsSync(configuredMarker), false);
	});

	test.sequential("a trusted project's workflow modules are imported and listed", async () => {
		const { localMarker, configuredMarker } = await makeProject("workflow-trusted");
		const listed = await loadExtension(() => true).listedAfterReload();

		assert.ok(listed.includes("project-local-flow"));
		assert.ok(listed.includes("project-configured-flow"));
		assert.equal(existsSync(localMarker), true);
		assert.equal(existsSync(configuredMarker), true);
	});

	test.sequential("trust granted later in the session is picked up by the next discovery", async () => {
		const { localMarker } = await makeProject("workflow-trust-granted");
		let trusted = false;
		const extension = loadExtension(() => trusted);

		assert.equal((await extension.listedAfterReload()).includes("project-local-flow"), false);
		assert.equal(existsSync(localMarker), false);

		trusted = true;
		assert.ok((await extension.listedAfterReload()).includes("project-local-flow"));
		assert.equal(existsSync(localMarker), true);
	});
});
