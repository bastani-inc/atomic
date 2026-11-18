/**
 * The isolated interactive engine reports an extension whose `session_start` throws and keeps its session: the error
 * reaches the host once as an `extension_error`, and the session still answers prompts. Before, the engine's bind
 * rejected with `ExtensionStartupError` and the engine exited, or its deferred resources failed and every prompt was
 * held (#5501).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import type { ExtensionError } from "../src/core/extensions/index.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { EngineCustomUiService } from "../src/modes/interactive-engine/engine-custom-ui.js";
import { RpcSessionBinding } from "../src/modes/rpc/rpc-session-binding.js";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.js";
import { createHarness, getAssistantTexts, type Harness } from "./suite/harness.js";

let harness: Harness | undefined;
let binding: RpcSessionBinding | undefined;
let root: string | undefined;
let pair: EngineHostPair | undefined;

afterEach(async () => {
	binding?.disposeSubscriptions();
	binding = undefined;
	await harness?.cleanup();
	harness = undefined;
	await pair?.cleanup();
	pair = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

/** The engine side of an interactive session: an RPC binding with the engine's custom UI service. */
function engineBinding(session: Harness["session"], output: (record: object) => void): RpcSessionBinding {
	const runtime = new AgentSessionRuntime(
		session,
		{
			cwd: harness!.tempDir,
			agentDir: harness!.tempDir,
			modelRuntime: session.modelRuntime,
			settingsManager: harness!.settingsManager,
			resourceLoader: session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	return new RpcSessionBinding({
		runtimeHost: runtime,
		output,
		pendingExtensionRequests: new Map(),
		requestShutdown: () => {},
		customUi: new EngineCustomUiService(() => {}, new KeybindingsManager()),
	});
}

function extensionErrors(output: object[]): object[] {
	return output.filter((record) => (record as { type?: string }).type === "extension_error");
}

test("the interactive engine keeps its session when an extension throws in session_start and reports it once (#5501)", async () => {
	harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", () => {
					throw new Error("boom in session_start");
				});
			},
		],
	});
	const output: object[] = [];
	binding = engineBinding(harness.session, (record) => output.push(record));

	await binding.rebindSession();

	assert.deepEqual(extensionErrors(output), [
		{ type: "extension_error", extensionPath: "<inline:1>", event: "session_start", error: "boom in session_start" },
	]);
	harness.setResponses([fauxAssistantMessage("still working")]);
	await harness.session.prompt("hello");
	assert.deepEqual(getAssistantTexts(harness), ["still working"]);
});

test("the interactive engine's deferred resource load keeps the extensions whose session_start throws (#5501)", async () => {
	root = mkdtempSync(join(tmpdir(), "atomic-5501-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const marker = join(root, "throw");
	const ran = join(root, "command-ran");
	const extensionPath = join(root, "extension.ts");
	// The minimal startup session binds first; the extension throws once the deferred resource load starts it again.
	writeFileSync(
		extensionPath,
		`import { existsSync, writeFileSync } from "node:fs";
		export default function (pi) {
			pi.on("session_start", () => {
				if (existsSync(${JSON.stringify(marker)})) throw new Error("boom in deferred session_start");
			});
			pi.registerCommand("still-loaded", {
				description: "proves the extension stayed loaded",
				handler: async () => writeFileSync(${JSON.stringify(ran)}, "ran"),
			});
		}`,
	);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		builtinPackagePaths: [],
		additionalExtensionPaths: [extensionPath],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	harness = await createHarness({ resourceLoader: loader });
	const output: object[] = [];
	binding = engineBinding(harness.session, (record) => output.push(record));
	await binding.rebindSession();
	writeFileSync(marker, "");

	await binding.loadDeferredResources();

	assert.deepEqual(extensionErrors(output), [
		{
			type: "extension_error",
			extensionPath,
			event: "session_start",
			error: "boom in deferred session_start",
		},
	]);
	// The extension stays loaded and the session takes input: its command still runs.
	await harness.session.prompt("/still-loaded");
	assert.equal(readFileSync(ran, "utf8"), "ran");
});

test("the isolated host shows an engine startup error that arrived before the host bound its session (#5501)", async () => {
	// An engine that loads its resources eagerly starts its extensions while the host is still starting up.
	pair = await createEngineHostPair({});
	const reported = { extensionPath: "/extensions/throw.ts", event: "session_start", error: "boom in session_start" };
	pair.engineOutput({ type: "extension_error", ...reported });
	await pair.drain();
	const errors: ExtensionError[] = [];

	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {}, onError: (error) => errors.push(error) });

	await vi.waitFor(() => assert.equal(errors.length, 1));
	assert.deepEqual(errors, [reported]);
});
