import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";

const roots: string[] = [];
const ASYNC_JOB_WAIT_TIMEOUT_MS = 10_000,
	ASYNC_JOB_POLL_INTERVAL_MS = 5;
const model = getModel("anthropic", "claude-sonnet-4-5")!;
const switchedModel = getModel("openai", "gpt-4o")!;

function makeRoot(): { root: string; cwd: string; agentDir: string } {
	const root = join(tmpdir(), `atomic-bash-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const cwd = join(root, "project"),
		agentDir = join(root, "custom-agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	roots.push(root);
	return { root, cwd, agentDir };
}

function text(result: Awaited<ReturnType<ReturnType<typeof createBashTool>["execute"]>>): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("");
}

const printSessionEnvironment =
	'printf \'%s\\n\' "$ATOMIC_SESSION_ID" "$PI_SESSION_ID" "$ATOMIC_SESSION_FILE" "$PI_SESSION_FILE" "$ATOMIC_PROVIDER" "$PI_PROVIDER" "$ATOMIC_MODEL" "$PI_MODEL" "$ATOMIC_REASONING_LEVEL" "$PI_REASONING_LEVEL"';

async function createSession(options: { persisted?: boolean; stage?: string } = {}) {
	const { cwd, agentDir } = makeRoot();
	const sessionManager =
		options.persisted === false
			? SessionManager.inMemory(cwd)
			: SessionManager.create(cwd, join(agentDir, "sessions"));
	const orchestrationContext = options.stage
		? {
				kind: "workflow-stage" as const,
				workflowRunId: "run-metadata",
				workflowStageId: options.stage,
				workflowStageName: options.stage,
				constraints: { disableWorkflowTool: true as const, maxSubagentDepth: 2 },
			}
		: undefined;
	const result = await createAgentSession({
		cwd,
		agentDir,
		model,
		thinkingLevel: "high",
		sessionManager,
		orchestrationContext,
	});
	return { ...result, cwd, agentDir };
}

afterEach(() => {
	// Windows locks a directory while a spawned shell still has it as its cwd, so a
	// detached async job can outlive its test and make cleanup fail with EBUSY.
	// Retry, then give up: reclaiming an OS temp dir is never the assertion.
	for (const root of roots.splice(0)) {
		if (!existsSync(root)) continue;
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		} catch {
			// Left for the OS to reclaim.
		}
	}
});

describe("session-aware bash environment", () => {
	it("exposes equal Atomic and PI aliases from the current persisted session", async () => {
		const { session } = await createSession();
		const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		const lines = text(await bash.execute("metadata", { command: printSessionEnvironment }))
			.trim()
			.split("\n");
		expect(lines).toEqual([
			session.sessionId,
			session.sessionId,
			session.sessionFile,
			session.sessionFile,
			model.provider,
			model.provider,
			model.id,
			model.id,
			"high",
			"high",
		]);
		session.setThinkingLevel("low");
		const refreshed = text(await bash.execute("metadata-2", { command: printSessionEnvironment }))
			.trim()
			.split("\n");
		expect(refreshed.slice(-2)).toEqual(["low", "low"]);
		session.dispose();
	});

	it("clears inherited session metadata for unsaved sessions instead of leaking stale values", async () => {
		const stale = ["ATOMIC_SESSION_FILE", "PI_SESSION_FILE", "ATOMIC_PROVIDER", "PI_PROVIDER"] as const;
		const previous = Object.fromEntries(stale.map((key) => [key, process.env[key]]));
		for (const key of stale) process.env[key] = "stale-other-session";
		try {
			const { session } = await createSession({ persisted: false });
			const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
			const shellExpansionStart = "${";
			const command = `printf '%s\\n' "${shellExpansionStart}ATOMIC_SESSION_FILE-unset}" "${shellExpansionStart}PI_SESSION_FILE-unset}" "$ATOMIC_PROVIDER" "$PI_PROVIDER"`;
			const lines = text(await bash.execute("unsaved", { command }))
				.trim()
				.split("\n");
			expect(lines).toEqual(["unset", "unset", model.provider, model.provider]);
			session.dispose();
		} finally {
			for (const key of stale) {
				const value = previous[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("uses the resumed session's own ID and file", async () => {
		const { cwd, agentDir } = makeRoot();
		const created = SessionManager.create(cwd, join(agentDir, "sessions"), { id: "resume-owned-id" });
		const sessionFile = created.getSessionFile();
		if (!sessionFile) throw new Error("persisted session fixture did not create a file");
		const resumed = SessionManager.open(sessionFile, join(agentDir, "sessions"));
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			thinkingLevel: "medium",
			sessionManager: resumed,
		});
		const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		const lines = text(await bash.execute("resumed", { command: printSessionEnvironment }))
			.trim()
			.split("\n");
		expect(lines.slice(0, 4)).toEqual([session.sessionId, session.sessionId, sessionFile, sessionFile]);
		session.dispose();
	});

	it("resolves factory tool metadata at execution time and keeps unrelated caller env", async () => {
		const { cwd, agentDir } = makeRoot();
		const captures: NodeJS.ProcessEnv[] = [];
		const hookCaptures: NodeJS.ProcessEnv[] = [];
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				captures.push({ ...options.env });
				return { exitCode: 0 };
			},
		};
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) =>
					pi.registerTool(
						Object.assign(
							createBashTool(cwd, {
								operations,
								spawnHook: (context) => {
									hookCaptures.push({ ...context.env });
									return context;
								},
							}),
							{ name: "factory_bash", label: "factory bash" },
						),
					),
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			thinkingLevel: "high",
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const bash = session.agent.state.tools.find((tool) => tool.name === "factory_bash")!;
		await bash.execute("factory-1", {
			command: "ignored",
			env: { KEEP_VERBATIM: "  raw value  ", PI_MODEL: "stale" },
		});
		session.setThinkingLevel("minimal");
		session.agent.state.model = switchedModel;
		await bash.execute("factory-2", { command: "ignored" });
		expect(captures[0]).toMatchObject({
			KEEP_VERBATIM: "  raw value  ",
			ATOMIC_SESSION_ID: session.sessionId,
			PI_SESSION_ID: session.sessionId,
			ATOMIC_MODEL: model.id,
			PI_MODEL: model.id,
			ATOMIC_REASONING_LEVEL: "high",
			PI_REASONING_LEVEL: "high",
		});
		expect(captures[1]).toMatchObject({
			ATOMIC_PROVIDER: switchedModel.provider,
			PI_PROVIDER: switchedModel.provider,
			ATOMIC_MODEL: switchedModel.id,
			PI_MODEL: switchedModel.id,
			ATOMIC_REASONING_LEVEL: "minimal",
			PI_REASONING_LEVEL: "minimal",
		});
		expect(hookCaptures[0]).toMatchObject({ ATOMIC_SESSION_ID: session.sessionId, PI_SESSION_ID: session.sessionId });
		session.dispose();
	});

	it("propagates the same snapshot into detached async jobs", async () => {
		const { session, cwd } = await createSession({ persisted: false });
		const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		const outputName = "async-session-env.txt";
		const outputPath = join(cwd, outputName);
		const releaseName = ".async-session-env.release";
		const releasePath = join(cwd, releaseName);
		try {
			const started = await bash.execute("async-metadata", {
				command: `{ while [ ! -f '${releaseName}' ]; do sleep 0.01; done; printf '%s:%s' "$ATOMIC_SESSION_ID" "$PI_SESSION_ID"; } > '${outputName}'`,
				async: true,
			});
			const jobId = started.details?.async?.jobId;
			if (!jobId) throw new Error("Detached bash command did not return a job ID");
			try {
				const creationDeadline = Date.now() + ASYNC_JOB_WAIT_TIMEOUT_MS;
				while (!existsSync(outputPath)) {
					if (Date.now() >= creationDeadline) {
						throw new Error(
							`Timed out after ${ASYNC_JOB_WAIT_TIMEOUT_MS}ms waiting for async job ${jobId} to create ${outputPath}`,
						);
					}
					await new Promise((resolve) => setTimeout(resolve, ASYNC_JOB_POLL_INTERVAL_MS));
				}
				expect(readFileSync(outputPath, "utf8")).toBe("");
			} finally {
				writeFileSync(releasePath, "");
			}

			const completionDeadline = Date.now() + ASYNC_JOB_WAIT_TIMEOUT_MS;
			while (true) {
				const polled = await bash.execute("async-metadata-poll", {
					command: `__atomic_bash_job ${jobId}`,
				});
				const observedState = polled.details?.async?.state;
				const observedOutput = text(polled);
				if (observedState === "completed") break;
				if (observedState === "failed") {
					throw new Error(`Async bash job ${jobId} failed: ${observedOutput}`);
				}
				if (Date.now() >= completionDeadline) {
					throw new Error(
						`Timed out after ${ASYNC_JOB_WAIT_TIMEOUT_MS}ms waiting for async job ${jobId} to complete; observed state: ${String(observedState)}; observed output: ${JSON.stringify(observedOutput)}`,
					);
				}
				await new Promise((resolve) => setTimeout(resolve, ASYNC_JOB_POLL_INTERVAL_MS));
			}
			expect(readFileSync(outputPath, "utf8")).toBe(`${session.sessionId}:${session.sessionId}`);
		} finally {
			session.dispose();
		}
	});

	it("rejects retained tools after their session closes instead of using stale metadata", async () => {
		const { session } = await createSession({ persisted: false });
		const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		session.dispose();
		await expect(bash.execute("closed", { command: "printf stale" })).rejects.toThrow();
	});

	it("keeps concurrent main and workflow-stage snapshots isolated", async () => {
		const main = await createSession({ persisted: false });
		const stage = await createSession({ persisted: false, stage: "stage-one" });
		const mainBash = main.session.agent.state.tools.find((tool) => tool.name === "bash")!;
		const stageBash = stage.session.agent.state.tools.find((tool) => tool.name === "bash")!;
		const command = 'printf \'%s:%s\\n\' "$ATOMIC_SESSION_ID" "$PI_SESSION_ID"';
		const [mainResult, stageResult] = await Promise.all([
			mainBash.execute("main", { command }),
			stageBash.execute("stage", { command }),
		]);
		expect(text(mainResult).trim()).toBe(`${main.session.sessionId}:${main.session.sessionId}`);
		expect(text(stageResult).trim()).toBe(`${stage.session.sessionId}:${stage.session.sessionId}`);
		expect(stage.session.sessionId).not.toBe(main.session.sessionId);
		main.session.dispose();
		stage.session.dispose();
	});
});
