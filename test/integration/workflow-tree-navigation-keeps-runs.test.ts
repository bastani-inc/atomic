import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	type AgentSession,
	createAgentSession,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import type { WorkflowToolArgs } from "../../packages/workflows/src/extension/public-types.js";
import { fileExists, makeTempDirectory, removePath, writeFileEnsuringDir } from "../helpers/runtime.js";
import { currentStoreBackend as getDurableBackend } from "../helpers/store-backend.js";

/** One real SDK host session loading the builtin workflows extension. */
const IN_PROCESS_SDK_SESSION_TIMEOUT_MS = 90_000;
const RUN_SETTLE_TIMEOUT_MS = 20_000;

const projects: string[] = [];

afterEach(async () => {
	for (const cwd of projects.splice(0)) await removePath(cwd, { recursive: true, force: true });
});

async function createProject(): Promise<{ cwd: string; reachedFile: string }> {
	const cwd = makeTempDirectory("atomic-tree-navigation-");
	projects.push(cwd);
	const reachedFile = join(cwd, "frontier-reached.txt");
	await writeFileEnsuringDir(
		join(cwd, ".atomic", "workflows", "tree-navigation.ts"),
		`import { workflow } from "@bastani/atomic/workflows";
import { writeFile } from "node:fs/promises";
export default workflow({ name: "tree-navigation", description: "Keeps running while the session tree is navigated", inputs: {}, outputs: {}, run: async (ctx) => {
  await ctx.tool("checkpointed", {}, async () => "checkpointed");
  await ctx.tool("frontier", {}, async ({ signal }) => {
    await writeFile(${JSON.stringify(reachedFile)}, "reached");
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("frontier paused")), { once: true }));
  });
  return {};
} });
`,
	);
	return { cwd, reachedFile };
}

async function createHost(cwd: string): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	return session;
}

async function callWorkflowTool(session: AgentSession, args: WorkflowToolArgs) {
	const tool = session.agent.state.tools.find((entry) => entry.name === "workflow");
	assert.ok(tool, "the builtin workflow tool must be registered");
	return tool.execute("call", args, new AbortController().signal);
}

test(
	"navigating the session tree leaves in-flight workflow runs executing, owned, unreleased, and controllable (#3569)",
	async () => {
		const project = await createProject();
		const session = await createHost(project.cwd);
		try {
			const launch = await callWorkflowTool(session, { action: "run", workflow: "tree-navigation", inputs: {} });
			const runId = (launch.details as { runId?: string }).runId;
			assert.ok(runId, JSON.stringify(launch));
			await vi.waitFor(async () => assert.equal(await fileExists(project.reachedFile), true), {
				timeout: RUN_SETTLE_TIMEOUT_MS,
			});
			const owner = getDurableBackend().getWorkflow(runId)?.modelOwner;
			assert.ok(owner, "the model tool must record the session as the run's owner");
			assert.equal(getDurableBackend().getWorkflow(runId)?.status, "running");

			const first = await session.sessionManager.appendMessage({
				role: "user",
				content: "first",
				timestamp: Date.now(),
			});
			await session.sessionManager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
			const navigation = await session.navigateTree(first, { summarize: false });
			assert.equal(navigation.cancelled, false);

			const afterNavigation = getDurableBackend().getWorkflow(runId);
			assert.equal(afterNavigation?.status, "running", "/tree must not quit the in-flight run");
			assert.equal(afterNavigation?.modelOwner, owner, "/tree must not change the run's owner");
			assert.equal(afterNavigation?.releasedModelOwner, undefined, "/tree must not release the run");
			assert.equal((await session.workflows.getRun(runId)).status, "running");

			const status = await callWorkflowTool(session, { action: "status", runId });
			assert.equal((status.details as { action?: string }).action, "statusDetail");
			assert.equal((status.details as { error?: string }).error, undefined);

			const quit = await callWorkflowTool(session, { action: "quit", runId });
			assert.equal((quit.details as { status?: string }).status, "paused", JSON.stringify(quit));
			await vi.waitFor(() => assert.equal(getDurableBackend().getWorkflow(runId)?.status, "paused"), {
				timeout: RUN_SETTLE_TIMEOUT_MS,
			});
			assert.equal(getDurableBackend().getWorkflow(runId)?.modelOwner, owner);
			assert.equal(getDurableBackend().getWorkflow(runId)?.releasedModelOwner, undefined);
		} finally {
			await Promise.allSettled([session.dispose()]);
		}
	},
	IN_PROCESS_SDK_SESSION_TIMEOUT_MS,
);
