import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createRuntimeForMode } from "../src/modes/interactive-engine/create-isolated-runtime.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import { INTERACTIVE_ENGINE_PROTOCOL_VERSION } from "../src/modes/interactive-engine/protocol.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

/** The engine child the host starts in these tests: a script run by this Node, written per test. */
const engine = vi.hoisted(() => ({ script: "" }));

vi.mock("../src/modes/interactive-engine/engine-prewarm.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/modes/interactive-engine/engine-prewarm.ts")>();
	return {
		...original,
		interactiveEngineClientOptions: (cwd: string) => ({
			runtimeExecutable: process.execPath,
			runtimeArgs: [],
			cliPath: engine.script,
			cwd,
			env: {},
		}),
	};
});

/** How long a host's runtime creation waits for the engine child it started to say it is running. */
const ENGINE_CHILD_START_MAX_MS = 60_000;

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "engine-early-start-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const sessionManager = await SessionManager.create(root, join(root, "sessions"));
	return { root, agentDir, modelRuntime, sessionManager };
}

/** The host's own runtime, created by `factory` once `beforeReturn` has run. */
function hostRuntimeFactory(
	modelRuntime: ModelRuntime,
	beforeReturn: () => Promise<void>,
): CreateAgentSessionRuntimeFactory {
	return async (options) => {
		const services = await createAgentSessionServices({
			...options,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true },
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			noTools: true,
		});
		await beforeReturn();
		return { ...created, services, diagnostics: services.diagnostics };
	};
}

async function waitFor(condition: () => boolean, maxMs: number): Promise<boolean> {
	const deadline = Date.now() + maxMs;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return true;
}

test("an isolated host starts its engine while it creates its own runtime, and what the engine says meanwhile reaches that runtime", async () => {
	const { root, agentDir, modelRuntime, sessionManager } = await fixture();
	const said = join(root, "engine-said");
	engine.script = join(root, "engine.mjs");
	writeFileSync(
		engine.script,
		`import { writeFileSync } from "node:fs";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
send({ type: "engine_ready", protocolVersion: ${INTERACTIVE_ENGINE_PROTOCOL_VERSION}, pid: process.pid });
send({ type: "engine_trust_decision", scope: "projects", path: ${JSON.stringify(root)}, trusted: true });
send({ type: "engine_bound" });
process.stdout.write("", () => writeFileSync(${JSON.stringify(said)}, String(process.pid)));
process.stdin.resume();
`,
	);
	const inputsFinal = Promise.withResolvers<void>();
	let engineSpokeDuringHostRuntime = false;
	const runtime = await createRuntimeForMode(
		hostRuntimeFactory(modelRuntime, async () => {
			// Everything that decides how the engine starts is settled; the host still has its own runtime to finish.
			inputsFinal.resolve();
			engineSpokeDuringHostRuntime = await waitFor(() => existsSync(said), ENGINE_CHILD_START_MAX_MS);
			// Its lines reach this process before the host's runtime exists.
			if (engineSpokeDuringHostRuntime) await new Promise((resolve) => setTimeout(resolve, 100));
		}),
		root,
		agentDir,
		sessionManager,
		true,
		false,
		parseArgs([]),
		{},
		true,
		undefined,
		inputsFinal.promise,
	);
	try {
		assert.equal(engineSpokeDuringHostRuntime, true);
		assert.ok(runtime instanceof IsolatedInteractiveRuntime);
		await runtime.waitUntilBound();
		assert.deepEqual(runtime.trustDecisions().projects, { [root]: true });
		assert.equal(readFileSync(said, "utf8"), String(runtime.getEnginePid()));
	} finally {
		await runtime.dispose({ fromSignal: true });
	}
}, 120_000);

test("an isolated host whose engine inputs are not final yet starts its engine once its own runtime exists", async () => {
	const { agentDir, root, modelRuntime, sessionManager } = await fixture();
	const start = vi.spyOn(RpcClient.prototype, "start").mockImplementation(() => new Promise(() => {}));
	let startsBeforeRuntime = -1;
	const runtime = await createRuntimeForMode(
		hostRuntimeFactory(modelRuntime, async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			startsBeforeRuntime = start.mock.calls.length;
		}),
		root,
		agentDir,
		sessionManager,
		true,
		false,
		parseArgs([]),
		{},
		true,
		undefined,
		new Promise<void>(() => {}),
	);
	try {
		assert.equal(startsBeforeRuntime, 0);
		assert.equal(start.mock.calls.length, 1);
	} finally {
		await runtime.dispose({ fromSignal: true });
	}
});

test("a host whose own runtime fails after its engine started stops that engine and reports the failure", async () => {
	const { agentDir, root, modelRuntime, sessionManager } = await fixture();
	const start = vi.spyOn(RpcClient.prototype, "start").mockImplementation(() => new Promise(() => {}));
	const stop = vi.spyOn(RpcClient.prototype, "stop");
	const inputsFinal = Promise.withResolvers<void>();
	await assert.rejects(
		createRuntimeForMode(
			hostRuntimeFactory(modelRuntime, async () => {
				inputsFinal.resolve();
				await new Promise((resolve) => setTimeout(resolve, 0));
				assert.equal(start.mock.calls.length, 1);
				throw new Error("host runtime failed");
			}),
			root,
			agentDir,
			sessionManager,
			true,
			false,
			parseArgs([]),
			{},
			true,
			undefined,
			inputsFinal.promise,
		),
		/host runtime failed/,
	);
	assert.equal(stop.mock.calls.length, 1);
});

test("an engine that fails to start before the host's runtime exists fails that runtime's startup", async () => {
	const { agentDir, root, modelRuntime, sessionManager } = await fixture();
	engine.script = join(root, "never-started.mjs");
	const inputsFinal = Promise.withResolvers<void>();
	const runtime: AgentSessionRuntime = await createRuntimeForMode(
		hostRuntimeFactory(modelRuntime, async () => {
			// The engine's start cannot write its bootstrap file: it fails here, before the host's runtime exists.
			const missing = join(root, "missing-temp");
			for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, missing);
			try {
				inputsFinal.resolve();
				await new Promise((resolve) => setTimeout(resolve, 50));
			} finally {
				vi.unstubAllEnvs();
			}
		}),
		root,
		agentDir,
		sessionManager,
		true,
		false,
		parseArgs([]),
		{},
		true,
		undefined,
		inputsFinal.promise,
	);
	try {
		assert.ok(runtime instanceof IsolatedInteractiveRuntime);
		await assert.rejects(runtime.waitUntilBound(), { code: "ENOENT" });
		assert.equal(runtime.getEnginePid(), undefined);
	} finally {
		await runtime.dispose({ fromSignal: true });
	}
});
