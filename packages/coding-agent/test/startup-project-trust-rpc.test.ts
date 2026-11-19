import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import * as jsonl from "../src/modes/rpc/jsonl.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.js";
import { bunExecutable, cliPath } from "./cli-test-helpers.js";
import { createHarness } from "./suite/harness.js";

// Real CLI startup, extension loading, and RPC input are structural work.
const REAL_STARTUP_RPC_TIMEOUT_MS = 120_000;

for (const scenario of [
	"approve",
	"deny",
	"cancel",
	"confirm",
	"input",
	"borrowed-approve",
	"borrowed-deny",
	"hung-observer",
	"extension-error",
] as const) {
	// #2873: the child must own startup trust after the input reader and real session are bound.
	test(
		`isolated startup ${scenario} emits live prompt events before an RPC answer`,
		async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-startup-rpc-"));
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			const marker = join(root, "project-loaded");
			const log = join(root, "events.jsonl");
			const borrowed = scenario.startsWith("borrowed-");
			const resourceCwd = borrowed ? join(root, "borrowed") : cwd;
			mkdirSync(cwd, { recursive: true });
			mkdirSync(join(resourceCwd, ".atomic", "extensions"), { recursive: true });
			const brokenExtension = join(resourceCwd, ".atomic", "extensions", "broken.ts");
			if (scenario === "extension-error")
				writeFileSync(brokenExtension, `export default function() { throw new Error('startup fixture failure'); }`);
			if (!borrowed)
				writeFileSync(
					join(cwd, ".atomic", "settings.json"),
					JSON.stringify({
						defaultProvider: "startup-authorized",
						defaultModel: "project-model",
						defaultThinkingLevel: "high",
					}),
				);
			if (borrowed) {
				mkdirSync(join(resourceCwd, "extensions"), { recursive: true });
				writeFileSync(join(resourceCwd, "extensions", "authorized.ts"), `export default function() {}`);
			}
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(
				join(resourceCwd, ".atomic", "extensions", "forbidden.ts"),
				`
			import { writeFileSync, appendFileSync } from 'node:fs';
			export default function(pi) {
				writeFileSync(${JSON.stringify(marker)}, 'loaded');
				pi.registerProvider('startup-authorized', {
					baseUrl:'https://startup.invalid', api:'openai-completions', apiKey:'local-test-key',
					models:[{id:'project-model', name:'Project model', reasoning:true, input:['text'],
						cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:8192, maxTokens:256}],
				});
				pi.on('session_start', () => appendFileSync(${JSON.stringify(log)}, JSON.stringify({type:'project_start'})+'\\n'));
				pi.on('ui_prompt_start', () => appendFileSync(${JSON.stringify(log)}, JSON.stringify({type:'forbidden_replay'})+'\\n'));
			}
		`,
			);
			const kind = scenario === "confirm" || scenario === "input" ? scenario : "select";
			writeFileSync(
				join(agentDir, "extensions", "reporter.ts"),
				`
			import { appendFileSync } from 'node:fs';
			const record = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry)+'\\n');
			export default function(pi) {
				record({type:'factory'});
				pi.on('session_start', () => record({type:'session_start'}));
				pi.on('session_shutdown', () => record({type:'session_shutdown'}));
				pi.on('ui_prompt_start', (event, ctx) => {
					record({...event, cwd:ctx.cwd, sessionId:ctx.sessionManager.getSessionId(), idle:ctx.isIdle(), trusted:ctx.isProjectTrusted()});
					ctx.ui.notify('startup-start-observed');
					${scenario === "hung-observer" ? "return new Promise(() => {});" : ""}
				});
				pi.on('ui_prompt_end', (event, ctx) => {
					record({...event, cwd:ctx.cwd, sessionId:ctx.sessionManager.getSessionId()});
					ctx.ui.notify('startup-end-observed');
				});
				${
					kind === "select"
						? ""
						: `pi.on('project_trust', async (_event, ctx) => {
					record({type:'trust_hook'});
					const answer = await ctx.ui.${kind}('Hook trust', 'Approve?');
					return {trusted:answer ? 'yes' : 'no'};
				});`
				}
			}
		`,
			);
			const client = new RpcClient({
				cliPath,
				cwd,
				runtimeExecutable: bunExecutable(),
				args: [
					"--no-session",
					"--offline",
					"--no-skills",
					"--no-themes",
					"--no-prompt-templates",
					...(borrowed ? ["-e", resourceCwd] : []),
				],
				env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
				interactiveEngine: { onDiagnostic: () => {} },
			});
			let prompt!: (request: RpcExtensionUIRequest) => void;
			let start!: () => void;
			let end!: () => void;
			const promptPromise = new Promise<RpcExtensionUIRequest>((resolve) => {
				prompt = resolve;
			});
			const startPromise = new Promise<void>((resolve) => {
				start = resolve;
			});
			const endPromise = new Promise<void>((resolve) => {
				end = resolve;
			});
			client.onExtensionUIRequest((request) => {
				if (request.method === kind) prompt(request);
				if (request.method === "notify" && request.message === "startup-start-observed") start();
				if (request.method === "notify" && request.message === "startup-end-observed") end();
			});
			const engineMessages: string[] = [];
			client.onInteractiveEngineMessage((message) => engineMessages.push(message.type));
			const events: Array<{ type: string }> = [];
			client.onEvent((event) => events.push(event));
			const inboundMessages: Array<{
				sequence: number;
				message: { type: string; command?: string; extensionPath?: string };
			}> = [];
			const attachJsonlLineReader = jsonl.attachJsonlLineReader;
			const inboundReader = vi.spyOn(jsonl, "attachJsonlLineReader").mockImplementation((stream, onLine, options) =>
				attachJsonlLineReader(
					stream,
					(line) => {
						// Record wire order before dispatch or Promise continuations can reorder observations.
						inboundMessages.push({ sequence: inboundMessages.length, message: JSON.parse(line) });
						onLine(line);
					},
					options,
				),
			);
			const entries = (): Array<{
				type: string;
				cwd?: string;
				sessionId?: string;
				idle?: boolean;
				trusted?: boolean;
				reason?: string;
				kind?: string;
			}> =>
				readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
			try {
				await client.start();
				const request = await promptPromise;
				await startPromise;
				assert.equal(existsSync(marker), false);
				const before = entries();
				const observed = before.find((entry) => entry.type === "ui_prompt_start");
				assert.ok(observed?.sessionId);
				assert.equal(observed.cwd, realpathSync(cwd));
				assert.equal(observed.idle, true);
				assert.equal(observed.trusted, borrowed);
				assert.equal(observed.reason, "project_trust");
				assert.equal(observed.kind, kind);
				assert.equal(before.filter((entry) => entry.type === "session_start").length, 1);
				assert.equal(engineMessages.includes("engine_project_trust_resolved"), false);
				const modelsAnswer = scenario === "extension-error" ? client.getAvailableModels() : undefined;
				if (scenario === "cancel")
					await client.respondExtensionUI({ type: "extension_ui_response", id: request.id, cancelled: true });
				else if (scenario === "confirm")
					await client.respondExtensionUI({ type: "extension_ui_response", id: request.id, confirmed: true });
				else
					await client.respondExtensionUI({
						type: "extension_ui_response",
						id: request.id,
						value:
							scenario === "input"
								? "yes"
								: scenario === "approve" ||
										scenario === "borrowed-approve" ||
										scenario === "hung-observer" ||
										scenario === "extension-error"
									? "Trust (this session only)"
									: "Do not trust (this session only)",
					});
				await endPromise;
				if (scenario === "extension-error") {
					await assert.doesNotReject(client.waitForInteractiveEngineResources());
					await modelsAnswer;
					const extensionError = inboundMessages.find(
						({ message }) => message.type === "extension_error" && message.extensionPath === brokenExtension,
					);
					const modelsResponse = inboundMessages.find(
						({ message }) => message.type === "response" && message.command === "get_available_models",
					);
					assert.ok(extensionError, "expected the named startup extension_error on the wire");
					assert.ok(modelsResponse, "expected the get_available_models response on the wire");
					assert.ok(
						extensionError.sequence < modelsResponse.sequence,
						"startup extension_error must arrive before the get_available_models response",
					);
					assert.deepEqual(
						events.filter((event) => event.type === "extension_error"),
						[
							{
								type: "extension_error",
								extensionPath: brokenExtension,
								event: "startup",
								error: "Failed to load extension: startup fixture failure",
							},
						],
					);
					assert.equal(entries().filter((entry) => entry.type === "project_start").length, 1);
					const state = await client.getState();
					assert.ok(
						state.resourceExtensions?.some(
							(extension) => extension.path === join(agentDir, "extensions", "reporter.ts"),
						),
					);
					assert.ok(
						state.resourceExtensions?.some(
							(extension) => extension.path === join(resourceCwd, ".atomic", "extensions", "forbidden.ts"),
						),
					);
					assert.equal(
						state.resourceExtensions?.some((extension) => extension.path === brokenExtension),
						false,
					);
					assert.equal(engineMessages.includes("engine_resources_failed"), false);
					assert.ok(engineMessages.includes("engine_resources_ready"));
				}
				await client.waitForInteractiveEngineResources();
				const trustResolvedIndex = engineMessages.indexOf("engine_project_trust_resolved");
				const resourcesSettledIndex = engineMessages.findIndex(
					(type) => type === "engine_resources_ready" || type === "engine_resources_failed",
				);
				assert.ok(trustResolvedIndex >= 0 && trustResolvedIndex < resourcesSettledIndex);
				const after = entries();
				assert.equal(after.filter((entry) => entry.type === "factory").length, 1);
				assert.equal(
					existsSync(marker),
					scenario !== "deny" && scenario !== "cancel" && scenario !== "borrowed-deny",
				);
				assert.equal(after.filter((entry) => entry.type === "session_start").length, 1);
				assert.equal(after.filter((entry) => entry.type === "session_shutdown").length, 0);
				assert.equal(after.filter((entry) => entry.type === "ui_prompt_start").length, 1);
				assert.equal(after.filter((entry) => entry.type === "ui_prompt_end").length, 1);
				assert.equal(after.find((entry) => entry.type === "ui_prompt_end")?.sessionId, observed.sessionId);
				assert.equal(
					after.some((entry) => entry.type === "forbidden_replay"),
					false,
				);
				assert.equal(after.filter((entry) => entry.type === "trust_hook").length, kind === "select" ? 0 : 1);
				if (!borrowed && scenario !== "deny" && scenario !== "cancel") {
					const state = await client.getState();
					assert.equal(state.model?.id, "project-model");
					assert.equal(state.thinkingLevel, "high");
				}
			} finally {
				await client.stop();
				inboundReader.mockRestore();
				rmSync(root, { recursive: true, force: true });
			}
		},
		REAL_STARTUP_RPC_TIMEOUT_MS,
	);
}

