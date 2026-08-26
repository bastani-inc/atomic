import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/index.js";

// Observed live (atomic-remote bridge e2e, atomic 0.9.15): a `/workflow <name>`
// injected right after `/workflow reload` resolved the name against the
// pre-reload registry and ran the old module — the reload applied only after
// the run had started. ensureWorkflowResourcesLoaded returned immediately once
// any discovery existed, without awaiting the in-flight reload.

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const roots: string[] = [];

afterEach(async () => {
	process.chdir(originalCwd);
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeIsolatedProject(label: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `atomic-${label}-`));
	roots.push(root);
	const project = join(root, "project");
	const home = join(root, "home");
	await mkdir(project, { recursive: true });
	await mkdir(join(home, ".atomic", "agent"), { recursive: true });
	process.chdir(project);
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.ATOMIC_CODING_AGENT_DIR;
	return project;
}

async function writeProbeWorkflow(path: string, name: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		[
			`import { workflow } from "@bastani/workflows";`,
			`import { Type } from "typebox";`,
			`export default workflow({`,
			`  name: ${JSON.stringify(name)},`,
			`  description: "in-flight reload probe",`,
			`  inputs: { message: Type.String() },`,
			`  outputs: { value: Type.String() },`,
			`  run: async (ctx) => ({ value: await ctx.stage("emit").prompt(String(ctx.inputs.message)) }),`,
			`});`,
		].join("\n"),
		"utf8",
	);
}

function drainScheduledWork(rounds = 4): Promise<void> {
	// Discovery defers via setImmediate; several macrotask rounds give a
	// non-awaiting implementation every chance to settle before the assertion.
	let chain = Promise.resolve();
	for (let i = 0; i < rounds; i++) {
		chain = chain.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
	}
	return chain;
}

