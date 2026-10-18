import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	type QuestionnaireResult,
	type QuestionParams,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { fileExists, makeTempDirectory, readText, removePath, writeFileEnsuringDir } from "../helpers/runtime.js";
import { currentStoreBackend as getDurableBackend } from "../helpers/store-backend.js";

/** Two real SDK host sessions in one process, each loading the builtin workflows extension and real stage sessions. */
const IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS = 90_000;
const RUN_SETTLE_TIMEOUT_MS = 20_000;

/** Offline model whose first request blocks until the stage aborts it; see `holdingModelProviderSource`. */
const HOLDING_MODEL = "dispose-paused-fixture/fixture";
/** Offline model from the shared questionnaire fixture: `questionnaire <json>` prompts become `ask_user_question` calls. */
const QUESTIONNAIRE_MODEL = "host-questionnaire-fixture/fixture";
const READINESS_QUESTION = "Are you ready to move on to the next stage?";
const READY_ANSWER = "I'm ready to move on to the next workflow stage.";

type HumanInput = NonNullable<NonNullable<CreateAgentSessionOptions["extensionBindings"]>["humanInput"]>;

interface Project {
	readonly cwd: string;
	readonly effectFile: string;
	/** Written by the fixture model while its first, blocking request is in flight. */
	readonly modelRequestFile: string;
}

const projects: string[] = [];

type RejectedReload = "an extension factory that throws" | "a resource commit that throws";
const REJECTED_RELOADS: readonly RejectedReload[] = [
	"an extension factory that throws",
	"a resource commit that throws",
];

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cwd of projects.splice(0)) await removePath(cwd, { recursive: true, force: true });
});

/**
 * Real stage sessions need a real model. Its first request blocks until the stage aborts it, which holds a stage
 * mid-step deterministically; any later request (the resumed stage) completes immediately.
 */
function holdingModelProviderSource(files: { request: string; held: string }): string {
	return `import { existsSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
export default function (pi) {
  pi.registerProvider("dispose-paused-fixture", {
    api: "dispose-paused-fixture",
    apiKey: "fixture-only",
    baseUrl: "http://127.0.0.1:1/unused",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const output = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      if (!existsSync(${JSON.stringify(files.held)})) {
        writeFileSync(${JSON.stringify(files.held)}, "held");
        writeFileSync(${JSON.stringify(files.request)}, "in flight");
        const abort = () => {
          output.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: output });
          stream.end();
        };
        if (options?.signal?.aborted) queueMicrotask(abort);
        else options?.signal?.addEventListener("abort", abort, { once: true });
        return stream;
      }
      output.content = [{ type: "text", text: "Stage complete." }];
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
      });
      return stream;
    },
  });
}
`;
}

/**
 * Project-local workflow whose first step is a completed `ctx.tool` checkpoint (a run with no durable progress is
 * not resumable), followed by the scenario's own step.
 */
async function createProject(
	workflowName: string,
	step: (stageOptions: string) => string,
	moduleScope: (stageOptions: string) => string = () => "",
): Promise<Project> {
	const cwd = makeTempDirectory("atomic-disposed-session-paused-");
	projects.push(cwd);
	const project: Project = {
		cwd,
		effectFile: join(cwd, "completed-effect.txt"),
		modelRequestFile: join(cwd, "model-request.txt"),
	};
	await writeFileEnsuringDir(
		join(cwd, ".atomic", "extensions", "holding-model.ts"),
		holdingModelProviderSource({ request: project.modelRequestFile, held: join(cwd, "model-held.txt") }),
	);
	await writeFileEnsuringDir(
		join(cwd, ".atomic", "extensions", "questionnaire-model.ts"),
		await readText(fileURLToPath(new URL("./fixtures/sdk-host-questionnaire-provider.ts", import.meta.url))),
	);
	const stageOptions = JSON.stringify({
		sessionDir: join(cwd, "stage-sessions"),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		model: HOLDING_MODEL,
		cwd,
		agentDir: join(cwd, "agent"),
		tools: [],
	});
	await writeFileEnsuringDir(
		join(cwd, ".atomic", "workflows", `${workflowName}.ts`),
		`import { workflow } from "@bastani/atomic/workflows";
import { appendFile } from "node:fs/promises";
${moduleScope(stageOptions)}
export default workflow({ name: ${JSON.stringify(workflowName)}, description: "Run owned by a session that is disposed", inputs: {}, outputs: {}, run: async (ctx) => {
  await ctx.tool("completed-effect", {}, async () => { await appendFile(${JSON.stringify(project.effectFile)}, "effect\\n"); return "checkpointed"; });
  ${step(stageOptions)}
  return {};
} });
`,
	);
	return project;
}

