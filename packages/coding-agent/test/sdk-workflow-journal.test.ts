import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { getModel } from "@bastani/pi-ai/compat";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import type { DurableBackendProcessOwner } from "../../workflows/src/durable/backend-process-owner.ts";
import { MemoryRunJournal } from "../../workflows/src/durable/journal/memory-run-journal.ts";
import { openSqlRunJournal } from "../../workflows/src/durable/journal/sqlite-run-journal.ts";
import type { AgentSession } from "../src/core/agent-session.js";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Settings } from "../src/core/settings-types.js";
import { wrapNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";

const REAL_SDK_WORKFLOW_TIMEOUT_MS = 120_000;
const SESSIONS_PER_JOURNAL_KIND = 5;
// Only the workflows extension is under test. The other builtins (intercom's broker and delivery database, the
// subagents/mcp/web-access loaders) keep writing under the agent directory after dispose and race rmSync on Windows.
const WORKFLOWS_ONLY: CreateAgentSessionOptions["builtins"] = {
	subagents: false,
	intercom: false,
	mcp: false,
	"web-access": false,
};
const DURABLE_BACKENDS = Symbol.for("atomic-workflows/durable-backend-process-owner@1");

let root: string;
let transpileCacheHome: string;
const sessions: AgentSession[] = [];

// The extension loader memoizes its transpile cache directory from the first agent directory it sees and keeps
// writing there for the life of the process. Pin it to a directory that outlives every test so a per-test root is
// never recreated after its cleanup.
beforeAll(() => {
	transpileCacheHome = mkdtempSync(join(tmpdir(), "atomic-sdk-workflow-journal-cache-"));
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(transpileCacheHome, "agent"));
	extensionLoaderTestHooks.getTranspileCacheDir();
	vi.unstubAllEnvs();
});

afterAll(() => {
	rmSync(transpileCacheHome, { recursive: true, force: true });
});

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-sdk-workflow-journal-"));
	mkdirSync(join(root, "project"), { recursive: true });
	mkdirSync(join(root, "agent", "workflows"), { recursive: true });
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", "");
	writeFileSync(
		join(root, "agent", "workflows", "journal-probe.ts"),
		`import { workflow } from "@bastani/atomic/workflows";
export default workflow({ name: "journal-probe", description: "Journal selection probe", inputs: {}, outputs: {}, run: async (ctx) => {
await ctx.tool("probe", {}, async () => "probed");
return {};
} });\n`,
	);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	try {
		for (const session of sessions.splice(0)) await session.dispose();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

async function startSession(
	options: Pick<CreateAgentSessionOptions, "journal"> & { settings?: Partial<Settings>; onDiskSettings?: Settings },
): Promise<AgentSession> {
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	if (options.onDiskSettings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.onDiskSettings));
	const settingsManager = options.settings
		? SettingsManager.inMemory(options.settings)
		: SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		builtins: WORKFLOWS_ONLY,
		...(options.journal === undefined ? {} : { journal: options.journal }),
	});
	sessions.push(session);
	return session;
}

async function runProbe(session: AgentSession): Promise<string> {
	const tool = session.agent.state.tools.find((entry) => entry.name === "workflow");
	assert.ok(tool, "SDK session must expose the workflow tool");
	const started = await tool.execute("probe-run", { action: "run", workflow: "journal-probe", inputs: {} });
	const launch = started.details as { runId?: string; error?: string };
	assert.equal(launch.error, undefined, JSON.stringify(started));
	assert.ok(launch.runId, JSON.stringify(started));
	const deadline = Date.now() + 30_000;
	for (;;) {
		const result = await tool.execute("probe-status", { action: "status", runId: launch.runId });
		const status = result.details as { detail?: { status: string }; error?: string };
		assert.equal(status.error, undefined, JSON.stringify(result));
		if (status.detail && status.detail.status !== "running" && status.detail.status !== "pending") {
			assert.equal(status.detail.status, "completed", JSON.stringify(result));
			return launch.runId;
		}
		assert.ok(Date.now() < deadline, JSON.stringify(result));
		await delay(25);
	}
}

async function runIdsAt(path: string): Promise<string[]> {
	const journal = await openSqlRunJournal(path);
	try {
		return (await journal.listRuns()).map((run) => run.runId);
	} finally {
		await journal.close();
	}
}

const defaultJournal = (): string => join(root, "workflows", "journal.sqlite");

const retainedBackendCount = (): number =>
	(globalThis as typeof globalThis & Record<symbol, DurableBackendProcessOwner | undefined>)[DURABLE_BACKENDS]
		?.selectedBackends?.size ?? 0;

test(
	"two SDK sessions in one process keep runs in their own journal files without the env var (#3743)",
	async () => {
		const first = join(root, "first.sqlite");
		const second = join(root, "second.sqlite");
		const firstSession = await startSession({ journal: { path: first } });
		const secondSession = await startSession({ journal: { path: second } });
		const firstRun = await runProbe(firstSession);
		const secondRun = await runProbe(secondSession);
		assert.deepEqual(await runIdsAt(first), [firstRun]);
		assert.deepEqual(await runIdsAt(second), [secondRun]);
		assert.equal(existsSync(defaultJournal()), false);
	},
	REAL_SDK_WORKFLOW_TIMEOUT_MS,
);

