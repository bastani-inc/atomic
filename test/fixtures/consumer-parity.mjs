// #3105: copied unchanged into a real npm installation; never use checkout imports or CLI hosts.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { findPackageJSON, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ReadStream } from "node:tty";
import { fileURLToPath } from "node:url";

import {
	awaitFixtureBrokerExit,
	removeFixtureRoot,
	withoutSqliteExperimentalWarning,
} from "./sdk-host-fixture-support.mjs";
assert.equal(process.versions.bun, undefined);
assert.ok(!process.stdin.isTTY && !process.stdout.isTTY);
const installedRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "node_modules"));
for (const specifier of ["@bastani/atomic", "@bastani/atomic-ai", "@bastani/atomic/storage", "@bastani/atomic/rpc-entry"]) {
	assert.ok(realpathSync(fileURLToPath(import.meta.resolve(specifier))).startsWith(installedRoot), specifier);
}
for (const specifier of ["@bastani/atomic/workflows", "@bastani/atomic/workflows/builtin", "@bastani/atomic/workflows/builtin/goal"]) {
	assert.throws(() => import.meta.resolve(specifier), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
}
// Fail rather than merely count forbidden import-time host effects.
const original = {
	connect: net.Socket.prototype.connect,
	fetch: globalThis.fetch,
	stdout: process.stdout.write,
	stderr: process.stderr.write,
	read: process.stdin.read,
	resume: process.stdin.resume,
};
const forbidden = () => {
	throw new Error("SDK import attempted a host side effect");
};
const rawMode = ReadStream.prototype.setRawMode;
ReadStream.prototype.setRawMode = forbidden;
net.Socket.prototype.connect = forbidden;
globalThis.fetch = forbidden;
process.stdout.write = forbidden;
process.stderr.write = forbidden;
process.stdin.read = forbidden;
process.stdin.resume = forbidden;
syncBuiltinESMExports();
let sdk;
try {
	sdk = await import("@bastani/atomic");
} finally {
	net.Socket.prototype.connect = original.connect;
	globalThis.fetch = original.fetch;
	process.stdout.write = original.stdout;
	process.stderr.write = original.stderr;
	process.stdin.read = original.read;
	process.stdin.resume = original.resume;
	ReadStream.prototype.setRawMode = rawMode;
	syncBuiltinESMExports();
}
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
const mode = process.argv[2];
const root = process.argv[3] ?? mkdtempSync(join(tmpdir(), "sdk-h-"));
process.env.ATOMIC_CODING_AGENT_DIR = join(root, "agent");
const disabled = { subagents: false, mcp: false, intercom: false, "web-access": false };
const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } });
const modelRuntime = await ModelRuntime.create({
	authPath: join(root, "auth"),
	modelsPath: null,
	allowModelNetwork: false,
});
const options = () => ({
	cwd: root,
	agentDir: join(root, "agent"),
	modelRuntime,
	settingsManager,
	sessionManager: SessionManager.inMemory(root),
});
const tool = (session, name) => {
	const found = session.agent.state.tools.find((entry) => entry.name === name);
	assert.ok(found, name);
	return found;
};
const call = (session, name, args) => tool(session, name).execute(name, args, new AbortController().signal);
function emitAssistant(stream, message) {
	stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
	stream.push({ type: "done", reason: message.stopReason, message });
	stream.end(message);
}
try {
	if (mode === "children") {
		// Production routing is essential: test hosts intentionally replace stage/subagent sessions.
		process.env.NODE_ENV = "production";
		delete process.env.NODE_TEST_CONTEXT;
		const { createAssistantMessageEventStream, getModel } = await import("@bastani/atomic-ai/compat");
		const model = { ...getModel("anthropic", "claude-sonnet-4-5"), provider: "packed-child", id: "fixture" };
		let childCalls = 0;
		modelRuntime.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "fixture",
			models: [model],
			streamSimple: () => {
				childCalls++;
				const stream = createAssistantMessageEventStream();
				const message = {
					role: "assistant",
					content: [{ type: "text", text: "child complete" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				emitAssistant(stream, message);
				return stream;
			},
		});
		mkdirSync(join(root, ".atomic", "agents"), { recursive: true });
		writeFileSync(
			join(root, ".atomic", "agents", "packed.md"),
			"---\nname: packed\ndescription: Packed child\nmodel: packed-child/fixture\ntools: read\n---\nReply once.\n",
		);
		const { session } = await createAgentSession({ ...options(), model });
		try {
			const launched = await call(session, "subagent", {
				agent: "packed",
				task: "reply once",
				model: "packed-child/fixture",
				context: "fresh",
			});
			const result = await call(session, "subagent", {
				action: "wait",
				id: launched.details.taskResponse.observation.taskId,
				budgetMs: 15_000,
			});
			assert.ok(childCalls > 0, `subagent did not use the in-process provider: ${JSON.stringify(result)}`);
			assert.equal(result.details.taskResponse.observation.result.kind, "completed", JSON.stringify(result));
			assert.equal(Number(result.details.taskRecords[0].output.byteCount), Buffer.byteLength("child complete"));
		} finally {
			await session.dispose();
		}
	} else if (mode === "lifecycle") {
		const released = [];
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", () => {
						released.push("factory");
						throw new Error("cleanup failed");
					});
					throw new Error("factory failed");
				},
			],
		});
		await assert.rejects(createAgentSession({ ...options(), builtins: disabled, resourceLoader }), (error) => {
			assert.equal(error.code, "ShutdownFailed");
			assert.match(JSON.stringify(error.errors.map((entry) => entry.message)), /factory failed/);
			return true;
		});
		assert.deepEqual(released, ["factory"]);
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", () => {
						released.push("first");
						throw new Error("first cleanup");
					});
				},
				(pi) => {
					pi.on("session_shutdown", async () => {
						await delay(10);
						released.push("second");
					});
				},
			],
		});
		const { session } = await createAgentSession({ ...options(), builtins: disabled, resourceLoader: loader });
		await assert.rejects(session.dispose(), (error) => error.code === "ShutdownFailed");
		assert.ok(released.includes("first") && released.includes("second"));
	} else if (mode === "malformed-arguments") {
		const atomicPackage = findPackageJSON("@bastani/atomic", import.meta.url);
		assert.ok(atomicPackage);
		const agentCorePackage = findPackageJSON("@bastani/atomic-agent-core", atomicPackage);
		assert.ok(agentCorePackage, "Atomic must resolve an installed pi-agent-core");
		const validatorPackage = findPackageJSON("@bastani/atomic-ai", agentCorePackage);
		assert.ok(validatorPackage, "pi-agent-core must resolve an installed @bastani/atomic-ai");
		assert.ok(
			realpathSync(validatorPackage).startsWith(`${installedRoot}${sep}`),
			"validator must come from the npm install",
		);
		const validator = JSON.parse(readFileSync(validatorPackage, "utf8"));
		const atomic = JSON.parse(readFileSync(atomicPackage, "utf8"));
		assert.equal(validator.name, "@bastani/atomic-ai");
		assert.equal(
			validator.version,
			atomic.dependencies["@bastani/atomic-ai"],
			"pi-agent-core must use the validator release Atomic pins",
		);
		const { Type } = await import("@bastani/atomic-ai");
		const { createAssistantMessageEventStream, getModel } = await import("@bastani/atomic-ai/compat");
		const model = { ...getModel("anthropic", "claude-sonnet-4-5"), provider: "packed-malformed" };
		const malformed = {
			probe: 'Expected \',\' or \'}\' after property value in JSON at position 12\n\nReceived arguments:\n{"value":"a" "b"}',
			write: 'Unterminated string in JSON at position 30\n\nReceived arguments:\n{"path":"malformed.txt","content":"cut',
		};
		const prepared = [];
		const executed = [];
		let requests = 0;
		modelRuntime.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "fixture",
			models: [model],
			streamSimple: () => {
				const first = requests++ === 0;
				const stream = createAssistantMessageEventStream();
				emitAssistant(stream, {
					role: "assistant",
					content: first
						? [
								...Object.entries(malformed).map(([name, argumentsError]) => ({
									type: "toolCall",
									id: `malformed-${name}`,
									name,
									arguments: {},
									argumentsError,
								})),
								{ type: "toolCall", id: "well-formed-probe", name: "probe", arguments: { value: "ok" } },
							]
						: [{ type: "text", text: "complete" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: first ? "toolUse" : "stop",
					timestamp: Date.now(),
				});
				return stream;
			},
		});
		const { session } = await createAgentSession({
			...options(),
			model,
			builtins: disabled,
			customTools: [
				{
					name: "probe",
					label: "Probe",
					description: "Records executions",
					parameters: Type.Object({ value: Type.Optional(Type.String()) }),
					prepareArguments: (args) => {
						prepared.push(args);
						return { value: `${args.value}!` };
					},
					execute: async (_id, params) => {
						executed.push(params);
						return { content: [{ type: "text", text: `probe executed ${params.value}` }], details: {} };
					},
				},
			],
		});
		try {
			assert.ok(session.getActiveToolNames().includes("probe"));
			await session.prompt("Call tools with malformed arguments.");
			assert.deepEqual(prepared, [{ value: "ok" }]);
			assert.deepEqual(executed, [{ value: "ok!" }]);
			assert.equal(existsSync(join(root, "malformed.txt")), false);
			const results = session.messages.filter((message) => message.role === "toolResult");
			assert.deepEqual(
				results.map((message) => ({ name: message.toolName, isError: message.isError, content: message.content })),
				[
					...Object.entries(malformed).map(([name, argumentsError]) => ({
						name,
						isError: true,
						content: [{ type: "text", text: `Invalid arguments for tool "${name}": ${argumentsError}` }],
					})),
					{ name: "probe", isError: false, content: [{ type: "text", text: "probe executed ok!" }] },
				],
			);
		} finally {
			await session.dispose();
		}
	} else if (mode === "prompt") {
		const { createAssistantMessageEventStream, getModel } = await import("@bastani/atomic-ai/compat");
		const mcpReceipt = join(root, "mcp-receipt.json");
		const mcpFixture = join(root, "native-mcp-fixture.mjs");
		writeFileSync(
			mcpFixture,
			`import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
for await (const line of createInterface({ input: process.stdin })) {
 const message = JSON.parse(line);
 if (message.id === undefined) continue;
 let result;
 if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "packed", version: "1" } };
 else if (message.method === "tools/list") result = { tools: [{ name: "echo", description: "Packed native MCP echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
 else if (message.method === "tools/call") {
  writeFileSync(${JSON.stringify(mcpReceipt)}, JSON.stringify({ name: message.params.name, arguments: message.params.arguments }));
  result = { content: [{ type: "text", text: "packed native MCP result" }] };
 } else result = {};
 process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}\n`,
		);
		mkdirSync(join(root, "agent"), { recursive: true });
		writeFileSync(
			join(root, "agent", "mcp.json"),
			JSON.stringify({ mcpServers: { packed: { command: process.execPath, args: [mcpFixture], exposure: "direct" } } }),
		);
		const model = { ...getModel("anthropic", "claude-sonnet-4-5"), provider: "packed-fixture" };
		const invocations = [
			["write", { path: "receipt.txt", content: "packed coding tool" }],
			["read", { path: "receipt.txt" }],
			["subagent", { action: "list" }],
			["mcp__packed__echo", { text: "packed SDK dispatch" }],
			["web_search", { query: "fixture", provider: "gemini" }],
			["intercom", { action: "send", message: "fixture" }],
		];
		let index = 0;
		modelRuntime.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "fixture",
			models: [model],
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				const next = invocations[index++];
				const message = {
					role: "assistant",
					content: next
						? [{ type: "toolCall", id: `call-${index}`, name: next[0], arguments: next[1] }]
						: [{ type: "text", text: "complete" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: next ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				emitAssistant(stream, message);
				return stream;
			},
		});
		delete process.env.GEMINI_API_KEY;
		process.env.ATOMIC_ALLOW_BROWSER_COOKIES = "0";
		const { session } = await createAgentSession({ ...options(), model });
		const events = [];
		session.subscribe((event) => events.push(event));
		try {
			const deadline = Date.now() + 10_000;
			while (!session.getActiveToolNames().includes("mcp__packed__echo")) {
				assert.ok(Date.now() < deadline, "packed SDK must discover the native stdio MCP tool");
				await delay(25);
			}
			for (const name of invocations.map((entry) => entry[0]))
				assert.ok(session.getActiveToolNames().includes(name), name);
			assert.ok(session.resourceLoader.getSkills().skills.length > 0);
			await session.prompt("Exercise the installed builtin families.");
			assert.equal(readFileSync(join(root, "receipt.txt"), "utf8"), "packed coding tool");
			assert.deepEqual(JSON.parse(readFileSync(mcpReceipt, "utf8")), {
				name: "echo",
				arguments: { text: "packed SDK dispatch" },
			});
			const mcpResult = session.messages.find((message) => message.role === "toolResult" && message.toolName === "mcp__packed__echo");
			assert.ok(mcpResult);
			assert.deepEqual(mcpResult.content, [{ type: "text", text: "packed native MCP result" }]);
			assert.deepEqual(
				events.filter((event) => event.type === "tool_execution_end").map((event) => event.toolName),
				invocations.map((entry) => entry[0]),
			);
			assert.ok(events.some((event) => event.type === "agent_end"));
		} finally {
			await session.dispose();
		}
	} else {
		const run = async (file, args = [], extraEnv = {}) => {
			const started = performance.now();
			const result = await new Promise((resolve) => {
				execFile(
					process.execPath,
					[fileURLToPath(new URL(file, import.meta.url)), ...args],
					{ encoding: "utf8", timeout: 60_000, env: { ...process.env, ...extraEnv } },
					(error, stdout, stderr) => resolve({ error, stdout, stderr }),
				);
			});
			console.log(
				`[packed-node-consumer] parity ${file} ${args.join(" ")}: ${Math.round(performance.now() - started)}ms (status=${result.error ? (result.error.code ?? result.error.signal ?? "error") : 0})`,
			);
			assert.equal(result.error, null, `${file} ${args}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
			assert.equal(withoutSqliteExperimentalWarning(result.stderr), "", `${file}: unsolicited diagnostics`);
			return result.stdout;
		};
		const independentHosts = (async () => {
			const files = [
				"sdk-host-lazy-mcp.mjs",
				"sdk-host-web-owners.mjs",
				"sdk-host-web-unavailable.mjs",
				"sdk-host-intercom-owners.mjs",
				"sdk-host-mcp-diagnostics.mjs",
			];
			const results = [];
			for (let index = 0; index < files.length; index += 2) {
				results.push(
					...await Promise.allSettled(files.slice(index, index + 2).map((file) => run(`./${file}`))),
				);
			}
			return results;
		})();
		try {
			await run("./consumer-parity.mjs", ["lifecycle"]);
			await run("./consumer-parity.mjs", ["prompt"]);
			await run("./consumer-parity.mjs", ["malformed-arguments"]);
			await run("./consumer-parity.mjs", ["children"]);
		} finally {
			for (const result of await independentHosts) {
				if (result.status === "rejected") throw result.reason;
			}
		}
	}
} finally {
	await awaitFixtureBrokerExit(join(root, "agent"));
	await removeFixtureRoot(root);
}
if (!mode) console.log(JSON.stringify({ packedConsumer: true }));
