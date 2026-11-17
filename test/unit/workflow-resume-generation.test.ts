import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeAll, describe, test } from "vitest";
import { bindExtensionContextPublication } from "../../packages/coding-agent/src/core/extensions/runner-context.js";
import type { WorkflowRunControl } from "../../packages/coding-agent/src/core/extensions/workflow-run-control.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { adoptWorkflowSessionRunState } from "../../packages/workflows/src/extension/adopt-session-run-state.js";
import workflowFactory from "../../packages/workflows/src/extension/extension-factory.js";
import type {
	ExtensionAPI,
	PiCommandContext,
	PiEventContext,
} from "../../packages/workflows/src/extension/public-types.js";
import { definitionDigest } from "../../packages/workflows/src/workers/definitions.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend, configureTestStoreBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

type SessionHandler = Parameters<NonNullable<ExtensionAPI["on"]>>[1];

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const tempRoots: string[] = [];

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(async () => {
	configureCurrentTestStoreBackend(undefined);
	process.chdir(originalCwd);
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createIsolatedProject(label: string) {
	const root = await mkdtemp(join(tmpdir(), `atomic-${label}-`));
	tempRoots.push(root);
	const projectDir = join(root, "project");
	const homeDir = join(root, "home");
	const agentDir = join(homeDir, ".atomic", "agent");
	const workflowPath = join(projectDir, ".atomic", "workflows", "sample-resume-wf.ts");
	const workerPath = join(projectDir, "worker-entry.ts");
	await mkdir(dirname(workflowPath), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		workflowPath,
		[
			`import { workflow } from "@bastani/atomic/workflows";`,
			`import { Type } from "typebox";`,
			`export default workflow({`,
			`  name: "sample-resume-wf",`,
			`  description: "Sample workflow for resume generation handoff",`,
			`  inputs: {},`,
			`  outputs: { step: Type.String() },`,
			`  run: async (ctx) => {`,
			`    const step = await ctx.tool("step", {}, async () => "ok");`,
			`    return { step: String(step) };`,
			`  },`,
			`});`,
		].join("\n"),
		"utf8",
	);
	await writeFile(workerPath, "export default { version: 1 };\n", "utf8");
	const initialDigest = await definitionDigest(workerPath);
	await writeFile(workerPath, "export default { version: 2 };\n", "utf8");

	process.chdir(projectDir);
	process.env.HOME = homeDir;
	process.env.USERPROFILE = homeDir;
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;

	const backend = await createMemoryTestBackend();
	const runId = testRunId("resume-generation");
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "sample-resume-wf",
		inputs: {},
		createdAt: 1_000,
		updatedAt: 2_000,
		status: "paused",
		completedCheckpoints: 1,
		invocationCwd: projectDir,
		resources: {
			definitions: [{ path: workerPath, exportName: "default", digest: initialDigest }],
		},
	});

	return { projectDir, backend, runId };
}