function hostInput(handlers: Partial<HumanInput> = {}): HumanInput {
	return {
		input: async () => undefined,
		confirm: async () => false,
		select: async () => undefined,
		editor: async () => undefined,
		questionnaire: async () => ({ answers: [], cancelled: true }),
		...handlers,
	};
}

async function createHost(project: Project, humanInput?: HumanInput): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: project.cwd,
		agentDir: join(project.cwd, "agent"),
		sessionManager: SessionManager.inMemory(project.cwd),
		settingsManager: SettingsManager.inMemory(),
		builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
		...(humanInput === undefined ? {} : { extensionBindings: { humanInput } }),
	});
	return session;
}

function workflowTool(session: AgentSession) {
	const tool = session.agent.state.tools.find((entry) => entry.name === "workflow");
	assert.ok(tool, "the builtin workflow tool must be registered");
	return tool;
}

/** Launch through the model-facing `workflow` tool, which records the session as the run's owner. */
async function launchAsAgent(session: AgentSession, workflowName: string): Promise<string> {
	const launch = await workflowTool(session).execute(
		"launch",
		{ action: "run", workflow: workflowName, inputs: {} },
		new AbortController().signal,
	);
	const details = launch.details as { runId?: string; error?: string };
	assert.ok(details.runId && details.error === undefined, JSON.stringify(launch));
	return details.runId;
}

/** The stage's model request is in flight: the run is mid-step and its stage is waiting on the model. */
async function waitForStageModelRequest(project: Project): Promise<void> {
	await vi.waitFor(async () => assert.equal(await fileExists(project.modelRequestFile), true), {
		timeout: RUN_SETTLE_TIMEOUT_MS,
	});
}

/** The workflows extension swaps real stage sessions for an echo stub when it detects a test runner. */
function useRealStageSessions(): void {
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("NODE_TEST_CONTEXT", undefined);
}

/** Disposal must leave the run durably paused and released for another session, never failed. */
function assertPausedAndReleased(runId: string): void {
	const durable = getDurableBackend().getWorkflow(runId);
	assert.equal(durable?.status, "paused", "disposal must keep the run paused, not fail it");
	assert.equal(durable.resumable, true);
	assert.ok(durable.modelOwner, "the run keeps its owning session's identity");
	assert.equal(durable.releasedModelOwner, durable.modelOwner, "disposal must durably release the run");
}

/** A sibling session sees a paused, resumable run, adopts it under the same identity, and lets it finish. */
async function adoptAndComplete(successor: AgentSession, project: Project, runId: string): Promise<void> {
	const before = await successor.workflows.getRun(runId);
	assert.equal(before.status, "paused", "a released run must not read as failed before it is adopted");
	assert.equal(before.resumable, true);
	assert.equal(before.error, undefined);

	const outcome = await successor.workflows.resume(runId);
	assert.equal(outcome.runId, runId, "adoption must reuse the durable identity");
	await vi.waitFor(async () => assert.equal((await successor.workflows.getRun(runId)).status, "completed"), {
		timeout: RUN_SETTLE_TIMEOUT_MS,
	});
	assert.equal(await readText(project.effectFile), "effect\n", "completed effects must not run again");
	assert.equal(getDurableBackend().getWorkflow(runId)?.releasedModelOwner, undefined);
}

test(
	"disposing the owning session while a run's stage is mid-step keeps the run paused for a sibling session (#3742)",
	async () => {
		useRealStageSessions();
		const project = await createProject(
			"stage-mid-step",
			(stageOptions) => `await ctx.stage("step", ${stageOptions}).prompt("work");`,
		);
		const owner = await createHost(project);
		const successor = await createHost(project);
		try {
			const runId = await launchAsAgent(owner, "stage-mid-step");
			await waitForStageModelRequest(project);
			assert.equal((await owner.workflows.getRun(runId)).status, "running");

			await owner.dispose();

			assertPausedAndReleased(runId);
			await adoptAndComplete(successor, project, runId);
		} finally {
			await Promise.allSettled([owner.dispose(), successor.dispose()]);
		}
	},
	IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS,
);

test(
	"disposing the owning session while a run waits on workflow input keeps the run paused for a sibling session (#3742)",
	async () => {
		const project = await createProject("waiting-on-input", () => `await ctx.ui.input("What should happen next?");`);
		const asked = Promise.withResolvers<void>();
		const unanswered = Promise.withResolvers<string | undefined>();
		const owner = await createHost(
			project,
			hostInput({
				input: async () => {
					asked.resolve();
					return unanswered.promise;
				},
			}),
		);
		const successor = await createHost(project, hostInput({ input: async () => "answered by the successor" }));
		try {
			const runId = await launchAsAgent(owner, "waiting-on-input");
			await asked.promise;
			assert.equal((await owner.workflows.getRun(runId)).status, "running");

			await owner.dispose();

			assertPausedAndReleased(runId);
			await adoptAndComplete(successor, project, runId);
		} finally {
			unanswered.resolve(undefined);
			await Promise.allSettled([owner.dispose(), successor.dispose()]);
		}
	},
	IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS,
);

