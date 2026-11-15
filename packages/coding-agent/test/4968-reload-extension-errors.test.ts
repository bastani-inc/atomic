/**
 * An extension that fails to load must be reported after `/reload` and the RPC `reload` command exactly as it is at
 * startup, rather than silently dropping out of the extension list (#4968).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, test } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import type { ExtensionError } from "../src/core/extensions/index.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.js";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.js";
import { renderAll } from "./interactive-mode-status-helpers.js";
import { createShowLoadedResourcesThis } from "./interactive-mode-status-resources-helpers.js";
import { createHarness, type Harness } from "./suite/harness.js";

/**
 * An extension that fails once its `broken` marker exists. Its factory runs on every load, so creating the marker
 * breaks the next reload without depending on the module cache seeing a rewritten file.
 */
function breakableExtension(marker: string): string {
	return `
		import { existsSync } from "node:fs";
		export default function () {
			if (existsSync(${JSON.stringify(marker)})) throw new Error("broken on reload");
		}
	`;
}

let root: string | undefined;
let harness: Harness | undefined;
let pair: EngineHostPair | undefined;

beforeAll(() => {
	initTheme("dark");
});

afterEach(async () => {
	await pair?.cleanup();
	pair = undefined;
	await harness?.cleanup();
	harness = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

/** A real resource loader over one extension file that the test rewrites between loads. */
function createExtensionFixture(source?: string): {
	loader: DefaultResourceLoader;
	extensionPath: string;
	breakExtension: () => void;
} {
	root = mkdtempSync(join(tmpdir(), "atomic-4968-"));
	const marker = join(root, "broken");
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const extensionPath = join(root, "extension.ts");
	writeFileSync(extensionPath, source ?? breakableExtension(marker));
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
	return { loader, extensionPath, breakExtension: () => writeFileSync(marker, "") };
}

/** The diagnostics `/reload` shows on a quiet startup, with each diagnostic as `path: message`. */
function renderReloadDiagnostics(runtimeHost: AgentSessionRuntime | object): string {
	const mode = createShowLoadedResourcesThis({ quietStartup: true, runtimeHost: runtimeHost as AgentSessionRuntime });
	mode.formatDiagnostics = (diagnostics: Array<{ path?: string; message: string }>) =>
		diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n");
	(InteractiveMode as any).prototype.showLoadedResources.call(mode, { force: false, showDiagnosticsWhenQuiet: true });
	// Keep the path's own separators: normalizeRenderedOutput would rewrite a Windows path's backslashes.
	return renderAll(mode.chatContainer, 220)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

const TWICE_REGISTERED_TOOL_EXTENSION = `
	import { Type } from "typebox";
	const tool = (description) => ({
		name: "twice",
		label: "twice",
		description,
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	});
	export default function (pi) {
		pi.registerTool(tool("first"));
		pi.registerTool(tool("second"));
	}
`;

test("the RPC reload command emits extension_error for an extension that no longer loads (#4968)", async () => {
	const { loader, extensionPath, breakExtension } = createExtensionFixture();
	await loader.reload();
	harness = await createHarness({ resourceLoader: loader });
	const session = harness.session;
	const output: object[] = [];
	const handle = createRpcCommandHandler({
		runtimeHost: { session, services: { agentDir: harness.tempDir } } as never,
		getSession: () => session,
		rebindSession: async () => {},
		output: (record) => output.push(record),
	});

	breakExtension();
	const response = await handle({ id: "reload-1", type: "reload" });

	assert.deepEqual(response, { id: "reload-1", type: "response", command: "reload", success: true });
	assert.deepEqual(
		output.filter((record) => (record as { type?: string }).type === "extension_error"),
		[
			{
				type: "extension_error",
				extensionPath,
				event: "reload",
				error: "Failed to load extension: broken on reload",
			},
		],
	);
});

test("interactive /reload shows an extension that no longer loads under [Extension issues] (#4968)", async () => {
	const { loader, extensionPath, breakExtension } = createExtensionFixture();
	await loader.reload();
	pair = await createEngineHostPair({ resourceLoader: loader });
	const hostErrors: ExtensionError[] = [];
	await pair.engine.session.bindExtensions({ shutdownHandler: () => {} });
	await pair.runtime.session.bindExtensions({
		shutdownHandler: () => {},
		onError: (error) => hostErrors.push(error),
	});
	await pair.runtime.initializeFromEngine();

	breakExtension();
	// What `/reload` runs under the isolated interactive runtime, then the diagnostics it shows.
	await pair.runtime.session.reload();
	await pair.drain();

	assert.equal(
		renderReloadDiagnostics(pair.runtime),
		`[Extension issues]\n${extensionPath}: Failed to load extension: broken on reload`,
	);
	// The load error is shown once, with the resource diagnostics, not again as a chat error line.
	assert.deepEqual(hostErrors, []);
});

test("the interactive host leaves engine load errors to its resource diagnostics and still shows runtime errors (#4968)", async () => {
	pair = await createEngineHostPair({});
	const hostErrors: ExtensionError[] = [];
	await pair.runtime.session.bindExtensions({
		shutdownHandler: () => {},
		onError: (error) => hostErrors.push(error),
	});
	const runtimeErrors = [
		{ extensionPath: "session:reload", event: "reload", error: "queued prompt failed after reload" },
		{ extensionPath: "/ext/tool.ts", event: "tool_call", error: "tool failed" },
	];

	pair.engineOutput({ type: "extension_error", extensionPath: "/ext/a.ts", event: "startup", error: "a broke" });
	pair.engineOutput({ type: "extension_error", extensionPath: "/ext/b.ts", event: "reload", error: "b broke" });
	for (const error of runtimeErrors) pair.engineOutput({ type: "extension_error", ...error });
	await pair.drain();

	assert.deepEqual(hostErrors, runtimeErrors);
});

test("an extension that registers one tool name twice gets a warning, and the second registration wins (#4968)", async () => {
	const { loader, extensionPath } = createExtensionFixture(TWICE_REGISTERED_TOOL_EXTENSION);
	await loader.reload();

	const result = loader.getExtensions();
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions[0]?.tools.get("twice")?.definition.description, "second");
	assert.deepEqual(result.warnings, [
		{ path: extensionPath, warning: 'registers tool "twice" more than once; the last registration is used.' },
	]);
});

test("the duplicate-tool warning names every tool an extension registered twice (#4968)", async () => {
	const { loader, extensionPath } = createExtensionFixture(`
		import { Type } from "typebox";
		const tool = (name) => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		});
		export default function (pi) {
			for (const name of ["alpha", "beta", "alpha", "beta", "gamma"]) pi.registerTool(tool(name));
		}
	`);
	await loader.reload();

	assert.deepEqual(loader.getExtensions().warnings, [
		{
			path: extensionPath,
			warning: 'registers tools "alpha", "beta" more than once; the last registration is used.',
		},
	]);
});

test("interactive mode shows the engine's duplicate-tool warning under [Extension issues] (#4968)", async () => {
	const { loader, extensionPath } = createExtensionFixture(TWICE_REGISTERED_TOOL_EXTENSION);
	await loader.reload();
	pair = await createEngineHostPair({ resourceLoader: loader });
	await pair.engine.session.bindExtensions({ shutdownHandler: () => {} });
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });

	await pair.runtime.initializeFromEngine();

	assert.equal(
		renderReloadDiagnostics(pair.runtime),
		`[Extension issues]\n${extensionPath}: registers tool "twice" more than once; the last registration is used.`,
	);
});

test("an engine that reports no load issues, or a session in this process, shows no [Extension issues] (#4968)", async () => {
	harness = await createHarness();
	const local = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	// An older engine's state has no resourceErrors or resourceWarnings.
	const olderEngineState = {
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "engine",
		autoCompactionEnabled: true,
		compaction: { state: "idle" },
		backgroundCompactionEnabled: true,
		backgroundCompactionThresholdPercent: 75,
		messageCount: 0,
		pendingMessageCount: 0,
		queuedMessagesPaused: false,
		resourceExtensions: [],
	};
	const runtime = new IsolatedInteractiveRuntime(
		local,
		async () => {
			throw new Error("unused runtime factory");
		},
		{
			onEvent: () => () => {},
			onGenerationEnded: () => () => {},
			getGeneration: () => 1,
			getState: async () => olderEngineState,
			requestInternal: async () => ({ models: [], scopedModels: [] }),
			getCommands: async () => [],
			getEntries: async () => ({ entries: [], leafId: null }),
			stop: async () => {},
		} as never,
	);
	assert.equal(renderReloadDiagnostics(runtime), "");

	await runtime.synchronize();
	assert.equal(renderReloadDiagnostics(runtime), "");
	assert.equal(renderReloadDiagnostics({}), "");
});
