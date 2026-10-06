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
import { createRealDbosHandle } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import { importDbosSdk } from "../../packages/workflows/src/durable/dbos-backend.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { Client } from "pg";
import { getDbosProcessOwner } from "../../packages/workflows/src/durable/dbos-process-owner.js";
import { getDurableBackend } from "../../packages/workflows/src/durable/factory.js";
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
const releaseFile = join(home, "release-source-callback.txt");
const sourceReturnedFile = join(home, "source-callback-returned.txt");
let session: AgentSession | undefined;
let clockOffset = 0;
const wallClock = Date.now.bind(Date);
Date.now = () => wallClock() + clockOffset;
const probeProcess = process.kill.bind(process);
let maskedOwnerPid: number | undefined;
process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
	if (pid === maskedOwnerPid && signal === 0) throw Object.assign(new Error("source PID absent in cloned guest"), { code: "ESRCH" });
	return probeProcess(pid, signal);
}) as typeof process.kill;

async function ready(): Promise<AgentSession> {
	if (session !== undefined) return session;
	mkdirSync(join(cwd, ".atomic"), { recursive: true });
	mkdirSync(join(packageDir, "workflows"), { recursive: true });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "sdk-crashed-recovery-fixture", type: "module", atomic: { workflows: ["./workflows/*.ts"] } }));
	writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify({ packages: [packageDir] }));
	writeFileSync(join(packageDir, "workflows", "recovery.ts"), `import { workflow } from "@bastani/workflows";
import { appendFile, access, writeFile } from "node:fs/promises";
export default workflow({ name: "sdk-crashed-recovery", description: "SDK durable recovery regression", inputs: {}, outputs: {}, run: async ctx => {
  await ctx.tool("completed-effect", {}, async () => { await appendFile(${JSON.stringify(effectFile)}, "effect\\n"); return "checkpointed"; });
  await ctx.tool("frontier", {}, async () => {
    if (process.env.ATOMIC_SDK_RECOVERY_PRODUCER === "1") {
      await writeFile(${JSON.stringify(reachedFile)}, "reached");
      if (process.env.ATOMIC_SDK_RECOVERY_RELEASEABLE === "1") {
        while (!(await access(${JSON.stringify(releaseFile)}).then(() => true, () => false))) await new Promise(resolve => setTimeout(resolve, 20));
        await writeFile(${JSON.stringify(sourceReturnedFile)}, "source returned");
        return "late-source-result";
      }
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
		} else if (command === "terminate-owner") {
			assert.ok(runId);
			const host = await ready();
			await host.workflows.getRun(runId);
			const backend = getDurableBackend();
			const hydrated = await backend.hydrateWorkflowForInspection!(runId);
			assert.equal(hydrated.kind, "current");
			assert.ok(hydrated.kind === "current" && hydrated.handle.ownerExecutorId);
			const connectionString = getDbosProcessOwner().databaseDiagnostics?.().url;
			assert.ok(connectionString);
			const client = new Client({ connectionString });
			await client.connect();
			try {
				const terminated = await client.query<{ terminated: boolean }>("SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name = $1", [`atomic-owner:${hydrated.handle.ownerExecutorId}`]);
				assert.equal(terminated.rows.length, 1, "must terminate only the recorded ownership connection");
				assert.equal(terminated.rows[0].terminated, true);
			} finally {
				await client.end();
			}
		} else if (command === "release-source") {
			writeFileSync(releaseFile, "release");
			await until(() => fileExists(sourceReturnedFile), "source callback never returned after fencing");
			assert.ok(runId);
			const host = await ready();
			await until(async () => ["paused", "failed", "completed", "cancelled"].includes((await host.workflows.getRun(runId)).status), "source run never settled after lost ownership");
			const settled = await host.workflows.getRun(runId);
			const dependencyError = "dependencyError" in settled && typeof settled.dependencyError === "string" ? settled.dependencyError : settled.error;
			result = { status: settled.status, resumable: settled.resumable, error: dependencyError };
		} else if (command === "durable-state") {
			assert.ok(runId);
			const host = await ready();
			await host.workflows.getRun(runId);
			const backend = getDurableBackend();
			const hydrated = await backend.hydrateWorkflowForInspection!(runId);
			assert.ok(hydrated.kind === "current");
			const wrappers = getDbosProcessOwner().wrappers;
			assert.ok(wrappers);
			const sdk = createRealDbosHandle(await importDbosSdk(), wrappers.mainWorkflow, wrappers.checkpointWorkflow);
			const records = (await sdk.listStepRecords(runId)).map(({ stepName, output }) => ({ stepName, output })).sort((a, b) => a.stepName.localeCompare(b.stepName));
			result = { status: hydrated.handle.status, modelOwner: hydrated.handle.modelOwner, ownerExecutorId: hydrated.handle.ownerExecutorId, updatedAt: hydrated.handle.updatedAt, checkpoints: backend.listCheckpoints(runId), records };
		} else if (command === "mask-owner") {
			maskedOwnerPid = Number(runId);
			assert.ok(Number.isSafeInteger(maskedOwnerPid) && maskedOwnerPid > 0);
		} else if (command === "expire") {
			clockOffset = FOREIGN_LIVE_WORKFLOW_WINDOW_MS + 1000;
		} else if (command === "resume") {
			assert.ok(runId);
			const host = await ready();
			const outcome = await host.workflows.resume(runId);
			await until(async () => (await host.workflows.getRun(runId)).status === "completed", "adopted run did not complete");
			const backend = getDurableBackend();
			await until(async () => backend.getWorkflow(runId)?.status === "completed", "adopted durable run did not complete");
			await backend.flush(runId);
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
