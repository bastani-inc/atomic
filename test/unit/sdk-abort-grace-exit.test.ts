import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, test } from "vitest";
import {
	bunExecutable,
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	spawnProcess,
} from "../helpers/runtime.js";

/** Budget for spawning a real Node or Bun SDK child process under parallel CI load. */
const CHILD_PROCESS_TIMEOUT_MS = 30_000;
/** Grace window used by the abort-exit child scripts. */
const ABORT_GRACE_MS = 200;
/** Detachment deadline shorter than the abort grace so the detachment timer expires before grace does. */
const SHORT_DETACH_MS = 50;
/** Grace window long enough to distinguish immediate exit from lingering through grace. */
const LINGER_GRACE_MS = 4_000;
/** Maximum acceptable process-exit linger after a script reaches its end with no awaited timer. */
const MAX_EXIT_LINGER_MS = 1_500;
/** Maximum acceptable process-exit linger for the 2 s remote-port frame timer regression test. */
const MAX_REMOTE_PORT_LINGER_MS = 1_000;
/** Large grace window used to prove idle and clean-abort processes do not wait for grace before exiting. */
const LONG_GRACE_MS = 60_000;

const repoRoot = resolve(import.meta.dirname, "../..");
const codingAgentEntryUrl = pathToFileURL(join(repoRoot, "packages/coding-agent/dist/index.js")).href;
const aiCompatEntryUrl = pathToFileURL(join(repoRoot, "packages/ai/dist/compat.js")).href;
const rpcTerminalDrainUrl = pathToFileURL(
	join(repoRoot, "packages/coding-agent/src/modes/rpc/rpc-terminal-drain.ts"),
).href;
const storageStatusUrl = pathToFileURL(join(repoRoot, "packages/coding-agent/src/core/storage/storage-status.ts")).href;
const toolAbortGraceUrl = pathToFileURL(
	join(repoRoot, "packages/coding-agent/src/core/tools/tool-abort-grace.ts"),
).href;
const taskProjectionUrl = pathToFileURL(join(repoRoot, "test/helpers/task-projection.ts")).href;
const sessionManagerUrl = pathToFileURL(join(repoRoot, "packages/coding-agent/src/core/session-manager.ts")).href;
const taskViewSourceUrl = pathToFileURL(
	join(repoRoot, "packages/coding-agent/src/core/tasks/task-view-source.ts"),
).href;
const taskResumerUrl = pathToFileURL(join(repoRoot, "packages/coding-agent/src/core/tasks/task-resumer.ts")).href;
const worktreeSnapshotsUrl = pathToFileURL(
	join(repoRoot, "packages/coding-agent/src/core/session-worktree-snapshots.ts"),
).href;
const worktreeSnapshotSettingsUrl = pathToFileURL(
	join(repoRoot, "packages/coding-agent/src/core/worktree-snapshot/settings.ts"),
).href;
const remoteComponentUrl = pathToFileURL(
	join(repoRoot, "packages/coding-agent/src/modes/interactive-engine/remote-component.ts"),
).href;
const remotePortUrl = pathToFileURL(
	join(repoRoot, "packages/coding-agent/src/modes/interactive/agent-view/remote-port.ts"),
).href;

