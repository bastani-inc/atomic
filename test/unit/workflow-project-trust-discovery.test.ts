import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { loadWorkflowConfig } from "../../packages/workflows/src/extension/config-loader.js";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
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

/** The workflow runtime state of a host whose session started with the trust decision `sessionTrusted`. */
function startSession(
	project: string,
	sessionTrusted: boolean,
	live: "no-api" | "no-snapshot" | boolean,
): ReturnType<typeof createWorkflowExtensionRuntimeState> {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
		refreshWorkflowResources: async () => [],
		...(live === "no-api"
			? {}
			: {
					getResourceLoaderInheritanceSnapshot: () =>
						live === "no-snapshot" ? undefined : { projectTrusted: live },
				}),
	} as unknown as ExtensionAPI;
	const state = createWorkflowExtensionRuntimeState(pi, {} as never);
	handlers.get("session_start")?.({ reason: "startup" }, { cwd: project, isProjectTrusted: () => sessionTrusted });
	return state;
}

describe("workflow resources follow the host's trust decision", () => {
	for (const live of ["no-api", "no-snapshot"] as const)
		test.sequential(`the session's decision applies when the host reports no live decision (${live})`, async () => {
			const { project, localMarker } = await makeProject(`workflow-session-untrusted-${live}`);
			const state = startSession(project, false, live);

			await state.ensureWorkflowConfigLoaded();
			assert.equal(state.configLoadRef.current?.projectConfig, null);
			const report = await state.reloadWorkflowResources();
			assert.equal(report.outcome, "applied");
			assert.equal(state.configLoadRef.current?.projectConfig, null);
			assert.equal(state.discoveryRef.current?.registry.has("project-local-flow"), false);
			assert.equal(existsSync(localMarker), false);
		});

	test.sequential("the host's live decision wins over the session's earlier one", async () => {
		const { project, localMarker } = await makeProject("workflow-live-trusted");
		const state = startSession(project, false, true);

		await state.ensureWorkflowConfigLoaded();
		assert.notEqual(state.configLoadRef.current?.projectConfig, null);
		const report = await state.reloadWorkflowResources();
		assert.equal(report.outcome, "applied");
		assert.notEqual(state.configLoadRef.current?.projectConfig, null);
		assert.equal(state.discoveryRef.current?.registry.has("project-local-flow"), true);
		assert.equal(existsSync(localMarker), true);
	});
});

describe("workflow discovery and config loading take the trust decision", () => {
	test.sequential("discovery reads no project workflow paths for an untrusted project", async () => {
		const { project, configuredMarker } = await makeProject("discovery-config-untrusted");
		const config = { projectWorkflows: [join(project, "configured/configured.ts")] };

		const untrusted = await discoverWorkflows({ cwd: project, config, projectTrusted: false, includeBundled: false });
		assert.equal(untrusted.registry.has("project-configured-flow"), false);
		assert.equal(existsSync(configuredMarker), false);

		const trusted = await discoverWorkflows({ cwd: project, config, projectTrusted: true, includeBundled: false });
		assert.equal(trusted.registry.has("project-configured-flow"), true);
		assert.equal(existsSync(configuredMarker), true);
	});

	test.sequential("an untrusted project's workflow config is not read", async () => {
		const { project } = await makeProject("config-untrusted");
		await writeFile(join(project, ".atomic/extensions/workflow/config.json"), "{ not json");

		const untrusted = await loadWorkflowConfig({ projectRoot: project, projectTrusted: false });
		assert.equal(untrusted.projectConfig, null);
		assert.deepEqual(untrusted.diagnostics, []);

		const trusted = await loadWorkflowConfig({ projectRoot: project, projectTrusted: true });
		assert.equal(trusted.diagnostics.length, 1);
		assert.equal(trusted.diagnostics[0]?.code, "CONFIG_INVALID");
	});
});