test(
	"an SDK session can use a caller-owned database or supplied journal while another uses memory (#3743)",
	async () => {
		const databasePath = join(root, "caller.sqlite");
		const database = new DatabaseSync(databasePath);
		const supplied = new MemoryRunJournal();
		try {
			const databaseSession = await startSession({ journal: { database: wrapNodeSqliteDatabase(database) } });
			const suppliedSession = await startSession({ journal: supplied });
			const memorySession = await startSession({ journal: { memory: true } });
			const databaseRun = await runProbe(databaseSession);
			const suppliedRun = await runProbe(suppliedSession);
			await runProbe(memorySession);
			const assertRunsRecorded = async (): Promise<void> => {
				assert.deepEqual(
					database
						.prepare("SELECT run_id FROM wf_runs")
						.all()
						.map((row) => row.run_id),
					[databaseRun],
				);
				assert.deepEqual(
					(await supplied.listRuns()).map((run) => run.runId),
					[suppliedRun],
				);
			};
			await assertRunsRecorded();
			assert.equal(existsSync(defaultJournal()), false);
			for (const session of sessions.splice(0)) await session.dispose();
			await assertRunsRecorded();
		} finally {
			for (const session of sessions.splice(0)) await session.dispose();
			database.close();
		}
	},
	REAL_SDK_WORKFLOW_TIMEOUT_MS,
);

test(
	"in-memory session settings choose the workflow journal per session (#3743)",
	async () => {
		const first = join(root, "settings-first.sqlite");
		const second = join(root, "settings-second.sqlite");
		const firstSession = await startSession({ settings: { workflows: { journal: { path: first } } } });
		const secondSession = await startSession({ settings: { workflows: { journal: { path: second } } } });
		const memorySession = await startSession({ settings: { workflows: { journal: { memory: true } } } });
		const firstRun = await runProbe(firstSession);
		const secondRun = await runProbe(secondSession);
		await runProbe(memorySession);
		assert.deepEqual(await runIdsAt(first), [firstRun]);
		assert.deepEqual(await runIdsAt(second), [secondRun]);
		assert.equal(existsSync(defaultJournal()), false);
	},
	REAL_SDK_WORKFLOW_TIMEOUT_MS,
);

test(
	"the journal option takes precedence over the session's workflows.journal settings (#3743)",
	async () => {
		const configured = join(root, "configured.sqlite");
		const explicit = join(root, "explicit.sqlite");
		const session = await startSession({
			settings: { workflows: { journal: { path: configured } } },
			journal: { path: explicit },
		});
		const runId = await runProbe(session);
		assert.deepEqual(await runIdsAt(explicit), [runId]);
		assert.equal(existsSync(configured), false);
	},
	REAL_SDK_WORKFLOW_TIMEOUT_MS,
);

test(
	"ATOMIC_WORKFLOW_JOURNAL_PATH and on-disk settings.json still select the journal (#3743)",
	async () => {
		const fromEnv = join(root, "env.sqlite");
		const fromFile = join(root, "settings-file.sqlite");
		const fileSession = await startSession({ onDiskSettings: { workflows: { journal: { path: fromFile } } } });
		const fileRun = await runProbe(fileSession);
		assert.deepEqual(await runIdsAt(fromFile), [fileRun]);
		vi.stubEnv("ATOMIC_WORKFLOW_JOURNAL_PATH", fromEnv);
		const envSession = await startSession({ onDiskSettings: { workflows: { journal: { path: fromFile } } } });
		const envRun = await runProbe(envSession);
		assert.deepEqual(await runIdsAt(fromEnv), [envRun]);
		assert.deepEqual(await runIdsAt(fromFile), [fileRun]);
	},
	REAL_SDK_WORKFLOW_TIMEOUT_MS,
);

test(
	"disposing SDK sessions releases their journals and process exit listeners without warnings (#3743)",
	async () => {
		const warnings: string[] = [];
		const recordWarning = (warning: Error): void => {
			warnings.push(warning.name);
		};
		process.on("warning", recordWarning);
		const backendsBefore = retainedBackendCount();
		const listenersBefore = process.listenerCount("exit");
		try {
			const live: AgentSession[] = [];
			for (let index = 0; index < SESSIONS_PER_JOURNAL_KIND; index++) {
				live.push(await startSession({ settings: { workflows: { journal: { memory: true } } } }));
				live.push(await startSession({ journal: { memory: true } }));
				live.push(await startSession({ journal: { path: join(root, `owned-${index}.sqlite`) } }));
			}
			for (const session of live) await runProbe(session);
			assert.equal(retainedBackendCount(), backendsBefore + live.length);
			for (const session of live) await session.dispose();
			assert.equal(retainedBackendCount(), backendsBefore);
			assert.equal(process.listenerCount("exit"), listenersBefore);
			await delay(0);
			assert.deepEqual(warnings, []);
		} finally {
			process.off("warning", recordWarning);
		}
	},
	REAL_SDK_WORKFLOW_TIMEOUT_MS,
);

test(
	"sessions sharing one journal path keep it open until the last of them is disposed (#3743)",
	async () => {
		const shared = join(root, "shared.sqlite");
		const backendsBefore = retainedBackendCount();
		const first = await startSession({ settings: { workflows: { journal: { path: shared } } } });
		const second = await startSession({ settings: { workflows: { journal: { path: shared } } } });
		const firstRun = await runProbe(first);
		const secondRun = await runProbe(second);
		assert.equal(retainedBackendCount(), backendsBefore + 1);
		await first.dispose();
		assert.equal(retainedBackendCount(), backendsBefore + 1);
		const afterFirstDisposed = await runProbe(second);
		await second.dispose();
		assert.equal(retainedBackendCount(), backendsBefore);
		assert.deepEqual((await runIdsAt(shared)).sort(), [firstRun, secondRun, afterFirstDisposed].sort());
	},
	REAL_SDK_WORKFLOW_TIMEOUT_MS,
);
