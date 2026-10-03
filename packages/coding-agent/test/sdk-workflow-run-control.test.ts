import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getModel } from "@bastani/pi-ai/compat";
import { afterAll, beforeAll, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	WorkflowRunControlError,
	WorkflowRunControlUnavailableError,
	WorkflowRunNotFoundError,
	WorkflowRunNotResumableError,
	WorkflowRunOwnershipError,
	type WorkflowRunSummary,
} from "../src/index.js";

const REAL_SDK_WORKFLOW_RUN_CONTROL_TIMEOUT_MS = 180_000;
const UNKNOWN_RUN_PREFIX_SETTLE_TIMEOUT_MS = 15_000;
const UNKNOWN_RUN_ID = "00000000-0000-4000-8000-000000000000";
const UNKNOWN_RUN_PREFIX = "deadbeef";

type Scenario = "pause" | "quit" | "reload" | "prefix" | "guard";

interface Markers {
	readonly reached: string;
	readonly gate: string;
	readonly finished: string;
}

let root = "";
let markers: Record<Scenario, Markers>;
let owner: AgentSession;
let other: AgentSession;

function workflowName(scenario: Scenario): string {
	return `sdk-run-control-${scenario}`;
}

function workflowSource(scenario: Scenario, files: Markers): string {
	const reached = JSON.stringify(files.reached);
	const gate = JSON.stringify(files.gate);
	const finished = JSON.stringify(files.finished);
	const hold =
		scenario === "quit"
			? `await ctx.tool("hold", {}, async ({ signal }) => {
await writeFile(${reached}, "reached");
while (!existsSync(${gate}) && !signal.aborted) await delay(25);
return "held";
});`
			: `await writeFile(${reached}, "reached");
while (!existsSync(${gate})) await delay(25);`;
	return `import { workflow } from "@bastani/workflows";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
export default workflow({ name: ${JSON.stringify(workflowName(scenario))}, description: "Holds until released", inputs: {}, outputs: {}, run: async (ctx) => {
await ctx.tool("prepare", {}, async () => "ready");
${hold}
await ctx.tool("finish", {}, async () => {
await writeFile(${finished}, "finished");
return "done";
});
return {};
} });\n`;
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "atomic-sdk-run-control-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const packageDir = join(root, "package");
	const workflowsDir = join(packageDir, "workflows");
	mkdirSync(join(cwd, ".atomic"), { recursive: true });
	mkdirSync(workflowsDir, { recursive: true });
	const scenarios: readonly Scenario[] = ["pause", "quit", "reload", "prefix", "guard"];
	const markersFor = (scenario: Scenario): Markers => ({
		reached: join(root, `${scenario}-reached`),
		gate: join(root, `${scenario}-gate`),
		finished: join(root, `${scenario}-finished`),
	});
	markers = {
		pause: markersFor("pause"),
		quit: markersFor("quit"),
		reload: markersFor("reload"),
		prefix: markersFor("prefix"),
		guard: markersFor("guard"),
	};
	for (const scenario of scenarios) {
		writeFileSync(join(workflowsDir, `${scenario}.ts`), workflowSource(scenario, markers[scenario]));
	}
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({ name: "sdk-run-control-package", type: "module", atomic: { workflows: ["./workflows/*.ts"] } }),
	);
	writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify({ packages: [packageDir] }));
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, builtinPackagePaths: [] });
	await loader.reload();
	await loader.refreshWorkflowResources();
	const create = async (): Promise<AgentSession> =>
		(
			await createAgentSession({
				cwd,
				agentDir,
				settingsManager,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(cwd),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
			})
		).session;
	owner = await create();
	other = await create();
}, REAL_SDK_WORKFLOW_RUN_CONTROL_TIMEOUT_MS);

afterAll(async () => {
	await owner?.dispose();
	await other?.dispose();
	rmSync(root, { recursive: true, force: true });
}, REAL_SDK_WORKFLOW_RUN_CONTROL_TIMEOUT_MS);

async function launchThroughSessionTool(session: AgentSession, scenario: Scenario): Promise<string> {
	const tool = session.agent.state.tools.find((entry) => entry.name === "workflow");
	assert.ok(tool, "SDK session must expose the workflow tool");
	const started = await tool.execute(`sdk-run-control-launch-${scenario}`, {
		action: "run",
		workflow: workflowName(scenario),
		inputs: {},
	});
	const launch = started.details as { runId?: string; error?: string };
	assert.equal(launch.error, undefined, JSON.stringify(started));
	assert.ok(launch.runId, JSON.stringify(started));
	return launch.runId;
}