describe("workflow name resolution vs in-flight reload", () => {
	test.sequential("ensureWorkflowResourcesLoaded awaits an in-flight reload and sees its registry", async () => {
		const project = await makeIsolatedProject("workflow-inflight-resolution");
		const gates: Array<() => void> = [];
		const starts: Array<() => void> = [];
		let refreshCalls = 0;
		const firstStarted = new Promise<void>((resolve) => {
			starts[0] = resolve;
		});
		const secondStarted = new Promise<void>((resolve) => {
			starts[1] = resolve;
		});
		const pi = {
			refreshWorkflowResources: async () => {
				const index = refreshCalls++;
				starts[index]?.();
				await new Promise<void>((resolve) => {
					gates[index] = resolve;
				});
				return [];
			},
		} as ExtensionAPI;
		const state = createWorkflowExtensionRuntimeState(pi, {} as never);

		// Initial discovery completes: the registry exists and has no probe workflow.
		const initial = state.reloadWorkflowResources();
		await firstStarted;
		gates[0]?.();
		assert.equal((await initial).outcome, "applied");
		assert.ok(!state.runtimeProxy.registry.names().includes("inflight-probe"));

		// The workflow lands on disk and a reload is requested, but its discovery
		// is still in flight (gate held).
		await writeProbeWorkflow(join(project, ".atomic/workflows/inflight-probe.ts"), "inflight-probe");
		const reload = state.reloadWorkflowResources();
		await secondStarted;

		// Name resolution starts now, the way `/workflow <name>` does right after
		// `/workflow reload`: it must not resolve against the pre-reload registry.
		let ensureSettled = false;
		const ensure = Promise.resolve(state.ensureWorkflowResourcesLoaded()).finally(() => {
			ensureSettled = true;
		});
		await drainScheduledWork();
		assert.equal(ensureSettled, false, "resolution must wait for the in-flight reload, not race past it");

		gates[1]?.();
		assert.equal((await reload).outcome, "applied");
		await ensure;
		assert.ok(
			state.runtimeProxy.registry.names().includes("inflight-probe"),
			"after ensure resolves, the registry must be the post-reload one",
		);
	});

	test.sequential("a failed in-flight reload does not break resolution when a registry already exists", async () => {
		await makeIsolatedProject("workflow-inflight-failure");
		const gates: Array<() => void> = [];
		const starts: Array<() => void> = [];
		let refreshCalls = 0;
		let failRefresh = false;
		const firstStarted = new Promise<void>((resolve) => {
			starts[0] = resolve;
		});
		const secondStarted = new Promise<void>((resolve) => {
			starts[1] = resolve;
		});
		const pi = {
			refreshWorkflowResources: async () => {
				const index = refreshCalls++;
				starts[index]?.();
				await new Promise<void>((resolve) => {
					gates[index] = resolve;
				});
				if (failRefresh) throw new Error("deterministic in-flight failure");
				return [];
			},
		} as ExtensionAPI;
		const state = createWorkflowExtensionRuntimeState(pi, {} as never);

		const initial = state.reloadWorkflowResources();
		await firstStarted;
		gates[0]?.();
		assert.equal((await initial).outcome, "applied");

		failRefresh = true;
		const reload = state.reloadWorkflowResources();
		await secondStarted;
		const ensure = state.ensureWorkflowResourcesLoaded();
		gates[1]?.();
		assert.equal((await reload).outcome, "failed");
		// The reload command already reported its failure; resolution proceeds on
		// the retained registry instead of throwing at an unrelated caller.
		await assert.doesNotReject(async () => ensure);
	});

	test.sequential("an explicit reload is awaited even when async discovery is disabled", async () => {
		const project = await makeIsolatedProject("workflow-inflight-disabled-discovery");
		const gates: Array<() => void> = [];
		const starts: Array<() => void> = [];
		let refreshCalls = 0;
		const firstStarted = new Promise<void>((resolve) => {
			starts[0] = resolve;
		});
		const secondStarted = new Promise<void>((resolve) => {
			starts[1] = resolve;
		});
		// `disableAsyncDiscovery` suppresses background warmup, but `/workflow
		// reload` still publishes an in-flight discovery that name resolution
		// must observe before it reads the registry.
		const pi = {
			disableAsyncDiscovery: true,
			refreshWorkflowResources: async () => {
				const index = refreshCalls++;
				starts[index]?.();
				await new Promise<void>((resolve) => {
					gates[index] = resolve;
				});
				return [];
			},
		} as ExtensionAPI;
		const state = createWorkflowExtensionRuntimeState(pi, {} as never);

		const initial = state.reloadWorkflowResources();
		await firstStarted;
		gates[0]?.();
		assert.equal((await initial).outcome, "applied");
		assert.ok(!state.runtimeProxy.registry.names().includes("disabled-discovery-probe"));

		await writeProbeWorkflow(
			join(project, ".atomic/workflows/disabled-discovery-probe.ts"),
			"disabled-discovery-probe",
		);
		const reload = state.reloadWorkflowResources();
		await secondStarted;

		let ensureSettled = false;
		const ensure = Promise.resolve(state.ensureWorkflowResourcesLoaded()).finally(() => {
			ensureSettled = true;
		});
		await drainScheduledWork();
		assert.equal(ensureSettled, false, "disabled discovery must still await an explicit in-flight reload");

		gates[1]?.();
		assert.equal((await reload).outcome, "applied");
		await ensure;
		assert.ok(
			state.runtimeProxy.registry.names().includes("disabled-discovery-probe"),
			"after ensure resolves, the registry must be the post-reload one",
		);
	});

	test.sequential("disabled async discovery still never starts discovery of its own", async () => {
		await makeIsolatedProject("workflow-disabled-discovery-no-start");
		let refreshCalls = 0;
		const pi = {
			disableAsyncDiscovery: true,
			refreshWorkflowResources: async () => {
				refreshCalls += 1;
				return [];
			},
		} as ExtensionAPI;
		const state = createWorkflowExtensionRuntimeState(pi, {} as never);

		// No registry and no reload in flight: resolution must return without
		// discovering, exactly as it did before in-flight reloads were awaited.
		await state.ensureWorkflowResourcesLoaded();
		await drainScheduledWork();
		assert.equal(refreshCalls, 0, "resolution must not start discovery when it is disabled");
	});
});
