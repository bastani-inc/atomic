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
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { getDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import workflowExtension from "../../packages/workflows/src/extension/index.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { fileExists } from "../helpers/runtime.js";
import { decisionModel, registeredDecisionRuntime } from "../helpers/structured-output.js";

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
import { workflow } from "@bastani/workflows";

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

async function switchHost(extraFactories: readonly ExtensionFactory[] = []) {
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
		sessionManager: SessionManager.inMemory(project),
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
	return {
		runtime,
		notices,
		release: () => writeFile(releasePath, "release"),
		reached: () => fileExists(reachedPath),
	};
}

type HostSession = Awaited<ReturnType<typeof switchHost>>["runtime"]["session"];

async function callWorkflowTool(session: HostSession, args: Record<string, unknown>) {
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
