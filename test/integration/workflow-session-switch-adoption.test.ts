import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../packages/coding-agent/src/core/agent-session-runtime.js";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.js";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { getDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import workflowExtension from "../../packages/workflows/src/extension/index.js";
import type { ExtensionAPI, WorkflowToolArgs } from "../../packages/workflows/src/extension/public-types.js";
import { fileExists } from "../helpers/runtime.js";
import { decisionModel, registeredDecisionRuntime } from "../helpers/structured-output.js";
import { MemoryJournalBackend as InMemoryDurableBackend } from "../helpers/workflow-journal.js";

/** Real resource loader, real SDK sessions, and a real `/new` or `/fork` transaction. */
const HOST_SWITCH_TIMEOUT_MS = 120_000;
const WAIT_FOR_MS = 20_000;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const GATED_WORKFLOW = (
	releasePath: string,
	reachedPath: string,
) => `import { existsSync, writeFileSync } from "node:fs";
import { workflow } from "@bastani/atomic/workflows";

export default workflow({
	name: "switch-adoption",
	description: "Checkpoint, then wait for a release file.",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("checkpointed", {}, async () => "checkpointed");
		await ctx.tool("wait-for-release", {}, ({ signal }) =>
			new Promise((resolve, reject) => {
				writeFileSync(${JSON.stringify(reachedPath)}, "reached");
				if (existsSync(${JSON.stringify(releasePath)})) return resolve({ released: true });
				const timer = setInterval(() => {
					if (!existsSync(${JSON.stringify(releasePath)})) return;
					clearInterval(timer);
					resolve({ released: true });
				}, 10);
				signal?.addEventListener("abort", () => {
					clearInterval(timer);
					reject(new Error("aborted"));
				}, { once: true });
			}),
		);
		return {};
	},
});
`;

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	await vi.waitFor(async () => assert.equal(await predicate(), true, `timed out waiting for ${label}`), {
		timeout: WAIT_FOR_MS,
	});
}