// The interactive host copies this report into its own settings and warns when it says untrusted, so a report made
// while the engine is still deciding showed a trusted project as untrusted. A saved "Trust" that no project_trust hook
// can overturn is reported trusted and pending until startup has decided: the host keeps the project loaded, once.
test(
	"isolated startup reports no project trust decision until the engine decides, and a saved trust no hook could decline stays trusted",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-startup-rpc-pending-"));
		const cwd = join(root, "project");
		const source = join(root, "borrowed");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		writeFileSync(join(cwd, ".atomic", "settings.json"), "{}");
		// The -e source's own trust question holds the startup decision open; no extension handles project_trust.
		mkdirSync(join(source, ".atomic", "extensions"), { recursive: true });
		mkdirSync(join(source, "extensions"), { recursive: true });
		writeFileSync(join(source, "extensions", "authorized.ts"), "export default function() {}");
		writeFileSync(join(source, ".atomic", "extensions", "borrowed.ts"), "export default function() {}");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [realpathSync(cwd)]: true }));
		const client = new RpcClient({
			cliPath,
			cwd,
			runtimeExecutable: bunExecutable(),
			args: ["--no-session", "--offline", "--no-skills", "--no-themes", "--no-prompt-templates", "-e", source],
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
			interactiveEngine: { onDiagnostic: () => {} },
		});
		const holding = holdTrustQuestion(client, (request) => request.title.startsWith("Trust extension source?"));
		try {
			await client.start();
			const request = await holding;
			const pending = await client.getState();
			assert.equal(pending.projectTrusted, true);
			assert.equal(pending.projectTrustPending, true);
			await client.respondExtensionUI({ type: "extension_ui_response", id: request.id, value: "Do not trust" });
			await client.waitForInteractiveEngineResources();
			assert.equal((await client.getState()).projectTrusted, true);
		} finally {
			await client.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_STARTUP_RPC_TIMEOUT_MS,
);