function registerExtensionGeneration(scope: object) {
	const handlers = new Map<string, SessionHandler[]>();
	const commitEffects: Array<() => void | Promise<void>> = [];
	const commands = new Map<string, { handler: (args: string, ctx: PiCommandContext) => void | Promise<void> }>();
	let runControl: WorkflowRunControl | undefined;
	const pi: ExtensionAPI = {
		lifecycleScope: scope,
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerWorkflowRunControl(control) {
			runControl = control;
			return { dispose() {} };
		},
	};
	workflowFactory(pi);
	return {
		pi,
		async resumeFromPicker(target: string, ctx: PiCommandContext): Promise<void> {
			assert.ok(runControl?.resumeFromPicker, "workflowFactory must register resumeFromPicker");
			await Reflect.apply(runControl.resumeFromPicker, runControl, [target, ctx]);
		},
		async runWorkflowCommand(args: string, ctx: PiCommandContext): Promise<void> {
			const command = commands.get("workflow");
			assert.ok(command, "workflowFactory must register workflow command");
			await command.handler(args, ctx);
		},
		async emit(event: string, payload: { readonly reason: string }, ctx?: PiEventContext): Promise<void> {
			if (payload.reason === "reload" && event === "session_start" && ctx) {
				bindExtensionContextPublication(ctx, (effect) => commitEffects.push(effect));
			}
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
		async commit(): Promise<void> {
			for (const effect of commitEffects.splice(0)) {
				await effect();
			}
		},
	};
}

describe("workflow resume provider generation lifetime through extension factory (#5256)", () => {
	test("cancels a pending changed-definition confirmation when /reload commits a replacement generation, while the replacement generation can still resume", async () => {
		const { projectDir, backend, runId } = await createIsolatedProject("resume-gen-reload");
		const scope = {};
		const runState = adoptWorkflowSessionRunState(scope, true);
		configureCurrentTestStoreBackend(backend);
		configureTestStoreBackend(runState.store, backend);

		const ownerLifetime = new AbortController();
		const firstGen = registerExtensionGeneration(scope);
		const firstHostCtx: PiEventContext = {
			cwd: projectDir,
			hasUI: true,
			isProjectTrusted: () => true,
			sessionSignal: ownerLifetime.signal,
			getCurrentSessionSignal: () => ownerLifetime.signal,
			ui: { notify: () => undefined },
		};
		await firstGen.emit("session_start", { reason: "startup" }, firstHostCtx);

		let confirmComponent: { handleInput?: (data: string) => boolean } | undefined;
		let resolvePromptOpen!: () => void;
		const promptOpened = new Promise<void>((resolve) => {
			resolvePromptOpen = resolve;
		});
		let finishCustom!: () => void;
		const customGate = new Promise<void>((resolve) => {
			finishCustom = resolve;
		});

		const firstCommandCtx: PiCommandContext = {
			hasUI: true,
			cwd: projectDir,
			ui: {
				notify: () => undefined,
				custom: async (factory) => {
					let settledValue: boolean | undefined;
					confirmComponent = await factory(
						{} as never,
						{} as never,
						new KeybindingsManager() as never,
						(value) => {
							settledValue = value === true;
							finishCustom();
						},
					);
					resolvePromptOpen();
					await customGate;
					return settledValue;
				},
			},
		};
		const resumeAttempt = firstGen.resumeFromPicker(runId, firstCommandCtx);

		await promptOpened;
		assert.ok(confirmComponent, "changed-definition confirmation must mount before reload");

		const secondGen = registerExtensionGeneration(scope);
		const secondHostCtx: PiEventContext = {
			cwd: projectDir,
			hasUI: true,
			isProjectTrusted: () => true,
			sessionSignal: ownerLifetime.signal,
			getCurrentSessionSignal: () => ownerLifetime.signal,
			ui: { notify: () => undefined },
		};
		await secondGen.emit("session_start", { reason: "reload" }, secondHostCtx);
		await secondGen.commit();
		await firstGen.emit("session_shutdown", { reason: "reload" });

		confirmComponent.handleInput?.("\r");
		finishCustom();
		await resumeAttempt;

		assert.equal(
			backend.getWorkflow(runId)?.status,
			"paused",
			"accepting on a generation replaced by /reload must not resume the workflow",
		);

		const secondCommandCtx: PiCommandContext = {
			hasUI: true,
			cwd: projectDir,
			ui: {
				notify: () => undefined,
				custom: async (factory) => {
					let settledValue: boolean | undefined;
					const component = await factory({} as never, {} as never, new KeybindingsManager() as never, (value) => {
						settledValue = value === true;
					});
					component.handleInput?.("\r");
					return settledValue;
				},
			},
		};
		await secondGen.resumeFromPicker(runId, secondCommandCtx);

		const deadline = Date.now() + 10_000;
		while (backend.getWorkflow(runId)?.status !== "completed" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(
			backend.getWorkflow(runId)?.status,
			"completed",
			"the committed replacement generation must resume and complete the workflow",
		);
	});

	test("cancels a pending changed-definition confirmation when the owner session shuts down even without a replacement generation", async () => {
		const { projectDir, backend, runId } = await createIsolatedProject("resume-gen-shutdown");
		const scope = {};
		const runState = adoptWorkflowSessionRunState(scope, true);
		configureCurrentTestStoreBackend(backend);
		configureTestStoreBackend(runState.store, backend);

		const ownerLifetime = new AbortController();
		const callerLifetime = new AbortController();
		const generation = registerExtensionGeneration(scope);
		const hostCtx: PiEventContext = {
			cwd: projectDir,
			hasUI: true,
			isProjectTrusted: () => true,
			sessionSignal: ownerLifetime.signal,
			getCurrentSessionSignal: () => ownerLifetime.signal,
			ui: { notify: () => undefined },
		};
		await generation.emit("session_start", { reason: "startup" }, hostCtx);

		let confirmComponent: { handleInput?: (data: string) => boolean } | undefined;
		let resolvePromptOpen!: () => void;
		const promptOpened = new Promise<void>((resolve) => {
			resolvePromptOpen = resolve;
		});
		let finishCustom!: () => void;
		const customGate = new Promise<void>((resolve) => {
			finishCustom = resolve;
		});

		const shutdownCommandCtx: PiCommandContext = {
			hasUI: true,
			cwd: projectDir,
			sessionSignal: callerLifetime.signal,
			getCurrentSessionSignal: () => callerLifetime.signal,
			ui: {
				notify: () => undefined,
				custom: async (factory) => {
					let settledValue: boolean | undefined;
					confirmComponent = await factory(
						{} as never,
						{} as never,
						new KeybindingsManager() as never,
						(value) => {
							settledValue = value === true;
							finishCustom();
						},
					);
					resolvePromptOpen();
					await customGate;
					return settledValue;
				},
			},
		};
		const resumeAttempt = generation.resumeFromPicker(runId, shutdownCommandCtx);

		await promptOpened;
		assert.ok(confirmComponent, "changed-definition confirmation must mount before shutdown");

		ownerLifetime.abort();
		await generation.emit("session_shutdown", { reason: "quit" });

		confirmComponent.handleInput?.("\r");
		finishCustom();
		await resumeAttempt;

		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(
			backend.getWorkflow(runId)?.status,
			"paused",
			"accepting after the owner session shuts down must not resume the workflow",
		);
	});

	test("cancels a pending slash-command resume confirmation when /reload commits a replacement generation (#5256)", async () => {
		const { projectDir, backend, runId } = await createIsolatedProject("resume-cmd-gen-reload");
		const scope = {};
		const runState = adoptWorkflowSessionRunState(scope, true);
		configureCurrentTestStoreBackend(backend);
		configureTestStoreBackend(runState.store, backend);

		const ownerLifetime = new AbortController();
		const firstGen = registerExtensionGeneration(scope);
		const firstHostCtx: PiEventContext = {
			cwd: projectDir,
			hasUI: true,
			isProjectTrusted: () => true,
			sessionSignal: ownerLifetime.signal,
			getCurrentSessionSignal: () => ownerLifetime.signal,
			ui: { notify: () => undefined },
		};
		await firstGen.emit("session_start", { reason: "startup" }, firstHostCtx);

		let confirmComponent: { handleInput?: (data: string) => boolean } | undefined;
		let resolvePromptOpen!: () => void;
		const promptOpened = new Promise<void>((resolve) => {
			resolvePromptOpen = resolve;
		});
		let finishCustom!: () => void;
		const customGate = new Promise<void>((resolve) => {
			finishCustom = resolve;
		});

		const firstCommandCtx: PiCommandContext = {
			hasUI: true,
			cwd: projectDir,
			ui: {
				notify: () => undefined,
				custom: async (factory) => {
					let settledValue: boolean | undefined;
					confirmComponent = await factory(
						{} as never,
						{} as never,
						new KeybindingsManager() as never,
						(value) => {
							settledValue = value === true;
							finishCustom();
						},
					);
					resolvePromptOpen();
					await customGate;
					return settledValue;
				},
			},
		};
		const resumeAttempt = firstGen.runWorkflowCommand(`resume ${runId}`, firstCommandCtx);

		await promptOpened;
		assert.ok(confirmComponent, "changed-definition confirmation must mount before reload");

		const secondGen = registerExtensionGeneration(scope);
		const secondHostCtx: PiEventContext = {
			cwd: projectDir,
			hasUI: true,
			isProjectTrusted: () => true,
			sessionSignal: ownerLifetime.signal,
			getCurrentSessionSignal: () => ownerLifetime.signal,
			ui: { notify: () => undefined },
		};
		await secondGen.emit("session_start", { reason: "reload" }, secondHostCtx);
		await secondGen.commit();
		await firstGen.emit("session_shutdown", { reason: "reload" });

		confirmComponent.handleInput?.("\r");
		finishCustom();
		await resumeAttempt;

		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(
			backend.getWorkflow(runId)?.status,
			"paused",
			"accepting a slash-command confirmation on a replaced generation must not resume the workflow",
		);
	});
});
