import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const WORKFLOW_NAME = "resumed-marker-flow";
const originalEnv = {
	ATOMIC_CODING_AGENT_DIR: process.env.ATOMIC_CODING_AGENT_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
};
const roots: string[] = [];

afterEach(async () => {
	setDurableBackend(undefined);
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Scenario {
	readonly agentDir: string;
	readonly project: string;
	/** Written by the project's workflow module's top-level code when it is imported. */
	readonly marker: string;
	/** Another project holding the same workflow, with its own marker. */
	readonly otherProject: string;
	readonly otherMarker: string;
}

async function writeMarkerWorkflow(project: string, marker: string): Promise<void> {
	const path = join(project, ".atomic/workflows/marker.ts");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		[
			`import { writeFileSync } from "node:fs";`,
			`import { workflow } from "@bastani/atomic/workflows";`,
			`writeFileSync(${JSON.stringify(marker)}, "loaded");`,
			`export default workflow({`,
			`  name: ${JSON.stringify(WORKFLOW_NAME)},`,
			`  description: "records that it was loaded",`,
			`  inputs: {},`,
			`  outputs: {},`,
			`  run: async (ctx) => { await ctx.tool("record", {}, async () => "recorded"); return {}; },`,
			`});`,
		].join("\n"),
	);
}

async function makeScenario(label: string): Promise<Scenario> {
	const root = realpathSync(await mkdtemp(join(tmpdir(), `atomic-${label}-`)));
	roots.push(root);
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	await mkdir(home, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CODING_AGENT_DIR;
	const project = join(root, "project");
	const otherProject = join(root, "other-project");
	const marker = join(root, "project-module-loaded");
	const otherMarker = join(root, "other-module-loaded");
	await writeMarkerWorkflow(project, marker);
	await writeMarkerWorkflow(otherProject, otherMarker);
	return { agentDir, project, marker, otherProject, otherMarker };
}

/** Resumes a paused run of the project workflow started in `invocationCwd`, from a runtime in `project`. */
async function resume(
	scenario: Scenario,
	invocationCwd: string,
	isProjectTrusted: (() => boolean) | undefined,
): Promise<{ ok: boolean; reason?: string }> {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	const workflowId = testRunId("trust-resume");
	await backend.commitWorkflowRegistration({
		workflowId,
		name: WORKFLOW_NAME,
		inputs: {},
		createdAt: 1,
		status: "paused",
		completedCheckpoints: 1,
		invocationCwd,
	});
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({
		registry: createRegistry(),
		store: createStore(),
		jobs,
		cwd: scenario.project,
		...(isProjectTrusted === undefined ? {} : { isProjectTrusted }),
	});
	const result = await runtime.resumeDurableWorkflow(workflowId, { confirmCrossProjectFork: async () => true });
	if (result.ok) await jobs.get(result.runId)?.promise;
	return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

describe("durable resume discovers project workflows only for trusted projects", () => {
	test.sequential("an untrusted project's workflow is not imported to resume a run", async () => {
		const scenario = await makeScenario("resume-untrusted");
		const result = await resume(scenario, scenario.project, () => false);

		assert.deepEqual(result, { ok: false, reason: "workflow_not_found" });
		assert.equal(existsSync(scenario.marker), false);
	});

	test.sequential("a trusted project's workflow resumes the run", async () => {
		const scenario = await makeScenario("resume-trusted");
		const result = await resume(scenario, scenario.project, () => true);

		assert.deepEqual(result, { ok: true });
		assert.equal(existsSync(scenario.marker), true);
	});

	test.sequential("a runtime without a trust decision discovers its project as before", async () => {
		const scenario = await makeScenario("resume-no-decision");
		const result = await resume(scenario, scenario.project, undefined);

		assert.deepEqual(result, { ok: true });
		assert.equal(existsSync(scenario.marker), true);
	});

	test.sequential("another project's workflow needs that project's saved trust decision", async () => {
		const scenario = await makeScenario("resume-other-project");
		const unsaved = await resume(scenario, scenario.otherProject, () => true);
		assert.equal(unsaved.ok, false);
		assert.equal(existsSync(scenario.otherMarker), false);

		await writeFile(
			join(scenario.agentDir, "trust.json"),
			`${JSON.stringify({ [scenario.otherProject]: true }, null, 2)}\n`,
		);
		await resume(scenario, scenario.otherProject, () => false);
		assert.equal(existsSync(scenario.otherMarker), true);
		assert.equal(existsSync(scenario.marker), false);
	});
});