// Each source of project resources follows its own decision: a project already decided (or with nothing to decide) keeps
// its resources loaded while an -e source's own question is still open, without unloading and reloading them (#5693).
for (const scenario of ["saved trust approved by a hook", "no trust inputs"] as const) {
	test(
		`an isolated host keeps a decided project's resources while an -e source is still asked about: ${scenario} (#5693)`,
		async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-startup-rpc-own-decision-"));
			const cwd = join(root, "project");
			const source = join(root, "borrowed");
			const agentDir = join(root, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			if (scenario === "saved trust approved by a hook") {
				mkdirSync(join(cwd, ".atomic"), { recursive: true });
				writeFileSync(join(cwd, ".atomic", "settings.json"), "{}");
				writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [realpathSync(cwd)]: true }));
				const project = [cwd, realpathSync(cwd)];
				// The policy approves the project once the test releases it, and leaves every other path to its own question.
				writeFileSync(
					join(agentDir, "extensions", "policy.ts"),
					`
					export default function(pi) {
						pi.on('project_trust', async (event, ctx) => {
							if (!${JSON.stringify(project)}.includes(event.cwd)) return { trusted: 'undecided' };
							await ctx.ui.confirm('Policy check', 'Continue?');
							return { trusted: 'yes' };
						});
					}
				`,
				);
			}
			mkdirSync(join(source, ".atomic", "extensions"), { recursive: true });
			mkdirSync(join(source, "extensions"), { recursive: true });
			writeFileSync(join(source, "extensions", "authorized.ts"), "export default function() {}");
			writeFileSync(join(source, ".atomic", "extensions", "borrowed.ts"), "export default function() {}");
			const client = new RpcClient({
				cliPath,
				cwd,
				runtimeExecutable: bunExecutable(),
				args: ["--no-session", "--offline", "--no-skills", "--no-themes", "--no-prompt-templates", "-e", source],
				env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
				interactiveEngine: { onDiagnostic: () => {} },
			});
			const policy = holdTrustQuestion(client, (request) => request.method === "confirm");
			const holding = holdTrustQuestion(client, (request) => request.title.startsWith("Trust extension source?"));
			const harness = await createHarness({ cwd, sessionManager: SessionManager.inMemory(cwd) });
			const { modelRuntime, settingsManager, resourceLoader } = harness.session;
			// The host's own lookup: the saved "Trust", or a project with nothing that needs trust.
			settingsManager.setProjectTrusted(true);
			const reload = vi.spyOn(resourceLoader, "reload");
			const unusedFactory = async () => {
				throw new Error("unexpected session switch");
			};
			const local = new AgentSessionRuntime(
				harness.session,
				{ cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] },
				unusedFactory,
			);
			const runtime = new IsolatedInteractiveRuntime(local, unusedFactory, client);
			try {
				await client.start();
				let reloadsBeforeDecision = 0;
				if (scenario === "saved trust approved by a hook") {
					// The host binds while the policy still decides: the project waits, as it may still be declined.
					const check = await policy;
					await runtime.initializeFromEngine();
					assert.equal(settingsManager.isProjectTrusted(), false);
					reloadsBeforeDecision = reload.mock.calls.length;
					await client.respondExtensionUI({ type: "extension_ui_response", id: check.id, confirmed: true });
				} else {
					await runtime.initializeFromEngine();
				}
				// While the source is asked about, the engine's other requests wait for its resources, so only the project's
				// own decision can bring the host up to date: it must not wait for the source's answer.
				const request = await holding;
				await vi.waitFor(
					() => assert.equal(settingsManager.isProjectTrusted(), true, "the host held back the decided project"),
					{ timeout: 10_000 },
				);
				assert.equal(
					reload.mock.calls.length,
					scenario === "no trust inputs" ? 0 : reloadsBeforeDecision + 1,
					"the host reloaded the project's resources more than its decision needs",
				);
				assert.equal(runtime.isProjectTrustPending(), true);

				const reloadsWhilePending = reload.mock.calls.length;
				await client.respondExtensionUI({ type: "extension_ui_response", id: request.id, value: "Do not trust" });
				await client.waitForInteractiveEngineResources();
				await runtime.initializeFromEngine();
				assert.equal(settingsManager.isProjectTrusted(), true);
				assert.equal(reload.mock.calls.length, reloadsWhilePending);
				assert.equal(runtime.isProjectTrustPending(), false);
			} finally {
				await runtime.dispose();
				await harness.cleanup();
				rmSync(root, { recursive: true, force: true });
			}
		},
		REAL_STARTUP_RPC_TIMEOUT_MS,
	);
}