// Atomic's sources import `.js` specifiers that name `.ts` files; Bun resolves them, and so does this hook for Node.
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) {
		if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js"))
			return nextResolve(specifier.slice(0, -3) + ".ts", context);
		throw error;
	}
} });`;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) removeTempDirectory(dir);
});

async function runScript(
	runtime: "node" | "bun",
	script: string,
	env: Record<string, string>,
	{ sourceTs = false }: { readonly sourceTs?: boolean } = {},
): Promise<{
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly elapsedMs: number;
	readonly exitedWallMs: number;
}> {
	const dir = makeTempDirectory("atomic-sdk-abort-exit-");
	tempDirs.push(dir);
	const scriptPath = join(dir, sourceTs ? "script.mts" : "script.mjs");
	const prefix = sourceTs && runtime === "node" ? `${RESOLVE_TS_SOURCES}\n` : "";
	writeFileSync(scriptPath, `${prefix}${script}`, "utf8");
	const executable = runtime === "bun" ? bunExecutable() : process.execPath;
	const startedAt = performance.now();
	const child = spawnProcess([executable, scriptPath], {
		cwd: dir,
		env: { ...process.env, ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: CHILD_PROCESS_TIMEOUT_MS,
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		readStreamText(child.stdout),
		readStreamText(child.stderr),
	]);
	return { exitCode, stdout, stderr, elapsedMs: performance.now() - startedAt, exitedWallMs: Date.now() };
}

/** Milliseconds the process lingered after printing `EXIT_AT:<epochMs>` at the end of its script. */
function exitLingerMs(run: {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitedWallMs: number;
}): number {
	const match = /EXIT_AT:(\d+)/.exec(run.stdout);
	assert.ok(match, `expected EXIT_AT marker in stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
	return Math.max(0, run.exitedWallMs - Number(match[1]));
}

function sdkStuckAbortScript(options: {
	readonly runtime: "node" | "bun";
	readonly detachable: boolean;
	readonly mode: "abort-stuck" | "prompt-agent-abort" | "clean-abort" | "idle";
}): string {
	// Node detects an unsettled top-level await with exit code 13; Bun keeps TLA alive while exiting early from an
	// awaited async main() call. Running TLA on Node and async main() on Bun tests the real failure mode on each.
	const wrapBody = (body: string): string =>
		options.runtime === "bun"
			? `async function main() {\n${body}\n}\nmain().catch((error) => { console.error(error); process.exitCode = 1; });`
			: body;

	const body = `
const started = Promise.withResolvers();
const modelRuntime = await ModelRuntime.create({
	credentials: AuthStorage.inMemory({ p: { type: "api_key", key: "x" } }),
	modelsPath: null,
	refreshOnCreate: false,
});
modelRuntime.registerProvider("p", {
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	apiKey: "x",
	models: [spec],
	streamSimple: (model, context) => {
		const lastUser = context.messages.findLastIndex((message) => message.role === "user");
		if (context.messages.slice(lastUser).some((message) => message.role === "toolResult"))
			return reply(model, [{ type: "text", text: "done" }], "stop");
		return reply(model, [{ type: "toolCall", id: "stuck-1", name: "stuck", arguments: {} }], "toolUse");
	},
});

const stuck = {
	name: "stuck",
	label: "stuck",
	description: "A tool call that ignores abort unless clean-abort mode is selected",
	parameters: { type: "object", properties: {} },
	concurrency: "exclusive",
	${options.detachable ? "detachable: true," : ""}
	async execute(_toolCallId, _params, signal) {
		started.resolve();
		if (${JSON.stringify(options.mode)} === "clean-abort") {
			await new Promise((resolve) => {
				if (signal?.aborted) resolve();
				else signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return { content: [{ type: "text", text: "stopped cleanly" }], details: undefined };
		}
		// Never settles and holds no ref'd event-loop handle.
		await new Promise(() => {});
		return { content: [{ type: "text", text: "unreachable" }], details: undefined };
	},
};

const { session } = await createAgentSession({
	cwd: process.cwd(),
	agentDir: process.cwd(),
	builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
	modelRuntime,
	model: modelRuntime.getModel("p", "m"),
	settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
	sessionManager: SessionManager.inMemory(),
	resourceLoader: createTestResourceLoader(),
	customTools: [stuck],
});
${options.detachable ? `session.setToolDetachment({ afterMs: ${SHORT_DETACH_MS} });` : ""}

if (${JSON.stringify(options.mode)} === "idle") {
	// Deliberately do not call session.dispose(): an idle session with no abort pending must let the process exit.
	console.log("IDLE_EXITED");
} else {
	const prompt = session.prompt("go");
	await started.promise;
	if (${JSON.stringify(options.mode)} === "prompt-agent-abort") {
		session.agent.abort();
		await prompt.catch(() => {});
	} else {
		await session.abort();
		await prompt.catch(() => {});
	}
	const result = session.messages.find((message) => message.role === "toolResult");
	const text =
		result && Array.isArray(result.content)
			? result.content.map((part) => part.text ?? "").join("\\n")
			: "";
	await session.dispose();
	console.log("ABORT_SETTLED:" + text);
}
`;

	return `
import { createAssistantMessageEventStream } from ${JSON.stringify(aiCompatEntryUrl)};
import {
	AuthStorage,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	createExtensionRuntime,
} from ${JSON.stringify(codingAgentEntryUrl)};

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1000,
};

function createTestResourceLoader() {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: async () => {},
		reload: async () => {},
	};
}

function reply(model, content, stopReason) {
	const stream = createAssistantMessageEventStream();
	const message = {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: stopReason === "toolUse" ? "toolUse" : "stop", message });
	stream.end(message);
	return stream;
}

${wrapBody(body)}
`;
}

