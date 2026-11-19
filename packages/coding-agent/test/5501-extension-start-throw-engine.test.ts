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
import { afterEach, expect, test, vi } from "vitest";
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

/**
 * The engine side of an interactive session: an RPC binding with the engine's custom UI service. With
 * `settlesStartupTrust`, its deferred resource load finishes startup in place, as an engine whose startup settles
 * project trust or loads `-e` extensions does.
 */
function engineBinding(
	session: Harness["session"],
	output: (record: object) => void,
	options: { settlesStartupTrust?: boolean } = {},
): RpcSessionBinding {
	const runtime = new AgentSessionRuntime(
		session,
		{
			cwd: harness!.tempDir,
			agentDir: harness!.tempDir,
			modelRuntime: session.modelRuntime,
			settingsManager: harness!.settingsManager,
			resourceLoader: session.resourceLoader,
			diagnostics: [],
			...(options.settlesStartupTrust && {
				completeStartup: () => session.completeStartupResources(session.resourceLoader),
			}),
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

	expect(extensionErrors(output)).toEqual([
		{
			type: "extension_error",
			extensionPath: "<inline:1>",
			event: "session_start",
			error: "boom in session_start",
			stack: expect.stringContaining("boom in session_start"),
		},
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

	expect(extensionErrors(output)).toEqual([
		{
			type: "extension_error",
			extensionPath,
			event: "session_start",
			error: "boom in deferred session_start",
			stack: expect.stringContaining("extension.ts"),
		},
	]);
	// The extension stays loaded and the session takes input: its command still runs.
	await harness.session.prompt("/still-loaded");
	assert.equal(readFileSync(ran, "utf8"), "ran");
});

test("an engine startup that settles project trust reports a resources_discover failure once (#5501)", async () => {
	let discoveries = 0;
	harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("resources_discover", () => {
					discoveries++;
					throw new Error("boom in resources_discover");
				});
			},
		],
	});
	const output: object[] = [];
	binding = engineBinding(harness.session, (record) => output.push(record), { settlesStartupTrust: true });
	await binding.rebindSession();

	await binding.loadDeferredResources();

	// The isolated host shows every record it gets; the engine may finish startup after the host finished its own.
	assert.equal(discoveries, 2, "settling trust discovered the resources again, as documented");
	expect(extensionErrors(output)).toEqual([
		{
			type: "extension_error",
			extensionPath: "<inline:1>",
			event: "resources_discover",
			error: "boom in resources_discover",
			stack: expect.stringContaining("boom in resources_discover"),
		},
	]);
});

test("an engine startup that settles project trust still reports a second discovery that fails differently (#5501)", async () => {
	let discoveries = 0;
	harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("resources_discover", () => {
					discoveries++;
					throw new Error(`boom in discovery ${discoveries}`);
				});
			},
		],
	});
	const output: object[] = [];
	binding = engineBinding(harness.session, (record) => output.push(record), { settlesStartupTrust: true });
	await binding.rebindSession();

	await binding.loadDeferredResources();

	assert.deepEqual(
		extensionErrors(output).map((record) => (record as { error: string }).error),
		["boom in discovery 1", "boom in discovery 2"],
	);
});

test("the isolated host shows an engine startup error that arrived before the host bound its session (#5501)", async () => {
	// An engine that loads its resources eagerly starts its extensions while the host is still starting up.
	pair = await createEngineHostPair({});
	const reported = {
		extensionPath: "/extensions/throw.ts",
		event: "session_start",
		error: "boom in session_start",
		stack: "Error: boom in session_start\n    at firstDirectory (throw.ts:10:2)",
	};
	pair.engineOutput({ type: "extension_error", ...reported });
	await pair.drain();
	const errors: ExtensionError[] = [];

	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {}, onError: (error) => errors.push(error) });

	await vi.waitFor(() => assert.equal(errors.length, 1));
	assert.deepEqual(errors, [reported]);
});