/** A saved "Trust" with a project_trust hook that holds its answer until the test releases it, then declines. */
function decliningHookFixture(prefix: string) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(join(cwd, ".atomic", "prompts"), { recursive: true });
	writeFileSync(join(cwd, ".atomic", "settings.json"), "{}");
	writeFileSync(join(cwd, ".atomic", "prompts", "projprompt.md"), "---\ndescription: project prompt\n---\nbody\n");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [realpathSync(cwd)]: true }));
	writeFileSync(
		join(agentDir, "extensions", "policy.ts"),
		`
			export default function(pi) {
				pi.on('project_trust', async (_event, ctx) => {
					await ctx.ui.confirm('Policy check', 'Continue?');
					return { trusted: 'no' };
				});
			}
		`,
	);
	const client = new RpcClient({
		cliPath,
		cwd,
		runtimeExecutable: bunExecutable(),
		args: ["--no-session", "--offline", "--no-skills", "--no-themes"],
		env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
		interactiveEngine: { onDiagnostic: () => {} },
	});
	const holding = holdTrustQuestion(client, (request) => request.method === "confirm");
	return { root, cwd, agentDir, client, holding };
}

// A project_trust hook can overturn a saved "Trust", so the decision is still open: the project's resources must not
// load before it is made, and the host must not warn either (#5693).
test(
	"a saved trust that a project_trust hook can still decline is reported untrusted and pending until it decides (#5693)",
	async () => {
		const { root, client, holding } = decliningHookFixture("atomic-startup-rpc-hook-");
		try {
			await client.start();
			const request = await holding;
			const pending = await client.getState();
			assert.equal(pending.projectTrusted, false);
			assert.equal(pending.projectTrustPending, true);
			await client.respondExtensionUI({ type: "extension_ui_response", id: request.id, confirmed: true });
			await client.waitForInteractiveEngineResources();
			const decided = await client.getState();
			assert.equal(decided.projectTrusted, false);
			assert.equal(decided.projectTrustPending, undefined);
		} finally {
			await client.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_STARTUP_RPC_TIMEOUT_MS,
);

// The interactive host itself: while the hook decides, it loads none of the project's resources (it did before #5475,
// whose host kept the saved "Trust" it looked up until the engine decided), and it shows no warning yet (#5693).
test(
	"an isolated host loads no project resources while a project_trust hook can still decline the saved trust (#5693)",
	async () => {
		const { root, cwd, agentDir, client, holding } = decliningHookFixture("atomic-startup-rpc-hook-host-");
		const harness = await createHarness({ cwd, sessionManager: SessionManager.inMemory(cwd) });
		const { modelRuntime, settingsManager, resourceLoader } = harness.session;
		// The host's own lookup: the saved "Trust".
		settingsManager.setProjectTrusted(true);
		const reload = vi.spyOn(resourceLoader, "reload");
		const unusedFactory = async () => {
			throw new Error("unexpected session switch");
		};
		const local = new AgentSessionRuntime(
			harness.session,
			{ cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] },
			unusedFactory,
		);
		const runtime = new IsolatedInteractiveRuntime(local, unusedFactory, client);
		try {
			await client.start();
			const request = await holding;
			await runtime.initializeFromEngine();
			assert.equal(
				settingsManager.isProjectTrusted(),
				false,
				"the host trusted the project before the hook decided",
			);
			assert.ok(reload.mock.calls.length > 0, "the host kept the project's resources loaded");
			assert.equal(runtime.isProjectTrustPending(), true, "the host treated the open decision as made");

			await client.respondExtensionUI({ type: "extension_ui_response", id: request.id, confirmed: true });
			await client.waitForInteractiveEngineResources();
			await runtime.initializeFromEngine();
			assert.equal(settingsManager.isProjectTrusted(), false);
			assert.equal(runtime.isProjectTrustPending(), false);
		} finally {
			await runtime.dispose();
			await harness.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_STARTUP_RPC_TIMEOUT_MS,
);

// The interactive host restarts a dead engine for the same session; it must not ask again about a folder it was
// answered for, and an answer for this session only must stay out of trust.json.
test(
	"a restarted engine keeps a session-only trust answer without asking again or saving it",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-startup-rpc-restart-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		writeFileSync(join(cwd, ".atomic", "settings.json"), "{}");
		mkdirSync(agentDir, { recursive: true });
		const client = new RpcClient({
			cliPath,
			cwd,
			runtimeExecutable: bunExecutable(),
			args: ["--no-session", "--offline", "--no-skills", "--no-themes", "--no-prompt-templates"],
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
			interactiveEngine: { onDiagnostic: () => {} },
		});
		const asked = answerTrustQuestions(client, "Trust project folder?");
		try {
			await client.start();
			await client.waitForInteractiveEngineResources();
			const answered = await client.getState();
			assert.equal(answered.projectTrusted, true);

			await client.restart(undefined, { cwd, trustDecisions: answered.trustDecisions });
			await client.waitForInteractiveEngineResources();

			assert.equal(asked.length, 1, "asked again after the restart");
			assert.equal((await client.getState()).projectTrusted, true);
			assert.equal(existsSync(join(agentDir, "trust.json")), false);
		} finally {
			await client.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_STARTUP_RPC_TIMEOUT_MS,
);

// The same holds for the question about an -e extension source's own .atomic resources.
test(
	"a restarted engine keeps a session-only answer for an -e extension source",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-startup-rpc-restart-source-"));
		const cwd = join(root, "project");
		const source = join(root, "borrowed");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(source, ".atomic", "extensions"), { recursive: true });
		mkdirSync(join(source, "extensions"), { recursive: true });
		writeFileSync(join(source, "extensions", "authorized.ts"), "export default function() {}");
		writeFileSync(join(source, ".atomic", "extensions", "borrowed.ts"), "export default function() {}");
		mkdirSync(agentDir, { recursive: true });
		const client = new RpcClient({
			cliPath,
			cwd,
			runtimeExecutable: bunExecutable(),
			args: ["--no-session", "--offline", "--no-skills", "--no-themes", "--no-prompt-templates", "-e", source],
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
			interactiveEngine: { onDiagnostic: () => {} },
		});
		const asked = answerTrustQuestions(client, "Trust extension source?");
		try {
			await client.start();
			await client.waitForInteractiveEngineResources();
			assert.equal(asked.length, 1);
			const answered = await client.getState();

			await client.restart(undefined, { cwd, trustDecisions: answered.trustDecisions });
			await client.waitForInteractiveEngineResources();

			assert.equal(asked.length, 1, "asked again after the restart");
			assert.ok(
				(await client.getState()).resourceExtensions?.some(
					(extension) => extension.path === join(source, ".atomic", "extensions", "borrowed.ts"),
				),
			);
			assert.equal(existsSync(join(agentDir, "trust.json")), false);
		} finally {
			await client.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_STARTUP_RPC_TIMEOUT_MS,
);

test(
	"restarting during a trust question asks again only about the unanswered source (#5568)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-pending-trust-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		writeFileSync(join(cwd, ".atomic", "settings.json"), "{}");
		const sources = [join(root, "one"), join(root, "two")];
		for (const source of sources) {
			mkdirSync(join(source, ".atomic", "extensions"), { recursive: true });
			writeFileSync(join(source, ".atomic", "extensions", "borrowed.ts"), "export default function() {}");
			mkdirSync(join(source, "extensions"));
			writeFileSync(join(source, "extensions", "authorized.ts"), "export default function() {}");
		}
		const client = new RpcClient({
			cliPath,
			cwd,
			runtimeExecutable: bunExecutable(),
			args: ["--no-session", "--offline", ...sources.flatMap((source) => ["-e", source])],
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
			interactiveEngine: { onDiagnostic: () => {} },
		});
		const harness = await createHarness({ cwd, sessionManager: SessionManager.inMemory(cwd) });
		const { modelRuntime, settingsManager, resourceLoader } = harness.session;
		const unusedFactory = async () => {
			throw new Error("unexpected session switch");
		};
		const local = new AgentSessionRuntime(
			harness.session,
			{ cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] },
			unusedFactory,
		);
		const runtime = new IsolatedInteractiveRuntime(local, unusedFactory, client);
		const asked: string[] = [];
		const pending = Promise.withResolvers<void>();
		client.onExtensionUIRequest((request) => {
			if (request.method !== "select") return;
			asked.push(request.title);
			if (asked.length === 3) {
				pending.resolve();
				return;
			}
			void client.respondExtensionUI({
				type: "extension_ui_response",
				id: request.id,
				value: request.title.startsWith("Trust project folder?")
					? "Do not trust (this session only)"
					: "Trust (this session only)",
			});
		});
		try {
			await client.start();
			await pending.promise;
			await runtime.terminateAndRecover();
			await runtime.waitUntilResourcesReady();
			assert.deepEqual(asked.slice(3), [asked[2]]);
			assert.equal((await client.getState()).projectTrusted, false);
			assert.equal(existsSync(join(agentDir, "trust.json")), false);
		} finally {
			await runtime.dispose();
			await harness.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_STARTUP_RPC_TIMEOUT_MS,
);

// A decision that cannot be saved still ends the deciding: the session runs untrusted and says so.
test(
	"a trust decision that cannot be saved leaves the engine reporting the project untrusted",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-startup-rpc-unsaved-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		writeFileSync(join(cwd, ".atomic", "settings.json"), "{}");
		// trust.json that cannot be written.
		mkdirSync(join(agentDir, "trust.json"), { recursive: true });
		const client = new RpcClient({
			cliPath,
			cwd,
			runtimeExecutable: bunExecutable(),
			args: ["--no-session", "--offline", "--no-skills", "--no-themes", "--no-prompt-templates"],
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
			interactiveEngine: { onDiagnostic: () => {} },
		});
		const asked = answerTrustQuestions(client, "Trust project folder?", "Trust");
		try {
			await client.start();
			await client.waitForInteractiveEngineResources().catch(() => {});
			assert.equal(asked.length, 1);
			await vi.waitFor(async () => assert.equal((await client.getState()).projectTrusted, false), {
				timeout: 10_000,
			});
		} finally {
			await client.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_STARTUP_RPC_TIMEOUT_MS,
);

// The decisions are internal to the interactive engine child; a plain RPC client gets the trust of its session only.
test(
	"plain RPC get_state reports the project trust but not the session's trust decisions",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-startup-rpc-plain-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		writeFileSync(join(cwd, ".atomic", "settings.json"), "{}");
		mkdirSync(agentDir, { recursive: true });
		const client = new RpcClient({
			cliPath,
			cwd,
			runtimeExecutable: bunExecutable(),
			args: ["--no-session", "--offline", "--no-skills", "--no-themes", "--no-prompt-templates"],
			env: { ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: "" },
		});
		try {
			await client.start();
			const state = await client.getState();
			assert.equal(state.projectTrusted, false);
			assert.equal(state.trustDecisions, undefined);
		} finally {
			await client.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_STARTUP_RPC_TIMEOUT_MS,
);

/** Resolves with the first extension UI request `matches` accepts, leaving it unanswered. */
function holdTrustQuestion(
	client: RpcClient,
	matches: (request: RpcExtensionUIRequest) => boolean,
): Promise<RpcExtensionUIRequest> {
	const held = Promise.withResolvers<RpcExtensionUIRequest>();
	client.onExtensionUIRequest((request) => {
		if (matches(request)) held.resolve(request);
	});
	return held.promise;
}

/** Answers each trust question whose title starts with `title`, and records it. */
function answerTrustQuestions(
	client: RpcClient,
	title: string,
	answer = "Trust (this session only)",
): RpcExtensionUIRequest[] {
	const asked: RpcExtensionUIRequest[] = [];
	client.onExtensionUIRequest((request) => {
		if (request.method !== "select" || !request.title.startsWith(title)) return;
		asked.push(request);
		void client.respondExtensionUI({ type: "extension_ui_response", id: request.id, value: answer });
	});
	return asked;
}
