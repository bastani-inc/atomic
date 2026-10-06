/**
 * A workflow run that survives a preserving host `/reload` must still create
 * stages afterwards. Issue #3201: the launch generation's `pi` and command ctx
 * go stale, so stage creation and the model catalog have to resolve the live
 * generation instead — but only within the launch host session.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@bastani/pi-ai";
import { test, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../packages/coding-agent/src/core/agent-session-runtime.js";
import {
	bindExtensionContextPublication,
	publishExtensionContextEffect,
	registerExtensionContextRetirementEffect,
} from "../../packages/coding-agent/src/core/extensions/runner-context.js";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.js";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import workflowExtension from "../../packages/workflows/src/extension/index.js";
import { trackLiveHostGeneration } from "../../packages/workflows/src/extension/live-host-generation.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { currentWorkflowStore } from "../../packages/workflows/src/shared/store-factory.js";
import {
	decisionMessage,
	decisionModel,
	messageStream,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";

/** Real resource loader, real SDK session, and a real `/reload` or `/new` transaction. */
const HOST_RELOAD_STAGE_TIMEOUT_MS = 120_000;
const WAIT_FOR_MS = 20_000;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + WAIT_FOR_MS;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(predicate(), true, `timed out waiting for ${label}`);
}

function gatedStageWorkflowSource(releasePath: string): string {
	return `import { existsSync } from "node:fs";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
	name: "stale-ctx-repro",
	description: "Wait in a tool node, then create one model stage.",
	inputs: {},
	outputs: { reply: Type.String() },
	run: async (ctx) => {
		await ctx.tool("wait-for-release", {}, ({ signal }) =>
			new Promise((resolve, reject) => {
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
		const reply = await ctx
			.stage("after-reload", { model: "decision-test/chat" })
			.prompt("Reply with exactly the word OK and nothing else.");
		return { reply: String(reply) };
	},
});
`;
}

function finalReply(): AssistantMessage {
	return { ...decisionMessage(), content: [{ type: "text", text: "OK" }], stopReason: "stop" };
}

type HostExtensionAPI = Parameters<ExtensionFactory>[0];

