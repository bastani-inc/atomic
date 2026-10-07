import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	createInMemoryTestBackend,
	getDurableBackend,
	setDurableBackend,
} from "../../packages/workflows/src/durable/factory.js";
import { settleStartupWorkflowRecoveries } from "../../packages/workflows/src/extension/extension-lifecycle.js";
import factory, { type ExtensionAPI, type PiCommandOptions } from "../../packages/workflows/src/extension/index.js";
import { createExtensionRuntime, type ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { assertWorkflowInstanceOwner } from "../../packages/workflows/src/extension/workflow-instance-owner.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { cancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { killAllRuns } from "../../packages/workflows/src/runs/background/status.js";
import type { SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { ChatSurfacePayload } from "../../packages/workflows/src/tui/chat-surface-message.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";

interface SentMessage {
	customType?: string;
	content?: string;
	details?: unknown;
}

type Handler = (event?: unknown, ctx?: unknown) => Promise<void> | void;

const originalCwd = process.cwd();

async function cleanupJobs(): Promise<void> {
	await Promise.all(jobTracker.runIds().map((runId) => jobTracker.get(runId)?.promise));
}

beforeEach(() => {
	setDurableBackend(createInMemoryTestBackend());
});

afterEach(async () => {
	delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
	process.chdir(originalCwd);
	killAllRuns({ store, cancellation: cancellationRegistry });
	await cleanupJobs();
	store.clear();
	setDurableBackend(undefined);
});

function workflowConfigDir(root: string): string {
	return join(root, ".atomic", "extensions", "workflow");
}

function registerFactory(
	piOverrides: Partial<ExtensionAPI> = {},
	prompt = async () => "ok",
): {
	handlers: Map<string, Handler>;
	commands: Array<{ name: string; options: PiCommandOptions }>;
	sent: SentMessage[];
} {
	const handlers = new Map<string, Handler>();
	const commands: Array<{ name: string; options: PiCommandOptions }> = [];
	const sent: SentMessage[] = [];
	const pi = {
		registerTool: () => undefined,
		registerCommand: (name: string, options: PiCommandOptions) => {
			commands.push({ name, options });
		},
		registerMessageRenderer: () => undefined,
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		sendMessage: (message: SentMessage) => {
			sent.push(message);
		},
		createAgentSession: async () => ({
			session: {
				prompt,
				steer: async () => undefined,
				followUp: async () => undefined,
				subscribe: () => () => undefined,
				sessionFile: undefined,
				sessionId: "workflow-lazy-test-session",
				setModel: async () => undefined,
				setThinkingLevel: () => undefined,
				dispose: async () => undefined,
			},
		}),
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		...piOverrides,
	} as unknown as ExtensionAPI;
	factory(pi);
	return { handlers, commands, sent };
}

async function startSession(handlers: Map<string, Handler>, event: unknown, ctx: unknown): Promise<void> {
	await handlers.get("session_start")?.(event, ctx);
	await settleStartupWorkflowRecoveries();
}

function inFlightEntry(runId: string, name = "config-restore-wf"): SessionEntry {
	return { id: `${runId}-start`, type: "workflow.run.start", payload: { runId, name, inputs: {}, ts: 1 } };
}

function listPayload(sent: readonly SentMessage[]): ChatSurfacePayload | undefined {
	const message = sent.find((entry) => {
		const details = entry.details;
		return typeof details === "object" && details !== null && "kind" in details && details.kind === "list";
	});
	return message?.details as ChatSurfacePayload | undefined;
}

async function writeWorkflowFixture(filePath: string, name: string): Promise<void> {
	await writeFile(
		filePath,
		`import { workflow } from "@bastani/workflows";
export default workflow({
  name: ${JSON.stringify(name)},
  description: "",
  inputs: {},
  outputs: {},
  run: async () => ({}),
});
`,
		"utf8",
	);
}

async function writePromptWorkflowFixture(filePath: string, name: string): Promise<void> {
	await writeFile(
		filePath,
		`import { workflow } from "@bastani/workflows";
export default workflow({
  name: ${JSON.stringify(name)},
  description: "",
  inputs: {},
  outputs: { value: { type: "string" } },
  run: async (ctx) => ({ value: await ctx.stage("retry").prompt("retry") }),
});
`,
		"utf8",
	);
}

async function writeTrackedWorkflowFixture(filePath: string, name: string): Promise<void> {
	await writeFile(
		filePath,
		`import { workflow } from "@bastani/workflows";
export default workflow({
  name: ${JSON.stringify(name)}, description: "", inputs: {}, outputs: {},
  run: async (ctx) => { await ctx.tool("marker", {}, async () => true); return {}; },
});
`,
		"utf8",
	);
}

describe("workflow lazy-startup continuation fixes", () => {
	test("session_start revalidates project scope after ask confirmation (#3468)", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-workflow-startup-project-race-"));
		try {
			mkdirSync(workflowConfigDir(root), { recursive: true });
			writeFileSync(join(workflowConfigDir(root), "config.json"), JSON.stringify({ resumeInFlight: "ask" }));
			const workflowPath = join(root, "shared.ts");
			await writeTrackedWorkflowFixture(workflowPath, "shared");
			process.chdir(root);
			const backend = getDurableBackend();
			const runId = testRunId("startup-project-confirmation-race");
			const handle = {
				workflowId: runId,
				name: "shared",
				inputs: {},
				status: "running" as const,
				createdAt: 1,
				updatedAt: 1,
				completedCheckpoints: 1,
				invocationCwd: root,
			};
			backend.registerWorkflow(handle);
			const { handlers } = registerFactory({ getWorkflowResources: () => [{ path: workflowPath, enabled: true }] });
			let prompts = 0;
			let changedHandle = backend.getWorkflow(runId);
			await startSession(
				handlers,
				{ reason: "startup" },
				{
					cwd: root,
					hasUI: true,
					ui: {
						notify: () => undefined,
						confirm: async () => {
							prompts += 1;
							backend.registerWorkflow({ ...handle, invocationCwd: join(root, "elsewhere") });
							changedHandle = backend.getWorkflow(runId);
							return true;
						},
					},
				},
			);
			await cleanupJobs();
			assert.equal(prompts, 1);
			assert.equal(store.runs().length, 0);
			assert.deepEqual(backend.getWorkflow(runId), changedHandle);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	for (const mode of ["auto", "ask"] as const) {
		for (const ownership of ["user", "agent", "legacy"] as const) {
			test(`session_start ${mode} excludes ${ownership} runs from another project sharing a database (#3468)`, async () => {
				const root = mkdtempSync(join(tmpdir(), "atomic-workflow-startup-project-"));
				try {
					const projectA = join(root, "a");
					const projectB = join(root, "b");
					mkdirSync(projectA);
					mkdirSync(workflowConfigDir(projectB), { recursive: true });
					writeFileSync(
						join(workflowConfigDir(projectB), "config.json"),
						JSON.stringify({ resumeInFlight: mode }),
					);
					const workflowPath = join(projectB, "shared.ts");
					await writeTrackedWorkflowFixture(workflowPath, "shared");
					await writeTrackedWorkflowFixture(join(projectA, "shared.ts"), "shared");
					process.chdir(projectA);
					const backend = getDurableBackend();
					const runId = testRunId(`startup-project-${mode}-${ownership}`);
					backend.registerWorkflow({
						workflowId: runId,
						name: "shared",
						inputs: {},
						status: "running",
						createdAt: 1,
						updatedAt: 1,
						completedCheckpoints: 1,
						...(ownership === "legacy" ? {} : { invocationCwd: projectA }),
						...(ownership === "agent" ? { origin: "agent", modelOwner: "previous-session" } : {}),
					});
					const before = backend.getWorkflow(runId);
					let prompts = 0;
					const ctx = {
						cwd: projectB,
						hasUI: true,
						ui: {
							notify: () => undefined,
							confirm: async () => {
								prompts += 1;
								return true;
							},
						},
					};
					const { handlers, commands } = registerFactory({
						sessionManager: { getCwd: () => projectB } as ExtensionAPI["sessionManager"],
						getWorkflowResources: () => [{ path: workflowPath, enabled: true }],
					});
					await startSession(handlers, { reason: "startup" }, ctx);
					await cleanupJobs();
					assert.equal(prompts, 0);
					assert.deepEqual(backend.getWorkflow(runId), before);
					assert.equal(store.runs().length, 0);
					if (ownership !== "agent") {
						await commands.find((entry) => entry.name === "workflow")?.options.handler?.(`resume ${runId}`, ctx);
						await cleanupJobs();
						assert.equal(backend.getWorkflow(runId)?.status, "completed", backend.getWorkflow(runId)?.error);
					}
				} finally {
					process.chdir(originalCwd);
					rmSync(root, { recursive: true, force: true });
				}
			});
		}
	}

	for (const scenario of ["safe", "safe-ask", "foreign-cwd", "unknown-owner", "concurrent-claim"] as const) {
		test(`session_start agent recovery ${scenario} preserves ownership fencing (#3468)`, async () => {
			class ClaimBackend extends InMemoryDurableBackend {
				override async transitionWorkflowStatus(
					...args: Parameters<InMemoryDurableBackend["transitionWorkflowStatus"]>
				): Promise<boolean> {
					if (scenario === "concurrent-claim" && args[6] !== undefined) {
						const [id, expected, status, prompts, resumable, updatedAt] = args;
						await super.transitionWorkflowStatus(
							id,
							expected,
							status,
							prompts,
							resumable,
							updatedAt,
							"competing-session",
						);
						return false;
					}
					return super.transitionWorkflowStatus(...args);
				}
			}
			const backend = new ClaimBackend();
			setDurableBackend(backend);
			const root = mkdtempSync(join(tmpdir(), "atomic-workflow-startup-owner-"));
			try {
				mkdirSync(workflowConfigDir(root), { recursive: true });
				writeFileSync(
					join(workflowConfigDir(root), "config.json"),
					JSON.stringify({ resumeInFlight: scenario === "safe-ask" ? "ask" : "auto" }),
				);
				const workflowPath = join(root, "startup-owner.ts");
				await writeFile(
					workflowPath,
					`import { workflow } from "@bastani/workflows";
export default workflow({
  name: "startup-owner", description: "", inputs: {}, outputs: {},
  run: async (ctx) => { await ctx.tool("marker", {}, async () => true); return {}; },
});
`,
					"utf8",
				);
				process.chdir(root);
				const runId = testRunId(`startup-owner-${scenario}`);
				backend.registerWorkflow({
					workflowId: runId,
					name: "startup-owner",
					inputs: {},
					status: "running",
					createdAt: 1,
					updatedAt: 1,
					completedCheckpoints: 1,
					origin: "agent",
					modelOwner: "previous-session",
					invocationCwd: scenario === "foreign-cwd" ? join(root, "elsewhere") : root,
					ownerExecutorId: "atomic-db-00000000-0000-4000-8000-000000000001",
					ownerLiveness: scenario === "unknown-owner" ? "unknown" : "dead",
				});
				const original = backend.getWorkflow(runId);
				const ctx = {
					sessionManager: { getSessionId: () => "recovering-session" },
					cwd: root,
					hasUI: scenario === "safe-ask",
					ui: { notify: () => undefined, confirm: async () => true },
				};
				const { handlers } = registerFactory({
					getWorkflowResources: () => [{ path: workflowPath, enabled: true }],
				});
				await startSession(handlers, { reason: "startup" }, ctx);
				await cleanupJobs();
				if (scenario === "safe" || scenario === "safe-ask") {
					assert.equal(
						backend.getWorkflow(runId)?.status,
						"completed",
						store.runs().find((run) => run.id === runId)?.error,
					);
					assert.equal(backend.getWorkflow(runId)?.modelOwner, ctx.sessionManager.getSessionId());
					assert.doesNotThrow(() => assertWorkflowInstanceOwner(runId, ctx as never, store));
					assert.throws(
						() => assertWorkflowInstanceOwner(runId, { sessionId: "foreign-session" } as never, store),
						/another caller\/session/,
					);
				} else {
					assert.equal(
						store.runs().some((run) => run.id === runId),
						false,
					);
					if (scenario === "concurrent-claim") {
						assert.equal(backend.getWorkflow(runId)?.modelOwner, "competing-session");
					} else {
						assert.deepEqual(backend.getWorkflow(runId), original);
					}
					assert.throws(() => assertWorkflowInstanceOwner(runId, ctx as never, store), /another caller\/session/);
				}
			} finally {
				process.chdir(originalCwd);
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	for (const mode of ["auto", "ask"] as const) {
		test(`repeated startup generations preserve ${mode} recovery without prompting twice (#3468)`, async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-workflow-startup-generations-"));
			let resolvePrompt: (value: string) => void = () => undefined;
			const prompt = new Promise<string>((resolve) => {
				resolvePrompt = resolve;
			});
			try {
				mkdirSync(workflowConfigDir(root), { recursive: true });
				writeFileSync(join(workflowConfigDir(root), "config.json"), JSON.stringify({ resumeInFlight: mode }));
				const workflowPath = join(root, "startup-generations.ts");
				await writePromptWorkflowFixture(workflowPath, "startup-generations");
				process.chdir(root);
				const runId = testRunId("startup-generations");
				getDurableBackend().registerWorkflow({
					workflowId: runId,
					name: "startup-generations",
					inputs: {},
					status: "running",
					createdAt: 1,
					updatedAt: 1,
					completedCheckpoints: 1,
					invocationCwd: root,
				});
				const lifecycleScope = {};
				const overrides = {
					lifecycleScope,
					getWorkflowResources: () => [{ path: workflowPath, enabled: true }],
					createAgentSession: async () => {
						const messages: Array<{
							role: "assistant";
							content: Array<{ type: "text"; text: string }>;
							stopReason: "stop";
						}> = [];
						return {
							session: {
								messages,
								prompt: async () => {
									messages.push({
										role: "assistant",
										content: [{ type: "text", text: await prompt }],
										stopReason: "stop",
									});
								},
								steer: async () => undefined,
								followUp: async () => undefined,
								subscribe: () => () => undefined,
								sessionFile: undefined,
								sessionId: "workflow-startup-generations-session",
								setModel: async () => undefined,
								setThinkingLevel: () => undefined,
								dispose: async () => undefined,
							},
						};
					},
				} as unknown as Partial<ExtensionAPI>;
				let confirmations = 0;
				const ctx = {
					hasUI: true,
					ui: {
						notify: () => undefined,
						confirm: async () => {
							confirmations += 1;
							return true;
						},
					},
				};
				const first = registerFactory(overrides);
				await startSession(first.handlers, { reason: "startup" }, ctx);
				assert.equal(
					store.runs().find((run) => run.id === runId)?.status,
					"running",
					store.runs().find((run) => run.id === runId)?.error,
				);
				await first.handlers.get("session_shutdown")?.({ reason: "reload" });
				const second = registerFactory(overrides);
				await startSession(second.handlers, { reason: "startup" }, ctx);
				assert.equal(confirmations, mode === "ask" ? 1 : 0);
				assert.equal(
					store.runs().find((run) => run.id === runId)?.status,
					"running",
					store.runs().find((run) => run.id === runId)?.error,
				);
				resolvePrompt("finished");
				await cleanupJobs();
				assert.equal(getDurableBackend().getWorkflow(runId)?.status, "completed");
			} finally {
				resolvePrompt("finished");
				await cleanupJobs();
				process.chdir(originalCwd);
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	for (const scenario of [
		{ mode: "auto", hasUI: false, answer: false, resumes: true, prompts: 0 },
		{ mode: "never", hasUI: true, answer: true, resumes: false, prompts: 0 },
		{ mode: "ask", hasUI: true, answer: true, resumes: true, prompts: 1 },
		{ mode: "ask", hasUI: true, answer: false, resumes: false, prompts: 1 },
		{ mode: "ask", hasUI: false, answer: true, resumes: false, prompts: 0 },
	] as const) {
		test(`session_start ${scenario.mode} UI=${scenario.hasUI} answer=${scenario.answer} honors durable recovery policy (#3468)`, async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-workflow-startup-policy-"));
			try {
				mkdirSync(workflowConfigDir(root), { recursive: true });
				writeFileSync(
					join(workflowConfigDir(root), "config.json"),
					JSON.stringify({ resumeInFlight: scenario.mode }),
				);
				const workflowPath = join(root, "startup-workflow.ts");
				await writeFile(
					workflowPath,
					`import { workflow } from "@bastani/workflows";
export default workflow({
  name: "startup-workflow", description: "", inputs: {}, outputs: {},
  run: async (ctx) => {
    await ctx.tool("startup-marker", {}, async () => true);
    return {};
  },
});
`,
					"utf8",
				);
				process.chdir(root);
				const runId = testRunId("startup-policy");
				const backend = getDurableBackend();
				backend.registerWorkflow({
					workflowId: runId,
					name: "startup-workflow",
					inputs: {},
					status: "running",
					createdAt: 1,
					updatedAt: 1,
					completedCheckpoints: 1,
					invocationCwd: root,
				});
				const originalHandle = backend.getWorkflow(runId);
				const notices: string[] = [];
				let prompts = 0;
				const ctx = {
					hasUI: scenario.hasUI,
					ui: {
						notify: (message: string) => notices.push(message),
						confirm: async (title: string) => {
							assert.match(title, /Resume interrupted workflows/);
							prompts += 1;
							return scenario.answer;
						},
					},
				};
				const { handlers, commands } = registerFactory({
					getWorkflowResources: () => [{ path: workflowPath, enabled: true }],
				});
				await startSession(handlers, { reason: "startup" }, ctx);
				await cleanupJobs();
				await startSession(handlers, { reason: "startup" }, ctx);
				await cleanupJobs();
				assert.equal(prompts, scenario.prompts);
				if (!scenario.resumes) {
					assert.deepEqual(backend.getWorkflow(runId), originalHandle);
					assert.equal(
						store.runs().some((run) => run.id === runId),
						false,
					);
					const command = commands.find((entry) => entry.name === "workflow");
					assert.ok(command);
					await command.options.handler?.(`resume ${runId}`, { hasUI: false, ui: ctx.ui });
					await cleanupJobs();
				}
				assert.equal(backend.getWorkflow(runId)?.status, "completed", notices.join("\n"));
				assert.equal(store.runs().find((run) => run.id === runId)?.status, "completed");
			} finally {
				process.chdir(originalCwd);
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	test("session_start does not wait for the resumeInFlight ask confirmation (startup stall from #3487)", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-workflow-startup-nonblocking-"));
		try {
			mkdirSync(workflowConfigDir(root), { recursive: true });
			writeFileSync(join(workflowConfigDir(root), "config.json"), JSON.stringify({ resumeInFlight: "ask" }));
			const workflowPath = join(root, "shared.ts");
			await writeTrackedWorkflowFixture(workflowPath, "shared");
			process.chdir(root);
			const backend = getDurableBackend();
			const runId = testRunId("startup-nonblocking-ask");
			backend.registerWorkflow({
				workflowId: runId,
				name: "shared",
				inputs: {},
				status: "running",
				createdAt: 1,
				updatedAt: 1,
				completedCheckpoints: 1,
				invocationCwd: root,
			});
			const originalHandle = backend.getWorkflow(runId);
			let answer: (value: boolean) => void = () => undefined;
			let prompted: () => void = () => undefined;
			const promptShown = new Promise<void>((resolve) => {
				prompted = resolve;
			});
			const { handlers } = registerFactory({ getWorkflowResources: () => [{ path: workflowPath, enabled: true }] });
			const startup = handlers.get("session_start")?.(
				{ reason: "startup" },
				{
					cwd: root,
					hasUI: true,
					ui: {
						notify: () => undefined,
						confirm: () =>
							new Promise<boolean>((resolve) => {
								answer = resolve;
								prompted();
							}),
					},
				},
			);
			const outcome = await Promise.race([
				Promise.resolve(startup).then(() => "started" as const),
				promptShown.then(() => new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 200))),
			]);
			assert.equal(outcome, "started");
			await promptShown;
			answer(false);
			await settleStartupWorkflowRecoveries();
			await cleanupJobs();
			assert.equal(store.runs().length, 0);
			assert.deepEqual(backend.getWorkflow(runId), originalHandle);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("session_start leaves interrupted workflows untouched without a resumeInFlight setting", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-workflow-startup-default-never-"));
		try {
			const workflowPath = join(root, "shared.ts");
			await writeTrackedWorkflowFixture(workflowPath, "shared");
			process.chdir(root);
			const backend = getDurableBackend();
			const runId = testRunId("startup-default-never");
			backend.registerWorkflow({
				workflowId: runId,
				name: "shared",
				inputs: {},
				status: "running",
				createdAt: 1,
				updatedAt: 1,
				completedCheckpoints: 1,
				invocationCwd: root,
			});
			const originalHandle = backend.getWorkflow(runId);
			let confirmations = 0;
			const { handlers } = registerFactory({ getWorkflowResources: () => [{ path: workflowPath, enabled: true }] });
			await handlers.get("session_start")?.(
				{ reason: "startup" },
				{
					cwd: root,
					hasUI: true,
					ui: {
						notify: () => undefined,
						confirm: async () => {
							confirmations += 1;
							return true;
						},
					},
				},
			);
			await settleStartupWorkflowRecoveries();
			await cleanupJobs();
			assert.equal(confirmations, 0);
			assert.equal(store.runs().length, 0);
			assert.deepEqual(backend.getWorkflow(runId), originalHandle);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a recovery prompt answered after session_shutdown does not resume (startup stall from #3487)", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-workflow-startup-retired-"));
		try {
			mkdirSync(workflowConfigDir(root), { recursive: true });
			writeFileSync(join(workflowConfigDir(root), "config.json"), JSON.stringify({ resumeInFlight: "ask" }));
			const workflowPath = join(root, "shared.ts");
			await writeTrackedWorkflowFixture(workflowPath, "shared");
			process.chdir(root);
			const backend = getDurableBackend();
			const runId = testRunId("startup-retired-ask");
			backend.registerWorkflow({
				workflowId: runId,
				name: "shared",
				inputs: {},
				status: "running",
				createdAt: 1,
				updatedAt: 1,
				completedCheckpoints: 1,
				invocationCwd: root,
			});
			const originalHandle = backend.getWorkflow(runId);
			let answer: (value: boolean) => void = () => undefined;
			let prompted: () => void = () => undefined;
			const promptShown = new Promise<void>((resolve) => {
				prompted = resolve;
			});
			const { handlers } = registerFactory({ getWorkflowResources: () => [{ path: workflowPath, enabled: true }] });
			await handlers.get("session_start")?.(
				{ reason: "startup" },
				{
					cwd: root,
					hasUI: true,
					ui: {
						notify: () => undefined,
						confirm: () =>
							new Promise<boolean>((resolve) => {
								answer = resolve;
								prompted();
							}),
					},
				},
			);
			await promptShown;
			await handlers.get("session_shutdown")?.({ reason: "quit" });
			answer(true);
			await settleStartupWorkflowRecoveries();
			await cleanupJobs();
			assert.equal(store.runs().length, 0);
			assert.deepEqual(backend.getWorkflow(runId), originalHandle);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("session_start ask does not offer live, paused, failed, blocked or awaiting-input runs (#3468)", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-workflow-startup-exclusions-"));
		try {
			mkdirSync(workflowConfigDir(root), { recursive: true });
			writeFileSync(join(workflowConfigDir(root), "config.json"), JSON.stringify({ resumeInFlight: "ask" }));
			process.chdir(root);
			const backend = getDurableBackend();
			for (const status of ["paused", "failed", "blocked", "running"] as const) {
				backend.registerWorkflow({
					workflowId: testRunId(`startup-excluded-${status}`),
					name: "excluded",
					inputs: {},
					status,
					createdAt: 1,
					updatedAt: status === "running" ? Date.now() : 1,
					completedCheckpoints: 1,
					invocationCwd: root,
				});
			}
			backend.registerWorkflow({
				workflowId: testRunId("startup-awaiting-input"),
				name: "excluded",
				inputs: {},
				status: "running",
				createdAt: 1,
				updatedAt: 1,
				pendingPrompts: 1,
				invocationCwd: root,
			});
			backend.registerWorkflow({
				workflowId: testRunId("startup-live-quiet-owner"),
				name: "excluded",
				inputs: {},
				status: "running",
				createdAt: 1,
				updatedAt: 1,
				completedCheckpoints: 1,
				invocationCwd: root,
				ownerLiveness: "alive",
			});
			const before = backend.listResumableWorkflows();
			let discoveryCalls = 0;
			const { handlers } = registerFactory({
				disableAsyncDiscovery: true,
				getWorkflowResources: () => {
					discoveryCalls += 1;
					return [];
				},
			});
			let prompts = 0;
			await startSession(
				handlers,
				{ reason: "startup" },
				{
					hasUI: true,
					ui: {
						confirm: async () => {
							prompts += 1;
							return false;
						},
					},
				},
			);
			assert.equal(prompts, 0);
			assert.deepEqual(backend.listResumableWorkflows(), before);
			assert.equal(store.runs().length, 0);
			assert.equal(discoveryCalls, 0);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	for (const mode of ["auto", "ask"] as const) {
		test(`presentation-only session_start does not apply ${mode} recovery (#3468)`, async () => {
			class CatalogBackend extends InMemoryDurableBackend {
				catalogReads = 0;
				override async hydrateResumableWorkflows(): Promise<void> {
					this.catalogReads += 1;
					await super.hydrateResumableWorkflows();
				}
			}
			const backend = new CatalogBackend();
			setDurableBackend(backend);
			const root = mkdtempSync(join(tmpdir(), "atomic-workflow-presentation-startup-"));
			try {
				mkdirSync(workflowConfigDir(root), { recursive: true });
				writeFileSync(join(workflowConfigDir(root), "config.json"), JSON.stringify({ resumeInFlight: mode }));
				process.chdir(root);
				backend.registerWorkflow({
					workflowId: testRunId("presentation-startup"),
					name: "presentation-startup",
					inputs: {},
					status: "running",
					createdAt: 1,
					updatedAt: 1,
					completedCheckpoints: 1,
					invocationCwd: root,
				});
				const before = backend.listResumableWorkflows();
				let prompts = 0;
				const { handlers } = registerFactory({ disableAsyncDiscovery: true });
				await startSession(
					handlers,
					{ reason: "startup" },
					{
						isPresentationOnly: true,
						hasUI: true,
						ui: {
							confirm: async () => {
								prompts += 1;
								return false;
							},
						},
					},
				);
				assert.equal(backend.catalogReads, 0);
				assert.equal(prompts, 0);
				assert.deepEqual(backend.listResumableWorkflows(), before);
				assert.equal(store.runs().length, 0);
			} finally {
				process.chdir(originalCwd);
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	test("session_start recovery failure warns without failing startup (#3468)", async () => {
		class UnavailableBackend extends InMemoryDurableBackend {
			override async hydrateResumableWorkflows(): Promise<void> {
				throw new Error("durable catalog unavailable");
			}
		}
		setDurableBackend(new UnavailableBackend());
		const root = mkdtempSync(join(tmpdir(), "atomic-workflow-startup-unavailable-"));
		try {
			mkdirSync(workflowConfigDir(root), { recursive: true });
			writeFileSync(join(workflowConfigDir(root), "config.json"), JSON.stringify({ resumeInFlight: "auto" }));
			process.chdir(root);
			const notices: string[] = [];
			const { handlers } = registerFactory({ disableAsyncDiscovery: true });
			await startSession(
				handlers,
				{ reason: "startup" },
				{
					hasUI: false,
					ui: { notify: (message: string) => notices.push(message) },
				},
			);
			assert.match(notices.join("\n"), /durable catalog unavailable.*\/workflow resume/);
			assert.equal(store.runs().length, 0);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("session_start ignores session workflow state without discovering workflow modules", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-workflow-config-restore-"));
		try {
			mkdirSync(workflowConfigDir(root), { recursive: true });

			writeFileSync(join(workflowConfigDir(root), "config.json"), JSON.stringify({ persistRuns: false }), "utf8");
			process.chdir(root);
			let resourceCalls = 0;
			const { handlers } = registerFactory({
				disableAsyncDiscovery: true,
				getWorkflowResources: () => {
					resourceCalls += 1;
					return [];
				},
			});
			const sessionStart = handlers.get("session_start");
			assert.ok(sessionStart);
			await sessionStart(
				{},
				{ sessionManager: { getEntries: () => [inFlightEntry(testRunId("persist-off-run"))] } },
			);
			assert.equal(store.runs().length, 0);
			assert.equal(resourceCalls, 0);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("resumeInFlight cannot restore workflow state from session JSONL", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-workflow-config-auto-"));
		try {
			mkdirSync(workflowConfigDir(root), { recursive: true });
			writeFileSync(
				join(workflowConfigDir(root), "config.json"),
				JSON.stringify({ resumeInFlight: "auto" }),
				"utf8",
			);
			process.chdir(root);
			const { handlers } = registerFactory({ disableAsyncDiscovery: true });
			await startSession(
				handlers,
				{},
				{ sessionManager: { getEntries: () => [inFlightEntry(testRunId("auto-run"))] } },
			);
			assert.equal(
				store.runs().some((run) => run.id === testRunId("auto-run")),
				false,
			);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("session_start emits immediate config diagnostics without workflow discovery", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-workflow-config-diagnostics-"));
		try {
			mkdirSync(workflowConfigDir(root), { recursive: true });
			writeFileSync(join(workflowConfigDir(root), "config.json"), "{ not valid json", "utf8");
			process.chdir(root);
			let resourceCalls = 0;
			const notifications: string[] = [];
			const { handlers } = registerFactory({
				disableAsyncDiscovery: true,
				getWorkflowResources: () => {
					resourceCalls += 1;
					return [];
				},
			});
			await startSession(handlers, {}, { ui: { notify: (message: string) => notifications.push(message) } });
			assert.equal(resourceCalls, 0);
			assert.match(notifications.join("\n"), /CONFIG_INVALID/);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("/workflow list retries after a transient lazy discovery failure", async () => {
		const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-lazy-retry-"));
		try {
			const workflowPath = join(dir, "retry-workflow.ts");
			await writeWorkflowFixture(workflowPath, "retry workflow");
			let refreshCalls = 0;
			const { commands, sent } = registerFactory({
				refreshWorkflowResources: async () => {
					refreshCalls += 1;
					if (refreshCalls === 1) throw new Error("transient refresh failure");
					return [{ path: workflowPath, enabled: true }];
				},
			});
			const workflowCmd = commands.find((command) => command.name === "workflow");
			assert.ok(workflowCmd);
			const notices: string[] = [];
			const headlessCtx = {
				hasUI: false,
				ui: {
					notify: (message: string) => {
						notices.push(message);
					},
				},
			};
			await workflowCmd.options.handler?.("list", headlessCtx);
			assert.equal(refreshCalls, 1);
			assert.match(notices.join("\n"), /transient refresh failure/);
			sent.length = 0;
			await workflowCmd.options.handler?.("list", headlessCtx);
			assert.equal(refreshCalls, 2);
			assert.equal(listPayload(sent)?.kind, "list");
			assert.match(sent.map((entry) => entry.content ?? "").join("\n"), /retry-workflow/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("/workflow autocomplete falls back to admin completions when lazy discovery fails", async () => {
		let refreshCalls = 0;
		const { commands } = registerFactory({
			refreshWorkflowResources: async () => {
				refreshCalls += 1;
				throw new Error("discovery failed");
			},
		});
		const workflowCmd = commands.find((command) => command.name === "workflow");
		assert.ok(workflowCmd?.options.getArgumentCompletions);

		const completions = await workflowCmd.options.getArgumentCompletions("");

		assert.equal(refreshCalls, 1);
		assert.ok(Array.isArray(completions));
		assert.ok(completions.some((item) => item.value === "list "));
		assert.ok(completions.some((item) => item.value === "resume "));
	});

	test("/workflow resume for paused live runs does not force workflow discovery", async () => {
		let refreshCalls = 0;
		const { commands } = registerFactory({
			refreshWorkflowResources: async () => {
				refreshCalls += 1;
				throw new Error("discovery failed");
			},
		});
		const runId = testRunId("paused-slash-resume-source");
		store.recordRunStart({
			id: runId,
			name: "paused workflow",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: Date.now(),
		});
		assert.equal(store.recordRunPaused(runId), true);
		const workflowCmd = commands.find((command) => command.name === "workflow");
		assert.ok(workflowCmd);

		await workflowCmd.options.handler?.(`resume ${runId}`, { hasUI: false, ui: { notify: () => undefined } });

		assert.equal(refreshCalls, 0);
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
	});

	test("workflow tool paused resume bypasses workflow discovery", async () => {
		let ensureCalls = 0;
		const runId = testRunId("paused-tool-resume-source");
		store.recordRunStart({
			id: runId,
			name: "paused tool workflow",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: Date.now(),
		});
		assert.equal(store.recordRunPaused(runId), true);
		const runtime = createExtensionRuntime({ registry: createRegistry([]), store });
		const handler = makeExecuteWorkflowTool(
			runtime,
			() => undefined,
			async () => {
				ensureCalls += 1;
				throw new Error("discovery failed");
			},
		);

		const result = await handler({ action: "resume", runId }, {} as never);

		assert.equal(ensureCalls, 0);
		assert.equal(result.action, "resume");
		assert.equal(result.status, "ok");
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
	});

	test("/workflow resume lazy-loads resources before failed-run registry lookup", async () => {
		class CatalogCountingBackend extends InMemoryDurableBackend {
			completedCatalogCalls = 0;

			override listCompletedWorkflows() {
				this.completedCatalogCalls += 1;
				return super.listCompletedWorkflows();
			}
		}

		const backend = new CatalogCountingBackend();
		setDurableBackend(backend);
		const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-slash-resume-lazy-"));
		try {
			const workflowPath = join(dir, "slash-resume-lazy.ts");
			await writePromptWorkflowFixture(workflowPath, "slash-resume-lazy");
			let refreshCalls = 0;
			const { commands, sent } = registerFactory({
				refreshWorkflowResources: async () => {
					refreshCalls += 1;
					return [{ path: workflowPath, enabled: true }];
				},
			});
			const sourceRunId = testRunId("lazy-slash-resume-source");
			store.recordRunStart({
				id: sourceRunId,
				name: "slash-resume-lazy",
				inputs: {},
				status: "running",
				stages: [],
				startedAt: Date.now(),
			});
			store.recordStageStart(sourceRunId, {
				id: "retry-old",
				name: "retry",
				status: "failed",
				parentIds: [],
				toolEvents: [],
				error: "boom",
			});
			store.recordStageEnd(sourceRunId, {
				id: "retry-old",
				name: "retry",
				status: "failed",
				parentIds: [],
				toolEvents: [],
				error: "boom",
			});
			store.recordRunEnd(sourceRunId, "failed", undefined, "boom", { resumable: true, failedStageId: "retry-old" });
			backend.registerWorkflow({
				workflowId: sourceRunId,
				name: "slash-resume-lazy",
				inputs: {},
				createdAt: Date.now(),
				status: "failed",
				resumable: true,
			});
			const workflowCmd = commands.find((command) => command.name === "workflow");
			assert.ok(workflowCmd);
			await workflowCmd.options.handler?.(`resume ${sourceRunId}`, {
				hasUI: false,
				ui: { notify: () => undefined },
			});
			assert.equal(refreshCalls, 1);
			assert.equal(backend.completedCatalogCalls, 1);
			const output = sent.map((entry) => entry.content ?? "").join("\n");
			assert.match(output, /Resum/);
			assert.doesNotMatch(output, /Run not found/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("workflow tool resume lazy-loads resources before failed-run registry lookup", async () => {
		delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
		const def = workflow({
			name: "lazy resume workflow",
			description: "",
			inputs: {},
			outputs: { value: Type.Optional(Type.String()) },
			run: async (ctx) => ({ value: await ctx.stage("retry").prompt("retry") }),
		});
		const sourceRunId = testRunId("lazy-tool-resume-source");
		store.recordRunStart({
			id: sourceRunId,
			name: def.name,
			inputs: {},
			status: "running",
			stages: [],
			startedAt: Date.now(),
		});
		store.recordStageStart(sourceRunId, {
			id: "retry-old",
			name: "retry",
			status: "failed",
			parentIds: [],
			toolEvents: [],
			error: "boom",
		});
		store.recordStageEnd(sourceRunId, {
			id: "retry-old",
			name: "retry",
			status: "failed",
			parentIds: [],
			toolEvents: [],
			error: "boom",
		});
		store.recordRunEnd(sourceRunId, "failed", undefined, "boom", { resumable: true, failedStageId: "retry-old" });
		// #3106: resume requires the original durable instance, not a snapshot-only fork.
		getDurableBackend().registerWorkflow({
			workflowId: sourceRunId,
			name: def.name,
			inputs: {},
			createdAt: Date.now(),
			status: "failed",
			resumable: true,
		});
		let runtime: ExtensionRuntime = createExtensionRuntime({ registry: createRegistry([]) });
		let ensureCalls = 0;
		const handler = makeExecuteWorkflowTool(
			() => runtime,
			() => undefined,
			async () => {
				ensureCalls += 1;
				runtime = createExtensionRuntime({
					registry: createRegistry([def]),
					store,
					adapters: { prompt: { prompt: async () => "new" } },
				});
			},
		);
		const result = await handler({ action: "resume", runId: sourceRunId }, {
			model: { provider: "fake", id: "model" },
		} as never);
		assert.equal(ensureCalls, 1);
		assert.equal(result.action, "resume");
		assert.equal(result.status, "running");
		assert.equal(result.runId, sourceRunId);
		assert.match(result.message ?? "", /Resum/);
	});

	test("session_start invalidates stale workflow warmups before they publish old registries", async () => {
		const dir = await mkdtemp(join(tmpdir(), "atomic-workflow-stale-warmup-"));
		try {
			const oldPath = join(dir, "old-workflow.ts");
			const newPath = join(dir, "new-workflow.ts");
			await writeWorkflowFixture(oldPath, "old workflow");
			await writeWorkflowFixture(newPath, "new workflow");

			let refreshCalls = 0;
			const resolvers: Array<(resources: Array<{ path: string; enabled: true }>) => void> = [];
			const refreshStarted: Promise<void>[] = [];
			const waitForRefresh = async (index: number): Promise<void> => {
				while (refreshStarted.length <= index) {
					await new Promise((resolve) => setImmediate(resolve));
				}
				await refreshStarted[index];
			};
			const { handlers, commands, sent } = registerFactory({
				refreshWorkflowResources: () => {
					refreshCalls += 1;
					let markStarted: () => void = () => undefined;
					refreshStarted.push(
						new Promise((resolve) => {
							markStarted = resolve;
						}),
					);
					markStarted();
					return new Promise((resolve) => {
						resolvers.push(resolve);
					});
				},
			});
			const sessionStart = handlers.get("session_start");
			assert.ok(sessionStart);

			await sessionStart({}, { ui: { notify: () => undefined } });
			await waitForRefresh(0);
			await sessionStart({}, { ui: { notify: () => undefined } });

			// The permanent reload coordinator serializes generations. Release the
			// stale pass before waiting for the new session's trailing pass to start.
			assert.equal(refreshCalls, 1);
			resolvers[0]?.([{ path: oldPath, enabled: true }]);
			await waitForRefresh(1);
			assert.equal(refreshCalls, 2);
			resolvers[1]?.([{ path: newPath, enabled: true }]);

			const workflowCmd = commands.find((command) => command.name === "workflow");
			assert.ok(workflowCmd);
			await workflowCmd.options.handler?.("list", { hasUI: false, ui: { notify: () => undefined } });
			const output = sent.map((entry) => entry.content ?? "").join("\n");
			assert.match(output, /new-workflow/);
			assert.doesNotMatch(output, /old-workflow/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