async function switchHost(
	extraFactories: readonly ExtensionFactory[] = [],
	options: { persistedSessions?: boolean } = {},
) {
	const originalCwd = process.cwd();
	const root = await mkdtemp(join(tmpdir(), "atomic-switch-adoption-"));
	const project = join(root, "project");
	const agentDir = join(root, "home/.atomic/agent");
	const releasePath = join(root, "release");
	const reachedPath = join(root, "reached");
	const definition = join(project, ".atomic/workflows/switch-adoption.ts");
	await mkdir(dirname(definition), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(definition, GATED_WORKFLOW(releasePath, reachedPath));
	process.chdir(project);
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("USERPROFILE", join(root, "home"));
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("TYPESAFE_API_KEY", "");
	setDurableBackend(new InMemoryDurableBackend());
	const { runtime: modelRuntime } = await registeredDecisionRuntime(() => {
		throw new Error("the switch-adoption workflow makes no model calls");
	});
	const settingsManager = SettingsManager.inMemory({
		routerModel: "decision-test/chat",
		compaction: { enabled: false },
		sessionSummary: { enabled: false },
	});
	cleanups.push(async () => {
		setDurableBackend(undefined);
		vi.unstubAllEnvs();
		process.chdir(originalCwd);
		await rm(root, { recursive: true, force: true });
	});

	const notices: string[] = [];
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
		const extensionFactory: ExtensionFactory = (pi) => workflowExtension(pi as unknown as ExtensionAPI);
		const resourceLoader = new DefaultResourceLoader({
			cwd: project,
			agentDir,
			settingsManager,
			builtinPackagePaths: [],
			noExtensions: true,
			extensionFactories: [extensionFactory, ...extraFactories],
		});
		await resourceLoader.reload();
		const result = await createAgentSession({
			cwd: project,
			agentDir,
			modelRuntime,
			model: decisionModel,
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			settingsManager,
			resourceLoader,
			sessionManager,
			sessionStartEvent,
		});
		const services = { cwd: project, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
		return { ...result, services, diagnostics: [] };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: project,
		agentDir,
		sessionManager: options.persistedSessions
			? SessionManager.create(project, join(root, "sessions"))
			: SessionManager.inMemory(project),
	});
	const uiContext = {
		...noOpUIContext,
		confirm: async () => true,
		notify: (message: string) => notices.push(message),
	};
	const commandContextActions = {
		waitForIdle: async () => {},
		newSession: (options?: Parameters<typeof runtime.newSession>[0]) => runtime.newSession(options),
		fork: (entryId: string, options?: Parameters<typeof runtime.fork>[1]) => runtime.fork(entryId, options),
		navigateTree: (targetId: string, options?: Parameters<typeof runtime.session.navigateTree>[1]) =>
			runtime.session.navigateTree(targetId, options),
		switchSession: (sessionPath: string, options?: Parameters<typeof runtime.switchSession>[1]) =>
			runtime.switchSession(sessionPath, options),
		reload: () => runtime.session.reload(),
	};
	runtime.setRebindSession((session) => session.bindExtensions({ uiContext, commandContextActions }));
	await runtime.session.bindExtensions({ uiContext, commandContextActions });
	cleanups.push(async () => {
		await Promise.allSettled([runtime.dispose()]);
	});
	const sibling = async () => {
		const created = await createRuntime({
			cwd: project,
			agentDir,
			sessionManager: SessionManager.inMemory(project),
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		await created.session.bindExtensions({ uiContext, commandContextActions });
		cleanups.push(async () => {
			await Promise.allSettled([created.session.dispose()]);
		});
		return created.session;
	};
	return {
		runtime,
		notices,
		sibling,
		release: () => writeFile(releasePath, "release"),
		reached: () => fileExists(reachedPath),
	};
}

type HostSession = Awaited<ReturnType<typeof switchHost>>["runtime"]["session"];

async function callWorkflowTool(session: HostSession, args: WorkflowToolArgs) {
	const tool = session.agent.state.tools.find((entry) => entry.name === "workflow");
	assert.ok(tool, "the workflow tool must be registered on the real host");
	return tool.execute("call", args, new AbortController().signal);
}

for (const reason of ["new", "fork"] as const) {
	test(
		`after /${reason} the successor session's model resumes the run the switch quit, and is told about it (#3569)`,
		async () => {
			const host = await switchHost();
			const { runtime } = host;
			const first = runtime.session;
			const firstId = first.sessionManager.getSessionId();
			const forkEntry = first.sessionManager.appendMessage({
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			});
			const launch = await callWorkflowTool(first, { action: "run", workflow: "switch-adoption", inputs: {} });
			const runId = (launch.details as { runId?: string }).runId;
			assert.ok(runId, JSON.stringify(launch));
			await waitFor(host.reached, "the gate tool node to start");
			assert.equal(getDurableBackend().getWorkflow(runId)?.modelOwner, firstId);

			const switched = reason === "new" ? await runtime.newSession() : await runtime.fork(forkEntry);
			assert.equal(switched.cancelled, false);
			const successor = runtime.session;
			assert.notEqual(successor, first);
			const successorId = successor.sessionManager.getSessionId();
			assert.notEqual(successorId, firstId);

			const released = getDurableBackend().getWorkflow(runId);
			assert.equal(released?.status, "paused", "the switch quits the run at its checkpoint");
			assert.equal(released?.modelOwner, firstId);
			assert.equal(released?.releasedModelOwner, firstId, "the switch releases the run for adoption");
			const notice = host.notices.find((message) => message.includes(`/workflow resume ${runId}`));
			assert.ok(notice, `the successor must announce the released run: ${JSON.stringify(host.notices)}`);

			const resumed = await callWorkflowTool(successor, { action: "resume", runId });
			assert.notEqual((resumed.details as { status?: string }).status, "noop", JSON.stringify(resumed));
			assert.equal(getDurableBackend().getWorkflow(runId)?.modelOwner, successorId, "adoption transfers ownership");
			await host.release();
			await waitFor(
				() => getDurableBackend().getWorkflow(runId)?.status === "completed",
				"the adopted run to finish",
			);
			assert.equal(getDurableBackend().getWorkflow(runId)?.releasedModelOwner, undefined);
		},
		HOST_SWITCH_TIMEOUT_MS,
	);
}

for (const reason of ["new", "fork"] as const) {
	test(
		`an extension command that awaits ctx.${reason === "new" ? "newSession" : "fork"}() lets the successor adopt the run inside withSession (#3569)`,
		async () => {
			const inWithSession: { notices?: string[]; resume?: { status?: string } | { refused: string } } = {};
			let currentRunId = "";
			let hostRef: Awaited<ReturnType<typeof switchHost>> | undefined;
			let forkEntryId = "";
			const replaceCommand: ExtensionFactory = (pi) => {
				pi.registerCommand("replace", {
					description: "replaces the session from inside its own command",
					handler: async (_args, ctx) => {
						const afterSwitch = async () => {
							const host = hostRef;
							assert.ok(host);
							inWithSession.notices = [...host.notices];
							try {
								const resumed = await callWorkflowTool(host.runtime.session, {
									action: "resume",
									runId: currentRunId,
								});
								inWithSession.resume = resumed.details as { status?: string };
							} catch (error) {
								inWithSession.resume = { refused: error instanceof Error ? error.message : String(error) };
							}
						};
						if (reason === "new") await ctx.newSession({ withSession: afterSwitch });
						else await ctx.fork(forkEntryId, { withSession: afterSwitch });
					},
				});
			};
			const host = await switchHost([replaceCommand]);
			hostRef = host;
			const { runtime } = host;
			const first = runtime.session;
			const firstId = first.sessionManager.getSessionId();
			forkEntryId = first.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
			const launch = await callWorkflowTool(first, { action: "run", workflow: "switch-adoption", inputs: {} });
			const runId = (launch.details as { runId?: string }).runId;
			assert.ok(runId, JSON.stringify(launch));
			currentRunId = runId;
			await waitFor(host.reached, "the gate tool node to start");

			await first.prompt("/replace");

			assert.notEqual(runtime.session, first);
			const successorId = runtime.session.sessionManager.getSessionId();
			assert.ok(
				inWithSession.notices?.some((message) => message.includes(`/workflow resume ${runId}`)),
				`withSession must already see the released-run notice: ${JSON.stringify(inWithSession.notices)}`,
			);
			assert.ok(
				inWithSession.resume !== undefined && !("refused" in inWithSession.resume),
				`the successor's model resumes inside withSession: ${JSON.stringify(inWithSession.resume)}`,
			);
			assert.equal(getDurableBackend().getWorkflow(runId)?.modelOwner, successorId);
			assert.notEqual(firstId, successorId);
			await host.release();
			await waitFor(
				() => getDurableBackend().getWorkflow(runId)?.status === "completed",
				"the adopted run to finish",
			);
		},
		HOST_SWITCH_TIMEOUT_MS,
	);
}

test(
	"switching twice before anyone adopts keeps the run released so the final successor can adopt it (#3569)",
	async () => {
		const host = await switchHost();
		const { runtime } = host;
		const first = runtime.session;
		const firstId = first.sessionManager.getSessionId();
		const launch = await callWorkflowTool(first, { action: "run", workflow: "switch-adoption", inputs: {} });
		const runId = (launch.details as { runId?: string }).runId;
		assert.ok(runId, JSON.stringify(launch));
		await waitFor(host.reached, "the gate tool node to start");

		await runtime.newSession();
		assert.equal(getDurableBackend().getWorkflow(runId)?.releasedModelOwner, firstId);
		await runtime.newSession();
		const afterSecondSwitch = getDurableBackend().getWorkflow(runId);
		assert.equal(afterSecondSwitch?.status, "paused");
		assert.equal(afterSecondSwitch?.modelOwner, firstId);
		assert.equal(afterSecondSwitch?.releasedModelOwner, firstId, "the second switch keeps the first release");
		const lastNotice = host.notices.filter((message) => message.includes(`/workflow resume ${runId}`)).length;
		assert.equal(lastNotice, 2, `each successor announces the released run: ${JSON.stringify(host.notices)}`);

		const successorId = runtime.session.sessionManager.getSessionId();
		const status = await callWorkflowTool(runtime.session, { action: "status", runId });
		assert.equal((status.details as { action?: string }).action, "statusDetail");
		const resumed = await callWorkflowTool(runtime.session, { action: "resume", runId });
		assert.notEqual((resumed.details as { status?: string }).status, "noop", JSON.stringify(resumed));
		assert.equal(getDurableBackend().getWorkflow(runId)?.modelOwner, successorId);
		await host.release();
		await waitFor(() => getDurableBackend().getWorkflow(runId)?.status === "completed", "the adopted run to finish");
	},
	HOST_SWITCH_TIMEOUT_MS,
);

test(
	"a command that awaits ctx.newSession() inside ctx.newSession() leaves the run released for the final successor (#3569)",
	async () => {
		let hostRef: Awaited<ReturnType<typeof switchHost>> | undefined;
		let currentRunId = "";
		const inner: { resume?: { status?: string } | { refused: string } } = {};
		const nestedCommand: ExtensionFactory = (pi) => {
			pi.registerCommand("nested-replace", {
				description: "replaces the session, then replaces it again from withSession",
				handler: async (_args, ctx) => {
					await ctx.newSession({
						withSession: async (replaced) => {
							await replaced.newSession({
								withSession: async () => {
									const host = hostRef;
									assert.ok(host);
									try {
										const resumed = await callWorkflowTool(host.runtime.session, {
											action: "resume",
											runId: currentRunId,
										});
										inner.resume = resumed.details as { status?: string };
									} catch (error) {
										inner.resume = { refused: error instanceof Error ? error.message : String(error) };
									}
								},
							});
						},
					});
				},
			});
		};
		const host = await switchHost([nestedCommand]);
		hostRef = host;
		const first = host.runtime.session;
		const launch = await callWorkflowTool(first, { action: "run", workflow: "switch-adoption", inputs: {} });
		const runId = (launch.details as { runId?: string }).runId;
		assert.ok(runId, JSON.stringify(launch));
		currentRunId = runId;
		await waitFor(host.reached, "the gate tool node to start");

		await first.prompt("/nested-replace");

		assert.ok(
			inner.resume !== undefined && !("refused" in inner.resume),
			`the final successor resumes inside the nested withSession: ${JSON.stringify(inner.resume)}`,
		);
		assert.equal(
			getDurableBackend().getWorkflow(runId)?.modelOwner,
			host.runtime.session.sessionManager.getSessionId(),
		);
		await host.release();
		await waitFor(() => getDurableBackend().getWorkflow(runId)?.status === "completed", "the adopted run to finish");
	},
	HOST_SWITCH_TIMEOUT_MS,
);

test(
	"returning to the owner with /resume reclaims its released run so a sibling session cannot adopt it (#3569)",
	async () => {
		const host = await switchHost([], { persistedSessions: true });
		const { runtime } = host;
		const first = runtime.session;
		first.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		first.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-responses",
			provider: "decision-test",
			model: "chat",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const firstId = first.sessionManager.getSessionId();
		const firstFile = first.sessionFile;
		assert.ok(firstFile);
		const launch = await callWorkflowTool(first, { action: "run", workflow: "switch-adoption", inputs: {} });
		const runId = (launch.details as { runId?: string }).runId;
		assert.ok(runId, JSON.stringify(launch));
		await waitFor(host.reached, "the gate tool node to start");

		await runtime.newSession();
		await runtime.switchSession(firstFile);
		assert.equal(runtime.session.sessionManager.getSessionId(), firstId);
		const noticesBefore = host.notices.length;

		const afterReturn = getDurableBackend().getWorkflow(runId);
		assert.equal(afterReturn?.modelOwner, firstId);
		assert.equal(afterReturn?.releasedModelOwner, undefined, "the owner reclaims its own released run");
		assert.equal(
			host.notices.slice(noticesBefore).some((message) => message.includes(`/workflow resume ${runId}`)),
			false,
		);

		const sibling = await host.sibling();
		await assert.rejects(
			callWorkflowTool(sibling, { action: "resume", runId }),
			/^WorkflowInstanceOwnershipError: Workflow instance belongs to another caller\/session\.$/,
		);
		assert.equal(getDurableBackend().getWorkflow(runId)?.modelOwner, firstId);
		const resumed = await callWorkflowTool(runtime.session, { action: "resume", runId });
		assert.notEqual((resumed.details as { status?: string }).status, "noop", JSON.stringify(resumed));
		await host.release();
		await waitFor(() => getDurableBackend().getWorkflow(runId)?.status === "completed", "the run to finish");
	},
	HOST_SWITCH_TIMEOUT_MS,
);