async function eventually<T>(read: () => Promise<T | undefined> | T | undefined, label: string): Promise<T> {
	const deadline = Date.now() + 60_000;
	for (;;) {
		const value = await read();
		if (value !== undefined) return value;
		assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
		await delay(25);
	}
}

async function waitForFile(path: string): Promise<void> {
	await eventually(() => (existsSync(path) ? true : undefined), path);
}

async function rejection(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation;
	} catch (error) {
		assert.ok(error instanceof Error, "expected an Error rejection");
		return error;
	}
	throw new assert.AssertionError({ message: "expected the operation to reject" });
}

async function settledRejection(operation: Promise<unknown>, label: string): Promise<Error> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${label} did not settle within ${UNKNOWN_RUN_PREFIX_SETTLE_TIMEOUT_MS}ms`)),
			UNKNOWN_RUN_PREFIX_SETTLE_TIMEOUT_MS,
		);
	});
	try {
		return await rejection(Promise.race([operation, timeout]));
	} finally {
		clearTimeout(timer);
	}
}

async function findRun(session: AgentSession, runId: string): Promise<WorkflowRunSummary | undefined> {
	return (await session.workflows.listRuns()).find((run) => run.runId === runId);
}

async function completed(session: AgentSession, runId: string): Promise<WorkflowRunSummary> {
	return eventually(async () => {
		const run = await findRun(session, runId);
		return run?.status === "completed" ? run : undefined;
	}, `completion of ${runId}`);
}

test(
	"SDK hosts list, pause, resume and complete a session-owned workflow run (#3377)",
	async () => {
		const files = markers.pause;
		const runId = await launchThroughSessionTool(owner, "pause");
		await waitForFile(files.reached);

		const listed = await owner.workflows.listRuns();
		assert.equal(listed.length, 1);
		assert.equal(listed[0]?.runId, runId);
		assert.equal(listed[0]?.name, workflowName("pause"));
		assert.equal(listed[0]?.status, "running");
		assert.deepEqual(listed[0]?.activeStages, []);
		assert.deepEqual(listed[0]?.awaitingInput, []);
		assert.equal((await owner.workflows.listRuns({ status: "paused" })).length, 0);

		const paused = await owner.workflows.pause(runId);
		assert.equal(paused.action, "pause");
		assert.equal(paused.runId, runId);
		assert.equal(paused.status, "paused");
		assert.match(paused.message, /paused/);
		assert.equal((await owner.workflows.getRun(runId)).status, "paused");
		assert.deepEqual(
			(await owner.workflows.listRuns({ status: "paused" })).map((run) => run.runId),
			[runId],
		);

		writeFileSync(files.gate, "release");
		await delay(500);
		assert.equal((await owner.workflows.getRun(runId)).status, "paused");
		assert.equal(existsSync(files.finished), false, "a paused run must not advance past its barrier");

		const resumed = await owner.workflows.resume(runId);
		assert.equal(resumed.action, "resume");
		assert.equal(resumed.runId, runId);
		assert.equal(resumed.status, "ok");
		await completed(owner, runId);
		assert.equal(existsSync(files.finished), true);
		const detail = await owner.workflows.getRun(runId);
		assert.equal(detail.runId, runId);
		assert.equal(detail.name, workflowName("pause"));
		assert.deepEqual(await owner.workflows.getStages(runId), []);

		const notResumable = await rejection(owner.workflows.resume(runId));
		assert.ok(notResumable instanceof WorkflowRunNotResumableError, notResumable.message);
		assert.equal(notResumable.code, "WORKFLOW_RUN_NOT_RESUMABLE");
		assert.equal(notResumable.runId, runId);
	},
	REAL_SDK_WORKFLOW_RUN_CONTROL_TIMEOUT_MS,
);

test(
	"SDK hosts quit an in-flight run and resume it through the durable path (#3377)",
	async () => {
		const files = markers.quit;
		const runId = await launchThroughSessionTool(owner, "quit");
		await waitForFile(files.reached);

		const quit = await owner.workflows.quit(runId);
		assert.equal(quit.action, "quit");
		assert.equal(quit.runId, runId);
		assert.equal(quit.status, "paused");
		assert.equal((await owner.workflows.getRun(runId)).status, "paused");
		assert.equal(existsSync(files.finished), false);

		writeFileSync(files.gate, "release");
		const resumed = await owner.workflows.resume(runId);
		assert.equal(resumed.action, "resume");
		assert.ok(resumed.status === "running" || resumed.status === "ok", JSON.stringify(resumed));
		await completed(owner, runId);
		assert.equal(existsSync(files.finished), true);
	},
	REAL_SDK_WORKFLOW_RUN_CONTROL_TIMEOUT_MS,
);

test(
	"SDK workflows keep controlling a run after the session reloads its extensions (#3377)",
	async () => {
		const files = markers.reload;
		const runId = await launchThroughSessionTool(owner, "reload");
		await waitForFile(files.reached);

		await owner.reload({ failOnExtensionErrors: true });

		assert.equal((await owner.workflows.getRun(runId)).status, "running");
		const paused = await owner.workflows.pause(runId);
		assert.equal(paused.status, "paused");
		writeFileSync(files.gate, "release");
		const resumed = await owner.workflows.resume(runId);
		assert.equal(resumed.status, "ok");
		await completed(owner, runId);
		assert.equal(existsSync(files.finished), true);
	},
	REAL_SDK_WORKFLOW_RUN_CONTROL_TIMEOUT_MS,
);

test(
	"SDK run control rejects unknown and foreign run prefixes promptly and stays usable (#3377)",
	async () => {
		const files = markers.prefix;
		const runId = await launchThroughSessionTool(owner, "prefix");
		await waitForFile(files.reached);
		const prefix = runId.slice(0, 8);

		for (const [session, target] of [
			[owner, UNKNOWN_RUN_PREFIX],
			[other, UNKNOWN_RUN_PREFIX],
			[other, prefix],
		] as const) {
			for (const [name, operation] of [
				["getRun", () => session.workflows.getRun(target)],
				["getStages", () => session.workflows.getStages(target)],
				["pause", () => session.workflows.pause(target)],
				["quit", () => session.workflows.quit(target)],
			] as const) {
				const error = await settledRejection(operation(), `${name}(${target})`);
				assert.ok(error instanceof WorkflowRunNotFoundError, error.message);
				assert.equal(error.code, "WORKFLOW_RUN_NOT_FOUND");
			}
		}

		assert.equal((await owner.workflows.getRun(prefix)).runId, runId);
		const foreign = await settledRejection(other.workflows.pause(runId), "pause(full foreign id)");
		assert.ok(foreign instanceof WorkflowRunOwnershipError, foreign.message);
		const paused = await owner.workflows.pause({ all: true });
		assert.equal(paused.runId, "--all");
		assert.equal(paused.status, "paused");
		assert.equal((await owner.workflows.getRun(prefix)).status, "paused");

		writeFileSync(files.gate, "release");
		const resumed = await owner.workflows.resume(runId);
		assert.equal(resumed.status, "ok");
		await completed(owner, runId);
		assert.equal(existsSync(files.finished), true);
	},
	REAL_SDK_WORKFLOW_RUN_CONTROL_TIMEOUT_MS,
);

test(
	"SDK run control reports typed errors for unknown, foreign and disposed sessions (#3377)",
	async () => {
		const files = markers.guard;
		const runId = await launchThroughSessionTool(owner, "guard");
		await waitForFile(files.reached);

		for (const operation of [
			() => owner.workflows.getRun(UNKNOWN_RUN_ID),
			() => owner.workflows.getStages(UNKNOWN_RUN_ID),
			() => owner.workflows.pause(UNKNOWN_RUN_ID),
			() => owner.workflows.quit(UNKNOWN_RUN_ID),
			() => owner.workflows.resume(UNKNOWN_RUN_ID),
			() => owner.workflows.resume("not-a-run-id"),
		]) {
			const error = await rejection(operation());
			assert.ok(error instanceof WorkflowRunNotFoundError, error.message);
			assert.equal(error.code, "WORKFLOW_RUN_NOT_FOUND");
		}

		for (const operation of [
			() => other.workflows.pause(runId),
			() => other.workflows.quit(runId),
			() => other.workflows.resume(runId),
		]) {
			const error = await rejection(operation());
			assert.ok(error instanceof WorkflowRunOwnershipError, error.message);
			assert.equal(error.code, "WORKFLOW_RUN_OWNED_ELSEWHERE");
		}
		assert.equal((await other.workflows.getRun(runId)).runId, runId);
		assert.deepEqual(await other.workflows.getStages(runId), []);
		assert.deepEqual(await other.workflows.listRuns(), []);
		assert.equal((await owner.workflows.getRun(runId)).status, "running");

		writeFileSync(files.gate, "release");
		await completed(owner, runId);

		await owner.dispose();
		const unavailable = await rejection(owner.workflows.listRuns());
		assert.ok(unavailable instanceof WorkflowRunControlUnavailableError, unavailable.message);
		assert.ok(unavailable instanceof WorkflowRunControlError);
		assert.equal(unavailable.code, "WORKFLOW_RUN_CONTROL_UNAVAILABLE");
	},
	REAL_SDK_WORKFLOW_RUN_CONTROL_TIMEOUT_MS,
);
