import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	type AgentSession,
	createAgentSession,
	SessionManager,
	SettingsManager,
	WorkflowRunNotResumableError,
	WorkflowRunOwnershipError,
} from "../../packages/coding-agent/src/index.js";
import {
	fileExists,
	makeTempDirectory,
	readText,
	removePath,
	sleep,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";
import { currentStoreBackend as getDurableBackend } from "../helpers/store-backend.js";

/** Two real SDK host sessions in one process, each loading the builtin workflows extension. */
const IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS = 90_000;
const RUN_SETTLE_TIMEOUT_MS = 20_000;

interface Project {
	readonly cwd: string;
	readonly effectFile: string;
	readonly reachedFile: string;
}

const projects: string[] = [];

afterEach(async () => {
	for (const cwd of projects.splice(0)) await removePath(cwd, { recursive: true, force: true });
});

async function createProject(blockFrontierOnFirstAttempt: boolean): Promise<Project> {
	const cwd = makeTempDirectory("atomic-disposed-owner-adoption-");
	projects.push(cwd);
	const effectFile = join(cwd, "completed-effect.txt");
	const reachedFile = join(cwd, "frontier-reached.txt");
	const attemptsFile = join(cwd, "frontier-attempts.txt");
	await writeFileEnsuringDir(
		join(cwd, ".atomic", "workflows", "disposed-owner.ts"),
		`import { workflow } from "@bastani/atomic/workflows";
import { appendFile, readFile, writeFile } from "node:fs/promises";
export default workflow({ name: "disposed-owner", description: "Resume after the owning session was disposed", inputs: {}, outputs: {}, run: async (ctx) => {
  await ctx.tool("completed-effect", {}, async () => { await appendFile(${JSON.stringify(effectFile)}, "effect\\n"); return "checkpointed"; });
  await ctx.tool("frontier", {}, async ({ signal }) => {
    await appendFile(${JSON.stringify(attemptsFile)}, "attempt\\n");
    const attempts = (await readFile(${JSON.stringify(attemptsFile)}, "utf8")).split("\\n").length - 1;
    if (!${blockFrontierOnFirstAttempt} || attempts > 1) return "finished";
    await writeFile(${JSON.stringify(reachedFile)}, "reached");
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("frontier paused")), { once: true }));
  });
  return {};
} });
`,
	);
	return { cwd, effectFile, reachedFile };
}

async function createHost(project: Project): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: project.cwd,
		agentDir: join(project.cwd, "agent"),
		sessionManager: SessionManager.inMemory(project.cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	return session;
}

/** Launch through the model-facing `workflow` tool, which records the session as the run's owner. */
async function launchAsAgent(session: AgentSession): Promise<string> {
	const tool = session.agent.state.tools.find((entry) => entry.name === "workflow");
	assert.ok(tool, "the builtin workflow tool must be registered");
	const launch = await tool.execute(
		"launch",
		{ action: "run", workflow: "disposed-owner", inputs: {} },
		new AbortController().signal,
	);
	const details = launch.details as { runId?: string; error?: string };
	assert.ok(details.runId && details.error === undefined, JSON.stringify(launch));
	return details.runId;
}

async function launchAndQuit(session: AgentSession, project: Project): Promise<string> {
	const runId = await launchAsAgent(session);
	await vi.waitFor(async () => assert.equal(await fileExists(project.reachedFile), true), {
		timeout: RUN_SETTLE_TIMEOUT_MS,
	});
	await session.workflows.quit(runId);
	await vi.waitFor(() => assert.equal(getDurableBackend().getWorkflow(runId)?.status, "paused"), {
		timeout: RUN_SETTLE_TIMEOUT_MS,
	});
	return runId;
}

test(
	"a sibling SDK session adopts a paused agent-launched run once its owning session is disposed (#3566)",
	async () => {
		const project = await createProject(true);
		const owner = await createHost(project);
		const successor = await createHost(project);
		try {
			const runId = await launchAndQuit(owner, project);

			await assert.rejects(
				successor.workflows.resume(runId),
				(error: unknown) =>
					error instanceof WorkflowRunOwnershipError &&
					error.message === "Workflow instance belongs to another caller/session.",
				"a live owner must keep refusing adoption",
			);
			assert.equal(getDurableBackend().getWorkflow(runId)?.status, "paused");

			await owner.dispose();
			assert.equal(getDurableBackend().getWorkflow(runId)?.status, "paused");

			const outcome = await successor.workflows.resume(runId);
			assert.equal(outcome.runId, runId, "adoption must reuse the durable identity");
			await vi.waitFor(async () => assert.equal((await successor.workflows.getRun(runId)).status, "completed"), {
				timeout: RUN_SETTLE_TIMEOUT_MS,
			});
			assert.deepEqual(
				(await successor.workflows.listRuns()).map((run) => run.runId),
				[runId],
			);
			assert.equal(await readText(project.effectFile), "effect\n", "completed effects must not run again");
			assert.equal(getDurableBackend().getWorkflow(runId)?.releasedModelOwner, undefined);
		} finally {
			await Promise.allSettled([owner.dispose(), successor.dispose()]);
		}
	},
	IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS,
);

test(
	"disposing the owner while its agent-launched run is still executing releases it for a sibling SDK session (#3566)",
	async () => {
		const project = await createProject(true);
		const owner = await createHost(project);
		const successor = await createHost(project);
		try {
			const runId = await launchAsAgent(owner);
			await vi.waitFor(async () => assert.equal(await fileExists(project.reachedFile), true), {
				timeout: RUN_SETTLE_TIMEOUT_MS,
			});
			assert.equal(getDurableBackend().getWorkflow(runId)?.status, "running");

			await owner.dispose();
			const released = getDurableBackend().getWorkflow(runId);
			assert.equal(released?.status, "paused", "disposal must stop the running workflow at its checkpoint");
			assert.equal(released?.releasedModelOwner, released?.modelOwner, "disposal must durably release the run");

			const outcome = await successor.workflows.resume(runId);
			assert.equal(outcome.runId, runId, "adoption must reuse the durable identity");
			await vi.waitFor(async () => assert.equal((await successor.workflows.getRun(runId)).status, "completed"), {
				timeout: RUN_SETTLE_TIMEOUT_MS,
			});
			assert.equal(await readText(project.effectFile), "effect\n", "completed effects must not run again");
			assert.equal(getDurableBackend().getWorkflow(runId)?.releasedModelOwner, undefined);
		} finally {
			await Promise.allSettled([owner.dispose(), successor.dispose()]);
		}
	},
	IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS,
);

test(
	"a disposed session's completed run stays non-resumable for sibling SDK sessions (#3566)",
	async () => {
		const project = await createProject(false);
		const owner = await createHost(project);
		const successor = await createHost(project);
		try {
			const runId = await launchAsAgent(owner);
			await vi.waitFor(async () => assert.equal((await owner.workflows.getRun(runId)).status, "completed"), {
				timeout: RUN_SETTLE_TIMEOUT_MS,
			});
			await owner.dispose();

			await assert.rejects(
				successor.workflows.resume(runId),
				(error: unknown) =>
					error instanceof WorkflowRunOwnershipError || error instanceof WorkflowRunNotResumableError,
			);
			await sleep(100);
			assert.equal(getDurableBackend().getWorkflow(runId)?.status, "completed");
			assert.equal(getDurableBackend().getWorkflow(runId)?.modelOwner === undefined, false);
			assert.deepEqual(await successor.workflows.listRuns(), []);
			assert.equal(await readText(project.effectFile), "effect\n");
		} finally {
			await Promise.allSettled([owner.dispose(), successor.dispose()]);
		}
	},
	IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS,
);
