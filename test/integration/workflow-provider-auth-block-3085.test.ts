import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	installWorkflowLifecycleNotifications,
	LIFECYCLE_NOTICE_CUSTOM_TYPE,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createExtensionRuntime, type ExtensionRuntimeOpts } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../packages/workflows/src/shared/workflow-artifact-env.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { moduleDir, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";
import { createMockSdk, serializeMockSdkState } from "../unit/durable-dbos-backend-helpers.js";
import {
	createIssue3085Definition,
	ISSUE_3085_WORKFLOW_NAME,
	type Issue3085PersistedState,
	type Issue3085ResumeResult,
	persistPath,
	prefixPath,
	readPrefix,
	resultPath,
} from "./fixtures/issue-3085-provider-auth-block.js";
import { createIssue3085StageSession } from "./fixtures/issue-3085-provider-auth-block-session.js";

/**
 * Structural: this case serializes durable workflow state, then spawns a real
 * Node child that hydrates and resumes through the workflows TypeScript graph
 * via jiti. Named and kept at the call site, per AGENTS.md.
 *
 * The child's cost is dominated by jiti's cold transform of the coding-agent
 * SDK and workflows runtime graph, which CI never has cached: 7.1s cold versus
 * 2.7s warm locally, and a loaded Windows runner exceeded a 45s child budget
 * where an idle retry of the same job finished in 23.5s.
 */
const ISOLATED_PROCESS_RESTART_TIMEOUT_MS = 150_000;
const RESUME_CHILD_TIMEOUT_MS = 120_000;

const repositoryRoot = join(moduleDir(import.meta.url), "../..");
const resumeFixture = join(moduleDir(import.meta.url), "fixtures", "issue-3085-provider-auth-block.ts");

afterEach(() => {
	vi.useRealTimers();
	setDurableBackend(undefined);
});

test(
	"isolated process restart restores blocked metadata and resumes without replaying the prefix",
	async () => {
		// Issue #3085
		const dir = mkdtempSync(join(tmpdir(), "atomic-3085-restart-"));
		mkdirSync(join(dir, "agent"), { recursive: true });
		mkdirSync(join(dir, "artifacts"), { recursive: true });
		const sessions: StageSessionRuntime[] = [];
		try {
			const sdk = createMockSdk();
			const backend = new DbosDurableBackend(sdk, { executorId: "3085-writer" });
			setDurableBackend(backend);

			const parent = SessionManager.create(dir, join(dir, "parent-sessions"));
			const store = createStore();
			const notices: Array<{ customType?: string; details?: { kind?: string; status?: string } }> = [];
			const stopNotices = installWorkflowLifecycleNotifications({
				store,
				config: { enabled: true, notifyOn: ["blocked", "completed", "failed"] },
				sendMessage: (message) => {
					const details = message.details as { kind?: string; status?: string } | undefined;
					notices.push({ customType: message.customType, details });
					parent.appendCustomMessageEntry(
						message.customType ?? LIFECYCLE_NOTICE_CUSTOM_TYPE,
						message.content,
						message.display !== false,
						details,
					);
				},
			});
			const definition = createIssue3085Definition(dir);
			const runtimeOptions: ExtensionRuntimeOpts = {
				store,
				jobs: createJobTracker(),
				cwd: dir,
				registry: createRegistry([definition]),
				adapters: {
					agentSession: {
						create: async (options) => {
							const session = await createIssue3085StageSession({
								dir,
								model: options.model,
								fallbackModels: options.fallbackModels,
								recovered: false,
							});
							sessions.push(session);
							return session;
						},
					},
				},
			};
			const runtime = createExtensionRuntime(runtimeOptions);

			vi.useFakeTimers();
			let started: { action?: string; runId?: string } | undefined;
			const starting = runtime
				.dispatch({ action: "run", workflow: ISSUE_3085_WORKFLOW_NAME, inputs: {} })
				.then((result) => {
					started = result;
				});
			for (let i = 0; i < 100 && started === undefined; i++) await vi.advanceTimersByTimeAsync(1);
			assert.ok(started, "detached dispatch must acknowledge");
			await starting;
			const startedRun = started;
			assert.equal(startedRun.action, "run");
			assert.ok(startedRun.runId);

			for (
				let i = 0;
				i < 60 && effectiveRunStatus(store.runs().find((run) => run.id === startedRun.runId)!) !== "blocked";
				i++
			) {
				await realSleep(5);
				await vi.advanceTimersByTimeAsync(1000);
			}
			const source = store.runs().find((run) => run.id === startedRun.runId);
			assert.ok(source);
			assert.equal(effectiveRunStatus(source), "blocked", JSON.stringify(source));
			assert.equal(source.failureKind, "auth");
			assert.equal(source.failureCode, "auth_timeout");
			assert.equal(source.failureDisposition, "active_blocked");
			assert.equal(source.failureRecoverability, "recoverable");
			assert.equal(source.resumable, true);
			assert.equal(readPrefix(dir), 1);
			assert.equal(notices.filter((notice) => notice.details?.kind === "blocked").length, 1);

			await backend.flush(source.id);
			const persisted: Issue3085PersistedState = {
				runId: source.id,
				sdk: serializeMockSdkState(sdk),
			};
			writeFileSync(persistPath(dir), `${JSON.stringify(persisted)}\n`);
			assert.equal(readFileSync(prefixPath(dir), "utf8").trim(), "1");
			vi.useRealTimers();
			stopNotices();
			setDurableBackend(undefined);

			const child = spawnSyncCollect([process.execPath, "--import", "jiti/register", resumeFixture, "resume", dir], {
				cwd: repositoryRoot,
				timeout: RESUME_CHILD_TIMEOUT_MS,
				env: {
					...process.env,
					[ENV_WORKFLOW_ARTIFACT_DIR]: join(dir, "artifacts"),
					ATOMIC_CODING_AGENT_DIR: join(dir, "agent"),
					PI_CODING_AGENT_DIR: "",
				},
			});
			assert.equal(
				child.exitCode,
				0,
				`resume child failed:\n${child.stdout.toString()}\n${child.stderr.toString()}`,
			);
			const result = JSON.parse(readFileSync(resultPath(dir), "utf8")) as Issue3085ResumeResult;
			assert.equal(result.status, "completed");
			assert.equal(result.prefix, 1);
			assert.equal(result.resumable, true);
			assert.equal(readPrefix(dir), 1, "completed prefix must not execute twice");
		} finally {
			for (const session of sessions.splice(0).reverse()) await session.dispose();
			removeTempDirectory(dir);
		}
	},
	ISOLATED_PROCESS_RESTART_TIMEOUT_MS,
);