async function gatedWorkflowHost(prefix: string) {
	const cwd = process.cwd();
	const root = await mkdtemp(join(tmpdir(), prefix));
	const project = join(root, "project");
	const agentDir = join(root, "home/.atomic/agent");
	const releasePath = join(root, "release");
	const definition = join(project, ".atomic/workflows/stale-ctx-repro.ts");
	await mkdir(dirname(definition), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(definition, gatedStageWorkflowSource(releasePath));
	process.chdir(project);
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("USERPROFILE", join(root, "home"));
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("TYPESAFE_API_KEY", "");
	setDurableBackend(new InMemoryDurableBackend());
	const { runtime: modelRuntime } = await registeredDecisionRuntime((_model, context) =>
		messageStream(context.messages.at(-1)?.role === "toolResult" ? finalReply() : decisionMessage({ ok: true })),
	);
	const settingsManager = SettingsManager.inMemory({
		routerModel: "decision-test/chat",
		compaction: { enabled: false },
		sessionSummary: { enabled: false },
	});
	return {
		project,
		agentDir,
		modelRuntime,
		settingsManager,
		release: () => writeFile(releasePath, "release"),
		async createSession(
			options: Pick<CreateAgentSessionOptions, "sessionManager" | "sessionStartEvent">,
			extensionFactory: (pi: HostExtensionAPI) => void = (pi) => workflowExtension(pi as unknown as ExtensionAPI),
		) {
			const resourceLoader = new DefaultResourceLoader({
				cwd: project,
				agentDir,
				settingsManager,
				builtinPackagePaths: [],
				noExtensions: true,
				extensionFactories: [extensionFactory],
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
				...options,
			});
			return { ...result, resourceLoader };
		},
		async cleanup() {
			setDurableBackend(undefined);
			vi.unstubAllEnvs();
			process.chdir(cwd);
			await rm(root, { recursive: true, force: true });
		},
	};
}

for (const reason of ["reload", "startup"] as const) {
	test(
		`a stage created after a preserving host ${reason} reload uses the live generation (${reason === "startup" ? "#3468" : "#3201"})`,
		async () => {
			const host = await gatedWorkflowHost("atomic-stage-after-reload-");
			const retired: string[] = [];
			const observerCalls: { count: number }[] = [];
			const { session } = await host.createSession(
				{ sessionManager: SessionManager.inMemory(host.project) },
				(pi) => {
					let disposeObserver: (() => void) | undefined;
					const calls = { count: 0 };
					pi.on("session_start", () => {
						observerCalls.push(calls);
						disposeObserver = currentWorkflowStore().subscribeInvalidation(() => {
							calls.count += 1;
							pi.events.emit("workflow:test-observer", {});
						});
					});
					pi.on("session_shutdown", (event) => {
						retired.push(event.reason);
						disposeObserver?.();
					});
					workflowExtension(pi as unknown as ExtensionAPI);
				},
			);
			const store = currentWorkflowStore();
			const findRun = () => store.runs().find((run) => run.name === "stale-ctx-repro");
			try {
				await session.bindExtensions({});
				const launchRunner = session.extensionRunner;
				const command = launchRunner.getCommand("workflow");
				assert.ok(command, "the /workflow command must be registered on the real host");
				await command.handler("stale-ctx-repro --no-picker", launchRunner.createCommandContext());
				await waitFor(
					() =>
						findRun()?.toolNodes?.some(
							(node) => node.name === "wait-for-release" && node.status === "running",
						) === true,
					"the gate tool node to start",
				);

				await session.reload({ reason, failOnExtensionErrors: true });
				assert.notEqual(session.extensionRunner, launchRunner, "the SDK transaction replaced the runner");
				assert.equal(findRun()?.status, "running", "a preserving reload keeps the run in flight");
				const retiredObserverCalls = observerCalls[0].count;

				await host.release();
				await waitFor(() => findRun()?.endedAt !== undefined, "the run to settle after the reload");
				const run = findRun();
				assert.ok(run);
				const stage = run.stages.find((candidate) => candidate.name === "after-reload");
				assert.equal(
					run.status,
					"completed",
					`run error=${run.error ?? ""}; stage status=${stage?.status ?? "missing"}; stage error=${stage?.error ?? ""}`,
				);
				assert.equal(stage?.status, "completed");
				assert.equal(
					observerCalls[0].count,
					retiredObserverCalls,
					"the retired host receives no new store invalidations",
				);
				assert.deepEqual(retired, ["reload"], "a committed preserving replacement retires its store observers");
				assert.doesNotMatch(run.error ?? "", /extension ctx is stale/);
				assert.deepEqual(
					(stage?.warnings ?? []).filter((warning) => /model catalog unavailable/.test(warning)),
					[],
					"the stage model catalog must read the live registry, not the stale launch ctx",
				);
				assert.equal(stage?.model, "decision-test/chat");
			} finally {
				if (findRun()?.endedAt === undefined) await host.release().catch(() => {});
				await waitFor(() => findRun()?.endedAt !== undefined, "the run to settle before disposal").catch(() => {});
				await session.dispose();
				await host.cleanup();
			}
		},
		HOST_RELOAD_STAGE_TIMEOUT_MS,
	);
}

test.each(["before", "after"] as const)(
	"a stage released during committed startup retirement uses the successor with cleanup registered %s workflows (#3468)",
	async (order) => {
		const host = await gatedWorkflowHost("atomic-stage-startup-retiring-");
		let launchPi: HostExtensionAPI | undefined;
		let retiring = false;
		let observerCalls = 0;
		let launchRunner: typeof session.extensionRunner | undefined;
		let finishRetirement!: () => void;
		const handoffOrder: string[] = [];
		let defaultStartPublished = false;
		let nestedDefaultStartPublished = false;
		let nestedCommitPublished = false;
		const retirementGate = new Promise<void>((resolve) => {
			finishRetirement = resolve;
		});
		const { session } = await host.createSession({ sessionManager: SessionManager.inMemory(host.project) }, (pi) => {
			pi.on("session_start", (_event, ctx) => {
				if (launchPi) {
					void publishExtensionContextEffect(
						ctx,
						() => {
							handoffOrder.push("commit");
							queueMicrotask(() => handoffOrder.push("microtask"));
							void publishExtensionContextEffect(ctx, () => {
								nestedDefaultStartPublished = true;
							});
							void publishExtensionContextEffect(
								ctx,
								() => {
									nestedCommitPublished = true;
								},
								"commit",
							);
						},
						"commit",
					);
					void publishExtensionContextEffect(ctx, () => {
						defaultStartPublished = true;
					});
					return;
				}
				const dispose = currentWorkflowStore().subscribeInvalidation(() => {
					observerCalls += 1;
					pi.events.emit("workflow:test-retirement-observer", {});
				});
				registerExtensionContextRetirementEffect(ctx, () => {
					dispose();
					handoffOrder.push("retire");
				});
			});
			if (order === "after") workflowExtension(pi as unknown as ExtensionAPI);
			pi.on("session_start", () => {
				launchPi ??= pi;
			});
			pi.on("session_shutdown", async (event) => {
				if (pi !== launchPi || event.reason !== "reload") return;
				retiring = true;
				await retirementGate;
			});
			if (order === "before") workflowExtension(pi as unknown as ExtensionAPI);
		});
		const store = currentWorkflowStore();
		const findRun = () => store.runs().find((run) => run.name === "stale-ctx-repro");
		let reload: Promise<void> | undefined;
		try {
			await session.bindExtensions({});
			launchRunner = session.extensionRunner;
			const command = session.extensionRunner.getCommand("workflow");
			assert.ok(command);
			await command.handler("stale-ctx-repro --no-picker", session.extensionRunner.createCommandContext());
			await waitFor(
				() =>
					findRun()?.toolNodes?.some((node) => node.name === "wait-for-release" && node.status === "running") ===
					true,
				"the gate tool node to start",
			);
			reload = session.reload({ reason: "startup", failOnExtensionErrors: true });
			await waitFor(() => retiring, "committed predecessor cleanup to block");
			const retiredObserverCalls = observerCalls;
			assert.throws(() => launchRunner?.createContext().ui, /extension ctx is stale/);
			assert.deepEqual(
				handoffOrder,
				["commit", "retire", "microtask"],
				"handoff and observation disposal do not yield",
			);
			assert.equal(defaultStartPublished, false, "default startup effects wait for retirement");
			assert.equal(nestedCommitPublished, true, "nested commit effects publish synchronously before retirement");
			assert.equal(
				nestedDefaultStartPublished,
				false,
				"default effects registered at commit also wait for retirement",
			);
			await host.release();
			await waitFor(() => findRun()?.endedAt !== undefined, "the stage to settle while retirement is blocked");
			assert.equal(findRun()?.status, "completed", findRun()?.error);
			assert.equal(findRun()?.stages.find((stage) => stage.name === "after-reload")?.status, "completed");
			assert.equal(
				observerCalls,
				retiredObserverCalls,
				"old guarded Store observers retire before blocked shutdown",
			);
			finishRetirement();
			await reload;
			assert.equal(defaultStartPublished, true);
			assert.equal(nestedDefaultStartPublished, true);
		} finally {
			finishRetirement();
			await reload;
			await host.release();
			await session.dispose();
			await host.cleanup();
		}
	},
	HOST_RELOAD_STAGE_TIMEOUT_MS,
);

test(
	"a rejected startup reload preserves the committed host generation and its in-flight stage (#3468)",
	async () => {
		const host = await gatedWorkflowHost("atomic-stage-startup-rollback-");
		let resolveLaunch: ReturnType<typeof trackLiveHostGeneration> | undefined;
		let launchPi: HostExtensionAPI | undefined;
		const launchRetirements: string[] = [];
		const { session } = await host.createSession({ sessionManager: SessionManager.inMemory(host.project) }, (pi) => {
			pi.on("session_shutdown", (event) => {
				if (pi === launchPi) launchRetirements.push(event.reason);
			});
			const resolve = trackLiveHostGeneration(pi as unknown as ExtensionAPI);
			pi.on("session_start", () => {
				resolveLaunch ??= resolve;
				launchPi ??= pi;
			});
			workflowExtension(pi as unknown as ExtensionAPI);
		});
		const store = currentWorkflowStore();
		const findRun = () => store.runs().find((run) => run.name === "stale-ctx-repro");
		const prepareReload = DefaultResourceLoader.prototype.prepareReload;
		let beforeCommit: ReturnType<NonNullable<typeof resolveLaunch>>;
		const rejection = new Error("startup resources rejected after session_start");
		const reload = vi.spyOn(DefaultResourceLoader.prototype, "prepareReload").mockImplementation(async function (
			this: DefaultResourceLoader,
			...args
		) {
			const transaction = await prepareReload.apply(this, args);
			return {
				...transaction,
				prepareCommit: () => {
					beforeCommit = resolveLaunch?.();
					throw rejection;
				},
			};
		});
		try {
			await session.bindExtensions({});
			const launchGeneration = resolveLaunch?.();
			assert.ok(launchGeneration);
			const launchRunner = session.extensionRunner;
			const command = launchRunner.getCommand("workflow");
			assert.ok(command);
			await command.handler("stale-ctx-repro --no-picker", launchRunner.createCommandContext());
			await waitFor(
				() =>
					findRun()?.toolNodes?.some((node) => node.name === "wait-for-release" && node.status === "running") ===
					true,
				"the gate tool node to start",
			);
			await assert.rejects(session.reload({ reason: "startup", failOnExtensionErrors: true }), rejection);
			assert.equal(beforeCommit === launchGeneration, true, "the uncommitted startup candidate is never published");
			assert.equal(resolveLaunch?.() === launchGeneration, true, "rollback retains the committed predecessor");
			assert.equal(session.extensionRunner, launchRunner);
			assert.deepEqual(launchRetirements, [], "rollback does not retire the committed predecessor");
			reload.mockRestore();
			await host.release();
			await waitFor(() => findRun()?.endedAt !== undefined, "the run to settle after rollback");
			assert.equal(findRun()?.status, "completed", findRun()?.error);
			assert.equal(findRun()?.stages.find((stage) => stage.name === "after-reload")?.status, "completed");
		} finally {
			reload.mockRestore();
			if (findRun()?.endedAt === undefined) await host.release().catch(() => {});
			await waitFor(() => findRun()?.endedAt !== undefined, "the run to settle before disposal").catch(() => {});
			await session.dispose();
			await host.cleanup();
		}
	},
	HOST_RELOAD_STAGE_TIMEOUT_MS,
);

test(
	"a run launched before /new is quit at a checkpoint and never creates stages through the replacement session (#3201, #3203)",
	async () => {
		const host = await gatedWorkflowHost("atomic-stage-after-new-");
		const started: { readonly reason: string; readonly lifecycleScope: object | undefined }[] = [];
		const stageSurfaces: string[] = [];
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
			const { resourceLoader, ...result } = await host.createSession({ sessionManager, sessionStartEvent }, (pi) => {
				let startReason = "unstarted";
				pi.on("session_start", (event) => {
					startReason = event.reason;
					started.push({ reason: event.reason, lifecycleScope: pi.lifecycleScope });
				});
				const inheritChildSessionOptions = pi.getChildSessionOptions;
				pi.getChildSessionOptions = (options) => {
					stageSurfaces.push(startReason);
					return inheritChildSessionOptions?.(options) ?? options;
				};
				workflowExtension(pi as unknown as ExtensionAPI);
			});
			const services = {
				cwd: host.project,
				agentDir: host.agentDir,
				modelRuntime: host.modelRuntime,
				settingsManager: host.settingsManager,
				resourceLoader,
				diagnostics: [],
			};
			return { ...result, services, diagnostics: [] };
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: host.project,
			agentDir: host.agentDir,
			sessionManager: SessionManager.inMemory(host.project),
		});
		const uiContext = { ...noOpUIContext, confirm: async () => true };
		runtime.setRebindSession((session) => session.bindExtensions({ uiContext }));
		const store = currentWorkflowStore();
		const findRun = () => store.runs().find((run) => run.name === "stale-ctx-repro");
		try {
			await runtime.session.bindExtensions({ uiContext });
			const launchRunner = runtime.session.extensionRunner;
			const command = launchRunner.getCommand("workflow");
			assert.ok(command, "the /workflow command must be registered on the real host");
			await command.handler("stale-ctx-repro --no-picker", launchRunner.createCommandContext());
			await waitFor(
				() =>
					findRun()?.toolNodes?.some((node) => node.name === "wait-for-release" && node.status === "running") ===
					true,
				"the gate tool node to start",
			);

			assert.deepEqual(await runtime.newSession(), { cancelled: false });
			assert.deepEqual(
				started.map(({ reason }) => reason),
				["startup", "new"],
			);
			assert.equal(started[1]?.lifecycleScope, started[0]?.lifecycleScope, "/new keeps the host lifecycle scope");
			const run = findRun();
			assert.equal(run?.status, "paused", "/new quits the in-flight run at a resumable checkpoint");
			assert.equal(run?.exitReason, "quit");
			assert.equal(
				run?.stages.some((candidate) => candidate.name === "after-reload"),
				false,
				"the quit run creates no stage after /new",
			);
			assert.deepEqual(stageSurfaces, [], "no stage is requested through either session after /new");
		} finally {
			if (findRun()?.status === "running") {
				await host.release().catch(() => {});
				await waitFor(() => findRun()?.endedAt !== undefined, "the run to settle before disposal").catch(() => {});
			}
			await runtime.dispose();
			await host.cleanup();
		}
	},
	HOST_RELOAD_STAGE_TIMEOUT_MS,
);