describe("awaited abort-grace and teardown timers keep standalone SDK scripts alive until settled (#5486)", () => {
	for (const runtime of ["node", "bun"] as const) {
		for (const detachable of [false, true] as const) {
			test(
				`${runtime} SDK script awaiting session.abort() against a stuck tool settles and exits 0 (detachable=${detachable}, #5486)`,
				async () => {
					const run = await runScript(runtime, sdkStuckAbortScript({ runtime, detachable, mode: "abort-stuck" }), {
						ATOMIC_TOOL_ABORT_GRACE_MS: String(ABORT_GRACE_MS),
					});
					assert.equal(run.exitCode, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
					assert.match(
						run.stdout,
						/ABORT_SETTLED:Operation aborted: stuck did not stop within 0\.2 seconds/,
						`stderr:\n${run.stderr}\nstdout:\n${run.stdout}`,
					);
				},
				CHILD_PROCESS_TIMEOUT_MS,
			);
		}

		test(
			`${runtime} SDK script awaiting prompt() after agent.abort() against a stuck tool settles and exits 0 (#5486)`,
			async () => {
				const run = await runScript(
					runtime,
					sdkStuckAbortScript({ runtime, detachable: false, mode: "prompt-agent-abort" }),
					{ ATOMIC_TOOL_ABORT_GRACE_MS: String(ABORT_GRACE_MS) },
				);
				assert.equal(run.exitCode, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
				assert.match(
					run.stdout,
					/ABORT_SETTLED:Operation aborted: stuck did not stop within 0\.2 seconds/,
					`stderr:\n${run.stderr}\nstdout:\n${run.stdout}`,
				);
			},
			CHILD_PROCESS_TIMEOUT_MS,
		);

		test(
			`${runtime} idle SDK session and clean abort let the process exit immediately without waiting for grace (#5486)`,
			async () => {
				const idle = await runScript(runtime, sdkStuckAbortScript({ runtime, detachable: false, mode: "idle" }), {
					ATOMIC_TOOL_ABORT_GRACE_MS: String(LONG_GRACE_MS),
				});
				assert.equal(idle.exitCode, 0, `stderr:\n${idle.stderr}\nstdout:\n${idle.stdout}`);
				assert.match(idle.stdout, /IDLE_EXITED/);
				assert.ok(idle.elapsedMs < LONG_GRACE_MS / 2, `idle process exited promptly (${idle.elapsedMs} ms)`);

				const cleanAbort = await runScript(
					runtime,
					sdkStuckAbortScript({ runtime, detachable: true, mode: "clean-abort" }),
					{ ATOMIC_TOOL_ABORT_GRACE_MS: String(LONG_GRACE_MS) },
				);
				assert.equal(cleanAbort.exitCode, 0, `stderr:\n${cleanAbort.stderr}\nstdout:\n${cleanAbort.stdout}`);
				assert.match(cleanAbort.stdout, /ABORT_SETTLED:stopped cleanly/);
				assert.ok(
					cleanAbort.elapsedMs < LONG_GRACE_MS / 2,
					`clean abort exited without waiting for grace (${cleanAbort.elapsedMs} ms)`,
				);
			},
			CHILD_PROCESS_TIMEOUT_MS,
		);
	}

	test(
		"RpcTerminalDrain keeps an awaited drain alive until timeout, while an unawaited idle drain lets the process exit immediately",
		async () => {
			const awaited = await runScript(
				"node",
				`
const { RpcTerminalDrain } = await import(${JSON.stringify(rpcTerminalDrainUrl)});
const drain = new RpcTerminalDrain();
let settledError;
await drain.begin(1, new Promise(() => {}), new Error("child died"), (err) => {
	settledError = err;
}, true);
console.log("DRAIN_SETTLED:" + (settledError?.message ?? "none"));
`,
				{},
				{ sourceTs: true },
			);
			assert.equal(awaited.exitCode, 0, `stderr:\n${awaited.stderr}\nstdout:\n${awaited.stdout}`);
			assert.match(awaited.stdout, /DRAIN_SETTLED:child died/);

			const idle = await runScript(
				"node",
				`
const { RpcTerminalDrain } = await import(${JSON.stringify(rpcTerminalDrainUrl)});
const drain = new RpcTerminalDrain();
void drain.begin(1, new Promise(() => {}), new Error("child died"), () => {
	console.log("SHOULD_NOT_HOLD_IDLE_EXIT");
}, false);
console.log("IDLE_DRAIN_EXITED");
`,
				{},
				{ sourceTs: true },
			);
			assert.equal(idle.exitCode, 0, `stderr:\n${idle.stderr}\nstdout:\n${idle.stdout}`);
			assert.match(idle.stdout, /IDLE_DRAIN_EXITED/);
			assert.doesNotMatch(idle.stdout, /SHOULD_NOT_HOLD_IDLE_EXIT/);

			const joined = await runScript(
				"node",
				`
const { RpcTerminalDrain } = await import(${JSON.stringify(rpcTerminalDrainUrl)});
const drain = new RpcTerminalDrain();
let settledError;
void drain.begin(1, new Promise(() => {}), new Error("child died"), (err) => {
	settledError = err;
}, false);
await drain.begin(1, new Promise(() => {}), new Error("stop"), () => {}, true);
console.log("JOINED_DRAIN_SETTLED:" + (settledError?.message ?? "none"));
`,
				{},
				{ sourceTs: true },
			);
			assert.equal(joined.exitCode, 0, `stderr:\n${joined.stderr}\nstdout:\n${joined.stdout}`);
			assert.match(joined.stdout, /JOINED_DRAIN_SETTLED:child died/);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test(
		"releaseToolAbortGraceTimers unrefs active and subsequent grace timers for a disposed owner even while an observed wait was active",
		async () => {
			const run = await runScript(
				"node",
				`
const { armToolAbortGraceTimer, holdToolAbortGraceWhenObserved, releaseToolAbortGraceTimers } = await import(${JSON.stringify(toolAbortGraceUrl)});
const owner = {};
const held = holdToolAbortGraceWhenObserved(owner, new Promise(() => {}));
// Observe the promise so active timers for owner are promoted to ref'd, then release on disposal.
held.then(() => {});
armToolAbortGraceTimer(owner, ${LONG_GRACE_MS}, () => console.log("SHOULD_NOT_HOLD_EXIT_1"));
releaseToolAbortGraceTimers(owner);
armToolAbortGraceTimer(owner, ${LONG_GRACE_MS}, () => console.log("SHOULD_NOT_HOLD_EXIT_2"));
console.log("RELEASED_GRACE_EXITED");
console.log("EXIT_AT:" + Date.now());
`,
				{},
				{ sourceTs: true },
			);
			assert.equal(run.exitCode, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
			assert.match(run.stdout, /RELEASED_GRACE_EXITED/);
			assert.doesNotMatch(run.stdout, /SHOULD_NOT_HOLD_EXIT/);
			const lingerMs = exitLingerMs(run);
			assert.ok(lingerMs < MAX_EXIT_LINGER_MS, `released grace lingered ${lingerMs} ms`);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test(
		"collectStorageStatus probe timeout keeps a standalone Node script alive until the timeout settles",
		async () => {
			const dir = makeTempDirectory("atomic-storage-status-exit-");
			tempDirs.push(dir);
			const adapterPath = join(dir, "stalled-adapter.mjs");
			writeFileSync(
				adapterPath,
				`export default {
	atomicStorageAdapter: 1,
	openDatabase() { return new Promise(() => {}); },
};
`,
				"utf8",
			);
			const run = await runScript(
				"node",
				`
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { collectStorageStatus } = await import(${JSON.stringify(storageStatusUrl)});
const agentDir = join(${JSON.stringify(dir)}, "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ storage: { adapter: ${JSON.stringify(adapterPath)} } }));
const status = await collectStorageStatus({
	cwd: ${JSON.stringify(dir)},
	agentDir,
	probe: true,
	probeTimeoutMs: 150,
});
const sessions = status.domains.find((domain) => domain.domain === "sessions");
console.log("STATUS_SETTLED:" + sessions?.probe?.connection.status + ":" + sessions?.probe?.connection.detail);
`,
				{
					ATOMIC_STORAGE: "",
					ATOMIC_SESSIONS_STORAGE: "",
					ATOMIC_CODING_AGENT_SESSION_DIR: "",
				},
				{ sourceTs: true },
			);
			assert.equal(run.exitCode, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
			assert.match(run.stdout, /STATUS_SETTLED:failed:.*did not answer within 0\.15 s/);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test(
		"nested tool aborted under a custom signal does not linger past session.dispose() (#5486)",
		async () => {
			const run = await runScript(
				"node",
				`
import { createAssistantMessageEventStream } from ${JSON.stringify(aiCompatEntryUrl)};
import {
	AuthStorage,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	createExtensionRuntime,
} from ${JSON.stringify(codingAgentEntryUrl)};

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1000,
};
const modelRuntime = await ModelRuntime.create({
	credentials: AuthStorage.inMemory({ p: { type: "api_key", key: "x" } }),
	modelsPath: null,
	refreshOnCreate: false,
});
function reply(model, content, stopReason) {
	const stream = createAssistantMessageEventStream();
	const message = {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: stopReason === "toolUse" ? "toolUse" : "stop", message });
	stream.end(message);
	return stream;
}
modelRuntime.registerProvider("p", {
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	apiKey: "x",
	models: [spec],
	streamSimple: (model, context) => {
		const lastUser = context.messages.findLastIndex((message) => message.role === "user");
		if (context.messages.slice(lastUser).some((message) => message.role === "toolResult"))
			return reply(model, [{ type: "text", text: "done" }], "stop");
		return reply(model, [{ type: "toolCall", id: "outer-1", name: "outer", arguments: {} }], "toolUse");
	},
});
const stuckChild = {
	name: "stuck_child",
	label: "stuck_child",
	description: "stuck nested tool",
	parameters: { type: "object", properties: {} },
	async execute() {
		await new Promise(() => {});
		return { content: [], details: undefined };
	},
};
const outer = {
	name: "outer",
	label: "outer",
	description: "calls nested tool with its own signal",
	parameters: { type: "object", properties: {} },
	async execute(_id, _params, _signal, _update, ctx) {
		const local = new AbortController();
		const nested = ctx.executeTool("stuck_child", {}, { signal: local.signal });
		await new Promise((resolve) => setTimeout(resolve, 20));
		local.abort(new Error("local timeout"));
		void nested.catch(() => {});
		return { content: [{ type: "text", text: "outer done" }], details: undefined };
	},
};
const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
const resourceLoader = {
	getExtensions: () => extensionsResult,
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => undefined,
	getSystemPromptSource: () => undefined,
	getAppendSystemPrompt: () => [],
	getAppendSystemPromptSources: () => [],
	extendResources: async () => {},
	reload: async () => {},
};
const { session } = await createAgentSession({
	cwd: process.cwd(),
	agentDir: process.cwd(),
	builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
	modelRuntime,
	model: modelRuntime.getModel("p", "m"),
	settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
	sessionManager: SessionManager.inMemory(),
	resourceLoader,
	customTools: [stuckChild, outer],
});
await session.prompt("go");
await session.dispose();
console.log("EXIT_AT:" + Date.now());
`,
				{ ATOMIC_TOOL_ABORT_GRACE_MS: String(LINGER_GRACE_MS) },
			);
			assert.equal(run.exitCode, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
			const lingerMs = exitLingerMs(run);
			assert.ok(lingerMs < MAX_EXIT_LINGER_MS, `nested custom-signal grace lingered ${lingerMs} ms after dispose()`);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	for (const runtime of ["node", "bun"] as const) {
		test(
			`${runtime} unawaited void session.abort() against a stuck tool exits promptly without lingering for grace (#5486)`,
			async () => {
				const body = `
const started = Promise.withResolvers();
const modelRuntime = await ModelRuntime.create({
	credentials: AuthStorage.inMemory({ p: { type: "api_key", key: "x" } }),
	modelsPath: null,
	refreshOnCreate: false,
});
modelRuntime.registerProvider("p", {
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	apiKey: "x",
	models: [spec],
	streamSimple: (model, context) => {
		const lastUser = context.messages.findLastIndex((message) => message.role === "user");
		if (context.messages.slice(lastUser).some((message) => message.role === "toolResult"))
			return reply(model, [{ type: "text", text: "done" }], "stop");
		return reply(model, [{ type: "toolCall", id: "stuck-1", name: "stuck", arguments: {} }], "toolUse");
	},
});
const stuck = {
	name: "stuck",
	label: "stuck",
	description: "stuck",
	parameters: { type: "object", properties: {} },
	async execute() {
		started.resolve();
		await new Promise(() => {});
		return { content: [], details: undefined };
	},
};
const { session } = await createAgentSession({
	cwd: process.cwd(),
	agentDir: process.cwd(),
	builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
	modelRuntime,
	model: modelRuntime.getModel("p", "m"),
	settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
	sessionManager: SessionManager.inMemory(),
	resourceLoader: createTestResourceLoader(),
	customTools: [stuck],
});
void session.prompt("go").catch(() => {});
await started.promise;
void session.abort();
console.log("EXIT_AT:" + Date.now());
`;
				const wrapped =
					runtime === "bun"
						? `async function main() {\n${body}\n}\nmain().catch((error) => { console.error(error); process.exitCode = 1; });`
						: body;
				const run = await runScript(
					runtime,
					`
import { createAssistantMessageEventStream } from ${JSON.stringify(aiCompatEntryUrl)};
import {
	AuthStorage,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	createExtensionRuntime,
} from ${JSON.stringify(codingAgentEntryUrl)};

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1000,
};
function createTestResourceLoader() {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: async () => {},
		reload: async () => {},
	};
}
function reply(model, content, stopReason) {
	const stream = createAssistantMessageEventStream();
	const message = {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: stopReason === "toolUse" ? "toolUse" : "stop", message });
	stream.end(message);
	return stream;
}
${wrapped}
`,
					{ ATOMIC_TOOL_ABORT_GRACE_MS: String(LINGER_GRACE_MS) },
				);
				assert.equal(run.exitCode, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
				const lingerMs = exitLingerMs(run);
				assert.ok(
					lingerMs < MAX_EXIT_LINGER_MS,
					`${runtime} unawaited void session.abort() lingered ${lingerMs} ms`,
				);
			},
			CHILD_PROCESS_TIMEOUT_MS,
		);
	}

	test(
		"fire-and-forget sendTaskMessage does not pin process exit for 10 s when OwnerTaskStore disposes",
		async () => {
			const run = await runScript(
				"node",
				`
const { taskFixture } = await import(${JSON.stringify(taskProjectionUrl)});
const { SessionManager } = await import(${JSON.stringify(sessionManagerUrl)});
const { ownerTaskViewSource } = await import(${JSON.stringify(taskViewSourceUrl)});
const { bindTaskResumer } = await import(${JSON.stringify(taskResumerUrl)});
const fixture = taskFixture();
await fixture.start("subagent work");
const session = SessionManager.inMemory();
const transcript = Object.assign(session, {
	subscribe: () => () => {},
	isRunning: () => false,
	queueMessage: async () => ({ delivered: false, reason: "ended" }),
});
fixture.runners[0].context.bindTranscript(transcript);
bindTaskResumer(fixture.store.supervisor, { readOnlyReason: () => undefined, resume: async () => ({ ok: true }) });
const source = ownerTaskViewSource(fixture.store);
const taskId = fixture.store.tasks[0].ref.taskId;
void source.sendTaskMessage(taskId, "follow up").catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 30));
fixture.store.dispose();
await fixture.supervisor.close?.();
console.log("EXIT_AT:" + Date.now());
`,
				{},
				{ sourceTs: true },
			);
			assert.equal(run.exitCode, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
			const lingerMs = exitLingerMs(run);
			assert.ok(lingerMs < MAX_EXIT_LINGER_MS, `agentTaskSettles lingered ${lingerMs} ms after store.dispose()`);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test(
		"abandoned queued worktree snapshot capture does not pin process exit for 10 s",
		async () => {
			const run = await runScript(
				"node",
				`
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const { SessionWorktreeSnapshotRecorder } = await import(${JSON.stringify(worktreeSnapshotsUrl)});
const { resolveWorktreeSnapshotSettings } = await import(${JSON.stringify(worktreeSnapshotSettingsUrl)});
execFileSync("git", ["init", "-q"]);
execFileSync("git", ["config", "user.email", "t@e.com"]);
execFileSync("git", ["config", "user.name", "T"]);
writeFileSync(join(process.cwd(), "a.txt"), "one\\n");
execFileSync("git", ["add", "a.txt"]);
execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);
const firstEntered = Promise.withResolvers();
let firstCall = true;
const stall = async () => {
	if (firstCall) {
		firstCall = false;
		firstEntered.resolve();
		return await new Promise(() => {});
	}
};
const fakeBlobs = {
	identity: "fake-blobs",
	getBlob: async () => undefined,
	hasBlob: async () => { await stall(); return false; },
	hasBlobs: async () => { await stall(); return new Set(); },
	putBlob: async () => { await stall(); },
	putBlobs: async () => { await stall(); },
	recordCapture: async () => {},
	deleteBlobs: async () => 0,
	listBlobs: async () => [],
};
const fakeSessionManager = {
	isPersisted: () => true,
	getSessionId: () => "sess-1",
	getSessionStore: () => ({ snapshotBlobs: fakeBlobs, descriptor: { adapter: "memory", location: ":memory:" } }),
	getLatestWorktreeSnapshots: () => new Map(),
	getWorktreeSnapshotRecords: () => new Map(),
	getWorktreeRootMappings: () => [],
	getWorktreePathContinuations: () => [],
	appendWorktreeSnapshot: async () => {},
	getBranch: () => [],
	getEntries: () => [],
};
const settings = resolveWorktreeSnapshotSettings({ enabled: true });
const recorder = new SessionWorktreeSnapshotRecorder({
	cwd: () => process.cwd(),
	settings: () => settings,
	sessionManager: fakeSessionManager,
	declaresWrites: () => false,
	onUnavailable: () => {},
});
const toolMsg = {
	role: "assistant",
	content: [{ type: "toolCall", id: "1", name: "write", arguments: { path: "a.txt" } }],
	api: "openai-completions",
	provider: "p",
	model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",
	timestamp: Date.now(),
};
void recorder.recordTurn(toolMsg).catch(() => {});
await firstEntered.promise;
void recorder.recordTurn(toolMsg).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 150));
console.log("EXIT_AT:" + Date.now());
`,
				{},
				{ sourceTs: true },
			);
			assert.equal(run.exitCode, 0, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`);
			const lingerMs = exitLingerMs(run);
			assert.ok(lingerMs < MAX_EXIT_LINGER_MS, `enqueueBehindActiveCapture lingered ${lingerMs} ms`);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test(
		"abandoned openRemoteAgentViewPort does not delay host shutdown by its frame or panel timers",
		async () => {
			const cancelled = await runScript(
				"node",
				`
const { RemoteComponentController } = await import(${JSON.stringify(remoteComponentUrl)});
const { openRemoteAgentViewPort } = await import(${JSON.stringify(remotePortUrl)});
const msgListeners = new Set();
const runtime = {
	onEngineMessage: (fn) => { msgListeners.add(fn); return () => msgListeners.delete(fn); },
	onGenerationEnded: () => () => {},
	sendEngineCommand: () => {},
	getGeneration: () => 1,
	requestAgentView: async (cmd) => {
		if (cmd.type === "agent_view_open") {
			for (const fn of msgListeners) {
				fn({ type: "engine_custom_open", componentId: "c1", overlay: false, placement: "transcript", viewId: "v1" });
			}
			return { viewId: "v1", status: { agentKey: "k1", taskId: "t1", heldPrompt: false, gone: false } };
		}
		return {};
	},
};
new RemoteComponentController(
	runtime,
	{ requestRender: () => {}, setWidget: () => {}, custom: () => new Promise(() => {}), onWidgetRelease: () => () => {} },
	{ isFullscreen: () => true, onRendererReplaced: () => () => {} },
);
void openRemoteAgentViewPort(runtime, "t1", { width: 80, rows: 16 }).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 20));
console.log("EXIT_AT:" + Date.now());
`,
				{},
				{ sourceTs: true },
			);
			assert.equal(cancelled.exitCode, 0, `stderr:\n${cancelled.stderr}\nstdout:\n${cancelled.stdout}`);
			const cancelledLingerMs = exitLingerMs(cancelled);
			assert.ok(
				cancelledLingerMs < MAX_REMOTE_PORT_LINGER_MS,
				`openRemoteAgentViewPort first-frame timer lingered ${cancelledLingerMs} ms`,
			);

			const panelShutdown = await runScript(
				"node",
				`
const { RemoteComponentController } = await import(${JSON.stringify(remoteComponentUrl)});
const { openRemoteAgentViewPort } = await import(${JSON.stringify(remotePortUrl)});
const msgListeners = new Set();
const runtime = {
	onEngineMessage: (fn) => { msgListeners.add(fn); return () => msgListeners.delete(fn); },
	onGenerationEnded: () => () => {},
	sendEngineCommand: () => {},
	getGeneration: () => 1,
	requestAgentView: async (cmd) => {
		if (cmd.type === "agent_view_open") {
			for (const fn of msgListeners) {
				fn({ type: "engine_custom_open", componentId: "c1", overlay: false, placement: "transcript", viewId: "v1" });
				fn({ type: "engine_custom_frame", componentId: "c1", requestId: 0, lines: ["hello"] });
			}
			return { viewId: "v1", status: { agentKey: "k1", taskId: "t1", heldPrompt: false, gone: false } };
		}
		return {};
	},
};
const controller = new RemoteComponentController(
	runtime,
	{ requestRender: () => {}, setWidget: () => {}, custom: () => new Promise(() => {}), onWidgetRelease: () => () => {} },
	{ isFullscreen: () => true, onRendererReplaced: () => () => {} },
);
void openRemoteAgentViewPort(runtime, "t1", { width: 80, rows: 16 }, { panel: true }).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 20));
controller.dispose();
console.log("EXIT_AT:" + Date.now());
`,
				{},
				{ sourceTs: true },
			);
			assert.equal(panelShutdown.exitCode, 0, `stderr:\n${panelShutdown.stderr}\nstdout:\n${panelShutdown.stdout}`);
			const panelLingerMs = exitLingerMs(panelShutdown);
			assert.ok(
				panelLingerMs < 200,
				`openRemoteAgentViewPort panel timer lingered ${panelLingerMs} ms after controller.dispose()`,
			);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);
});
