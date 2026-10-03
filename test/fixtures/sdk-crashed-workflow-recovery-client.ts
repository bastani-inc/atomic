import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getModel } from "@bastani/pi-ai/compat";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { shutdownDbos } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { fileExists, readText, sleep } from "../helpers/runtime.js";

const home = process.env.ATOMIC_FAULT_TEST_HOME;
assert.ok(home && resolve(homedir()) === resolve(home), "requires disposable HOME");
assert.notEqual(process.getuid?.(), 0, "refuse managed database fault injection as root");
assert.equal(process.env.DBOS_SYSTEM_DATABASE_URL, undefined, "requires the disposable managed database");
const cwd = join(home, "project");
const agentDir = join(home, "agent");
const packageDir = join(home, "workflow-package");
const effectFile = join(home, "completed-effect.txt");
const reachedFile = join(home, "frontier-reached.txt");
let session: AgentSession | undefined;
let clockOffset = 0;
const wallClock = Date.now.bind(Date);
Date.now = () => wallClock() + clockOffset;

async function ready(): Promise<AgentSession> {
	if (session !== undefined) return session;
	mkdirSync(join(cwd, ".atomic"), { recursive: true });
	mkdirSync(join(packageDir, "workflows"), { recursive: true });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "sdk-crashed-recovery-fixture", type: "module", atomic: { workflows: ["./workflows/*.ts"] } }));
	writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify({ packages: [packageDir] }));
	writeFileSync(join(packageDir, "workflows", "recovery.ts"), `import { workflow } from "@bastani/workflows";
import { appendFile, writeFile } from "node:fs/promises";
export default workflow({ name: "sdk-crashed-recovery", description: "SDK durable recovery regression", inputs: {}, outputs: {}, run: async ctx => {
  await ctx.tool("completed-effect", {}, async () => { await appendFile(${JSON.stringify(effectFile)}, "effect\\n"); return "checkpointed"; });
  await ctx.tool("frontier", {}, async () => {
    if (process.env.ATOMIC_SDK_RECOVERY_PRODUCER === "1") {
      await writeFile(${JSON.stringify(reachedFile)}, "reached");
      await new Promise(() => {});
    }
    return "finished";
  });
  return {};
} });\n`);
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, builtinPackagePaths: [] });
	await loader.reload();
	await loader.refreshWorkflowResources();
	({ session } = await createAgentSession({
		cwd, agentDir, settingsManager, resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		model: { ...getModel("openai-codex", "gpt-6.1-sol")!, id: "gpt-6.1-sol-fast" },
	}));
	return session;
}

async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
	const deadline = wallClock() + 30_000;
	while (!(await predicate())) {
		assert.ok(wallClock() < deadline, label);
		await sleep(20);
	}
}

async function refusal(operation: Promise<object>): Promise<string> {
	try {
		await operation;
		return "accepted";
	} catch (error) {
		assert.ok(error instanceof Error && "code" in error && typeof error.code === "string");
		return error.code;
	}
}

for await (const line of createInterface({ input: process.stdin })) {
	const { id, command, sql: runId } = JSON.parse(line) as { id: number; command: string; sql?: string };
	try {
		let result: object = {};
		if (command === "start") {
			const host = await ready();
			const tool = host.agent.state.tools.find((entry) => entry.name === "workflow");
			assert.ok(tool);
			const launch = await tool.execute("sdk-recovery-launch", { action: "run", workflow: "sdk-crashed-recovery", inputs: {} });
			const details = launch.details as { runId?: string; error?: string };
			assert.ok(details.runId && !details.error, JSON.stringify(launch));
			await until(() => fileExists(reachedFile), "producer never reached the checkpointed frontier");
			assert.equal(await readText(effectFile), "effect\n");
			result = { runId: details.runId, pid: process.pid };
		} else if (command === "inspect") {
			assert.ok(runId);
			const host = await ready();
			const detail = await host.workflows.getRun(runId);
			const stages = await host.workflows.getStages(runId);
			result = { runId: detail.runId, status: detail.status, stages: stages.length, listed: (await host.workflows.listRuns()).map((run) => run.runId), effect: await readText(effectFile) };
		} else if (command === "controls") {
			assert.ok(runId);
			const host = await ready();
			result = {
				pause: await refusal(host.workflows.pause(runId)),
				quit: await refusal(host.workflows.quit(runId)),
				resume: await refusal(host.workflows.resume(runId)),
			};
		} else if (command === "expire") {
			clockOffset = FOREIGN_LIVE_WORKFLOW_WINDOW_MS + 1000;
		} else if (command === "resume") {
			assert.ok(runId);
			const host = await ready();
			const outcome = await host.workflows.resume(runId);
			await until(async () => (await host.workflows.getRun(runId)).status === "completed", "adopted run did not complete");
			const tool = host.agent.state.tools.find((entry) => entry.name === "workflow");
			assert.ok(tool);
			const ownedInspection = await tool.execute("sdk-recovery-owner-check", { action: "status", runId });
			assert.ok(ownedInspection.isError !== true, JSON.stringify(ownedInspection));
			result = { runId: outcome.runId, status: (await host.workflows.getRun(runId)).status, listed: (await host.workflows.listRuns()).map((run) => run.runId), effect: await readText(effectFile) };
		} else if (command === "crash") {
			console.log(JSON.stringify({ id, result: { pid: process.pid } }));
			setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
			continue;
		} else if (command === "exit") {
			await session?.dispose();
			await shutdownDbos();
			console.log(JSON.stringify({ id, result }));
			process.exit(0);
		} else throw new Error(`Unknown command ${command}`);
		console.log(JSON.stringify({ id, result }));
	} catch (error) {
		console.log(JSON.stringify({ id, error: error instanceof Error ? error.stack : String(error) }));
	}
}