type SessionHandler = Parameters<NonNullable<ExtensionAPI["on"]>>[1];
type SessionContext = Parameters<SessionHandler>[1];

function sessionContext(): SessionContext {
	return { model: decisionModel, ui: { notify() {} } };
}

function generationHost(scope: object): {
	readonly pi: ExtensionAPI;
	readonly emit: (event: string, payload: { readonly reason: string }, ctx?: SessionContext) => void;
	readonly commit: () => void;
} {
	const handlers = new Map<string, SessionHandler[]>();
	const commitEffects: Array<() => void | Promise<void>> = [];
	const pi: ExtensionAPI = {
		lifecycleScope: scope,
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	return {
		pi,
		commit: () => {
			for (const effect of commitEffects.splice(0)) effect();
		},
		emit: (event, payload, ctx) => {
			if (payload.reason === "reload" && event === "session_start" && ctx) {
				bindExtensionContextPublication(ctx, (effect) => commitEffects.push(effect));
			}
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		},
	};
}

test("a rolled-back successor generation hands the run back to its live predecessor (#3201)", () => {
	const scope = {};
	const predecessor = generationHost(scope);
	const resolve = trackLiveHostGeneration(predecessor.pi);
	predecessor.emit("session_start", { reason: "startup" }, sessionContext());
	assert.equal(resolve()?.pi, predecessor.pi);

	const successor = generationHost(scope);
	trackLiveHostGeneration(successor.pi);
	const successorContext = sessionContext();
	successor.emit("session_start", { reason: "reload" }, successorContext);
	assert.equal(resolve()?.pi, predecessor.pi, "an uncommitted reload candidate is never published");

	successor.emit("session_shutdown", { reason: "reload" });
	assert.equal(resolve()?.pi, predecessor.pi, "a rolled-back successor must not become the live generation");

	predecessor.emit("session_shutdown", { reason: "reload" });
	assert.equal(resolve(), undefined, "with no live generation the caller keeps its launch surface");
});

test("a reload candidate is published at commit before its predecessor retires (#3201)", () => {
	const scope = {};
	const predecessor = generationHost(scope);
	const resolve = trackLiveHostGeneration(predecessor.pi);
	predecessor.emit("session_start", { reason: "startup" }, sessionContext());

	const successor = generationHost(scope);
	trackLiveHostGeneration(successor.pi);
	const successorContext = sessionContext();
	successor.emit("session_start", { reason: "reload" }, successorContext);
	assert.equal(resolve()?.pi, predecessor.pi, "the predecessor stays live until the reload commits");

	successor.commit();
	assert.equal(resolve()?.pi, successor.pi, "commit hands off before predecessor shutdown");
	predecessor.emit("session_shutdown", { reason: "reload" });
	assert.equal(resolve()?.pi, successor.pi, "the committed successor is live once its predecessor retires");
	assert.equal(resolve()?.modelContext, successorContext);
});

test.each(["new", "fork", "resume"] as const)(
	"a %s start never becomes the live generation of the session it replaced (#3201)",
	(reason) => {
		const scope = {};
		const launch = generationHost(scope);
		const resolveLaunch = trackLiveHostGeneration(launch.pi);
		launch.emit("session_start", { reason: "startup" }, sessionContext());

		const resumed = generationHost(scope);
		const resolveResumed = trackLiveHostGeneration(resumed.pi);
		assert.equal(
			resolveLaunch()?.pi,
			launch.pi,
			"replacement prepares its successor before the launch session shuts down",
		);
		launch.emit("session_shutdown", { reason });
		const resumedContext = sessionContext();
		resumed.emit("session_start", { reason }, resumedContext);
		assert.equal(resolveLaunch(), undefined, "the replaced session's run keeps its launch pi and model ctx");
		assert.equal(resolveResumed()?.modelContext, resumedContext);

		const reloaded = generationHost(scope);
		trackLiveHostGeneration(reloaded.pi);
		reloaded.emit("session_start", { reason: "reload" }, sessionContext());
		reloaded.commit();
		resumed.emit("session_shutdown", { reason: "reload" });
		assert.equal(
			resolveResumed()?.pi,
			reloaded.pi,
			"/reload still hands the resumed session's runs to its successor",
		);
		assert.equal(resolveLaunch(), undefined);
	},
);