test(
	"disposing the owning session while a stage waits on a human answer keeps the run paused for a sibling session (#3742)",
	async () => {
		useRealStageSessions();
		const question: QuestionParams = {
			questions: [
				{
					question: "Which path should the stage take?",
					header: "Path",
					options: [
						{ label: "first", description: "first option" },
						{ label: "second", description: "second option" },
					],
				},
			],
		};
		const project = await createProject(
			"stage-question",
			(stageOptions) =>
				`await ctx.stage("asker", { ...${stageOptions}, model: ${JSON.stringify(QUESTIONNAIRE_MODEL)}, tools: ["ask_user_question"] }).prompt(${JSON.stringify(`questionnaire ${JSON.stringify(question)}`)});`,
		);
		const asked = Promise.withResolvers<void>();
		const unanswered = Promise.withResolvers<QuestionnaireResult>();
		const owner = await createHost(
			project,
			hostInput({
				questionnaire: async () => {
					asked.resolve();
					return unanswered.promise;
				},
			}),
		);
		const successor = await createHost(
			project,
			hostInput({
				questionnaire: async (questions): Promise<QuestionnaireResult> => {
					const asking = questions.questions[0]!;
					return {
						cancelled: false,
						answers: [
							{
								questionIndex: 0,
								question: asking.question,
								kind: "option",
								answer: asking.question === READINESS_QUESTION ? READY_ANSWER : asking.options[0]!.label,
							},
						],
					};
				},
			}),
		);
		try {
			const runId = await launchAsAgent(owner, "stage-question");
			await asked.promise;
			assert.equal((await owner.workflows.getRun(runId)).status, "running");

			await owner.dispose();

			assertPausedAndReleased(runId);
			await adoptAndComplete(successor, project, runId);
		} finally {
			unanswered.resolve({ cancelled: true, answers: [] });
			await Promise.allSettled([owner.dispose(), successor.dispose()]);
		}
	},
	IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS,
);

test(
	"disposing the owning session after the workflow tool quit a run with a stage mid-step keeps it paused for a sibling session (#3742)",
	async () => {
		useRealStageSessions();
		const project = await createProject(
			"stage-quit",
			(stageOptions) => `await ctx.stage("step", ${stageOptions}).prompt("work");`,
		);
		const owner = await createHost(project);
		const successor = await createHost(project);
		try {
			const runId = await launchAsAgent(owner, "stage-quit");
			await waitForStageModelRequest(project);

			const quit = await workflowTool(owner).execute(
				"quit",
				{ action: "quit", runId },
				new AbortController().signal,
			);
			assert.equal((quit.details as { status?: string }).status, "paused", JSON.stringify(quit));
			await vi.waitFor(() => assert.equal(getDurableBackend().getWorkflow(runId)?.status, "paused"), {
				timeout: RUN_SETTLE_TIMEOUT_MS,
			});
			const quitRun = await owner.workflows.getRun(runId);
			assert.equal(quitRun.status, "paused");
			assert.equal(quitRun.exitReason, "quit");

			await owner.dispose();

			assertPausedAndReleased(runId);
			await adoptAndComplete(successor, project, runId);
		} finally {
			await Promise.allSettled([owner.dispose(), successor.dispose()]);
		}
	},
	IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS,
);

test(
	"disposing the owning session while a nested child workflow's stage is mid-step keeps the parent run paused for a sibling session (#3742)",
	async () => {
		useRealStageSessions();
		const project = await createProject(
			"nested-stage",
			() => `await ctx.workflow(child);`,
			(stageOptions) =>
				`const child = workflow({ name: "nested-child", description: "child", inputs: {}, outputs: {}, run: async (ctx) => { await ctx.stage("step", ${stageOptions}).prompt("work"); return {}; } });`,
		);
		const owner = await createHost(project);
		const successor = await createHost(project);
		try {
			const runId = await launchAsAgent(owner, "nested-stage");
			await waitForStageModelRequest(project);
			await owner.dispose();
			assertPausedAndReleased(runId);
			await adoptAndComplete(successor, project, runId);
		} finally {
			await Promise.allSettled([owner.dispose(), successor.dispose()]);
		}
	},
	IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS,
);

test(
	"a SessionClosed error thrown while the owning session is alive fails the run instead of pausing it (#3742)",
	async () => {
		const project = await createProject(
			"live-owner-closed-error",
			() => `throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });`,
		);
		const owner = await createHost(project);
		try {
			const runId = await launchAsAgent(owner, "live-owner-closed-error");
			await vi.waitFor(async () => assert.equal((await owner.workflows.getRun(runId)).status, "failed"), {
				timeout: RUN_SETTLE_TIMEOUT_MS,
			});
			const failed = await owner.workflows.getRun(runId);
			assert.notEqual(failed.exitReason, "quit");
			assert.ok(failed.error?.includes("Session is closed"), `the original error must be kept: ${failed.error}`);

			await owner.dispose();

			const durable = getDurableBackend().getWorkflow(runId);
			assert.equal(durable?.status, "failed", "disposal must not rewrite a run that already failed");
			assert.equal(durable.releasedModelOwner, undefined);
		} finally {
			await owner.dispose();
		}
	},
	IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS,
);

/** The host rejects the reload candidate, so the owner keeps its extension generation and its run state. */
async function rejectReload(owner: AgentSession, project: Project, rejection: RejectedReload): Promise<void> {
	if (rejection === "an extension factory that throws") {
		const candidate = join(project.cwd, ".atomic", "extensions", "rejected-candidate.ts");
		await writeFileEnsuringDir(
			candidate,
			`export default function () { throw new Error("candidate factory rejected"); }\n`,
		);
		try {
			await assert.rejects(
				owner.reload({ reason: "startup", failOnExtensionErrors: true }),
				/Failed to load extensions[\s\S]*candidate factory rejected/,
			);
		} finally {
			await removePath(candidate, { force: true });
		}
		return;
	}
	const prepareReload = DefaultResourceLoader.prototype.prepareReload;
	const reload = vi.spyOn(DefaultResourceLoader.prototype, "prepareReload").mockImplementation(async function (
		this: DefaultResourceLoader,
		...args
	) {
		const transaction = await prepareReload.apply(this, args);
		return {
			...transaction,
			prepareCommit: () => {
				throw new Error("candidate resources rejected");
			},
		};
	});
	try {
		await assert.rejects(
			owner.reload({ reason: "startup", failOnExtensionErrors: true }),
			/candidate resources rejected/,
		);
	} finally {
		reload.mockRestore();
	}
}

for (const rejection of REJECTED_RELOADS) {
	test(
		`a SessionClosed error thrown by a live owner after a rejected reload with ${rejection} fails the run instead of pausing it (#3742)`,
		async () => {
			const project = await createProject(
				"live-owner-after-rejected-reload",
				() => `throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });`,
			);
			const owner = await createHost(project);
			try {
				await rejectReload(owner, project, rejection);
				const runId = await launchAsAgent(owner, "live-owner-after-rejected-reload");
				await vi.waitFor(async () => assert.notEqual((await owner.workflows.getRun(runId)).status, "running"), {
					timeout: RUN_SETTLE_TIMEOUT_MS,
				});

				const settled = await owner.workflows.getRun(runId);
				assert.equal(
					settled.status,
					"failed",
					`a rejected reload must not make the live owner look closed: ${settled.status}`,
				);
				assert.notEqual(settled.exitReason, "quit");
				assert.ok(
					settled.error?.includes("Session is closed"),
					`the original error must be kept: ${settled.error}`,
				);
				const durable = getDurableBackend().getWorkflow(runId);
				assert.equal(durable?.status, "failed");
				assert.equal(durable.releasedModelOwner, undefined);
			} finally {
				await owner.dispose();
			}
		},
		IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS,
	);

	test(
		`disposing the owning session after a rejected reload with ${rejection} still keeps a mid-step run paused for a sibling session (#3742)`,
		async () => {
			useRealStageSessions();
			const project = await createProject(
				"stage-after-rejected-reload",
				(stageOptions) => `await ctx.stage("step", ${stageOptions}).prompt("work");`,
			);
			const owner = await createHost(project);
			const successor = await createHost(project);
			try {
				await rejectReload(owner, project, rejection);
				const runId = await launchAsAgent(owner, "stage-after-rejected-reload");
				await waitForStageModelRequest(project);
				assert.equal((await owner.workflows.getRun(runId)).status, "running");

				await owner.dispose();

				assertPausedAndReleased(runId);
				await adoptAndComplete(successor, project, runId);
			} finally {
				await Promise.allSettled([owner.dispose(), successor.dispose()]);
			}
		},
		IN_PROCESS_SDK_SESSIONS_TIMEOUT_MS,
	);
}
