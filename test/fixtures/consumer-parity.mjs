// #3105: copied unchanged into a real npm installation; never use checkout imports or CLI hosts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ReadStream } from "node:tty";
import { fileURLToPath } from "node:url";

import { awaitFixtureBrokerExit, removeFixtureRoot, withoutSqliteExperimentalWarning } from "./sdk-host-fixture-support.mjs";
assert.equal(process.versions.bun, undefined);
assert.ok(!process.stdin.isTTY && !process.stdout.isTTY);
const installedRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "node_modules"));
for (const specifier of [
	"@bastani/atomic",
	"@bastani/pi-ai",
	"@bastani/atomic/workflows",
	"@bastani/atomic/workflows/builtin",
	"@bastani/atomic/workflows/builtin/open-claude-design",
]) {
	assert.ok(realpathSync(fileURLToPath(import.meta.resolve(specifier))).startsWith(installedRoot), specifier);
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
	await import("@bastani/atomic/workflows");
	await import("@bastani/atomic/workflows/builtin");
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
const disabled = { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false };
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
async function until(check) {
	const deadline = Date.now() + 15_000;
	while (true) {
		try {
			return await check();
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await delay(20);
		}
	}
}
function emitAssistant(stream, message) {
	stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
	stream.push({ type: "done", reason: message.stopReason, message });
	stream.end(message);
}
const host = (confirm) => ({
	input: async () => "  durable text  ",
	confirm,
	select: async () => undefined,
	editor: async () => "",
	questionnaire: async () => ({ answers: [], cancelled: true }),
});
try {
	if (mode?.startsWith("persist-")) {
		const directory = join(root, ".atomic", "workflows");
		mkdirSync(directory, { recursive: true });
		const source = readFileSync(new URL("./sdk-host-durable-workflow.ts", import.meta.url));
		writeFileSync(join(directory, "sdk-host-durable.ts"), source);
		const hash = createHash("sha256").update(source).digest("hex");
		process.env.ATOMIC_FAULT_TEST_HOME = root;
		const identities = [],
			diagnostics = [];
		const pending = Promise.withResolvers();
		const bindings = {
			humanInput: host(async (_title, _message, identity) => {
				identities.push(identity);
				return pending.promise;
			}),
			onDiagnostic: (entry) => diagnostics.push(entry),
		};
		const { session } = await createAgentSession({
			...options(),
			builtins: { ...disabled, workflows: true },
			extensionBindings: mode === "persist-start" ? bindings : { humanInput: null },
		});
		const status = async () => (await call(session, "workflow", { action: "status" })).details;
		try {
			if (mode === "persist-start") {
				await session.prompt("/workflow sdk-host-durable --no-picker");
				await until(() => assert.equal(identities.length, 1));
				const details = await status();
				const runId = details.runs[0].runId;
				assert.equal(details.runs[0].awaitingInputCount, 1);
				assert.equal(
					readFileSync(join(root, "receipts.jsonl"), "utf8"),
					`${JSON.stringify({ text: "  durable text  " })}\n`,
				);
				await session.bindExtensions({ humanInput: null });
				assert.equal(identities[0].signal.aborted, true);
				pending.resolve(true);
				const stopped = await call(session, "workflow", { action: "quit", runId });
				assert.equal(stopped.details.status, "paused", JSON.stringify(stopped));
				assert.equal(existsSync(join(root, "effects.jsonl")), false);
				assert.doesNotMatch(JSON.stringify(diagnostics), /NON-DURABLY|durable backend unavailable/);
				writeFileSync(
					join(root, "handoff.json"),
					JSON.stringify({ runId, hash, requestId: identities[0].requestId }),
				);
			} else {
				const saved = JSON.parse(readFileSync(join(root, "handoff.json"), "utf8"));
				assert.equal(hash, saved.hash);
				const resumed = await call(session, "workflow", { action: "resume", runId: saved.runId });
				assert.notEqual(resumed.isError, true, JSON.stringify(resumed));
				await until(async () => {
					const details = await status();
					assert.ok(
						details.runs.some((run) => run.runId === saved.runId && run.awaitingInputCount === 1),
						JSON.stringify(details),
					);
				});
				assert.equal(existsSync(join(root, "effects.jsonl")), false);
				await session.bindExtensions({
					humanInput: {
						...host(async (_title, _message, identity) => {
							identities.push(identity);
							return true;
						}),
						input: async () => {
							throw new Error("completed input replayed");
						},
					},
				});
				await until(async () =>
					assert.ok((await status()).runs.some((run) => run.runId === saved.runId && run.status === "completed")),
				);
				assert.equal(identities.length, 1);
				assert.notEqual(identities[0].requestId, saved.requestId);
				for (const file of ["receipts.jsonl", "effects.jsonl"])
					assert.equal(
						readFileSync(join(root, file), "utf8"),
						`${JSON.stringify({ text: "  durable text  " })}\n`,
					);
			}
		} finally {
			await session.dispose();
		}
	} else if (mode?.startsWith("gate-")) {
		const reply = mode.slice(5);
		const source = readFileSync(new URL("./sdk-host-durable-workflow.ts", import.meta.url));
		const hash = createHash("sha256").update(source).digest("hex");
		const directory = join(root, ".atomic", "workflows");
		mkdirSync(directory, { recursive: true });
		const definition = join(directory, "sdk-host-durable.ts");
		writeFileSync(definition, source);
		process.env.ATOMIC_FAULT_TEST_HOME = root;
		const late = Promise.withResolvers();
		const identities = [];
		const humanInput = host(async (_title, _message, identity) => {
			identities.push(identity);
			if (reply === "stale" || reply === "duplicate") return late.promise;
			if (reply === "cancel") return undefined;
			if (reply === "invalid") return "true";
			return reply === "true";
		});
		const { session } = await createAgentSession({
			...options(),
			builtins: { ...disabled, workflows: true },
			extensionBindings: { humanInput: reply === "missing" ? null : humanInput },
		});
		try {
			await session.prompt("/workflow sdk-host-durable --no-picker");
			const status = async () => (await call(session, "workflow", { action: "status" })).details;
			if (reply === "duplicate") {
				await until(() => assert.equal(identities.length, 1));
				late.resolve(true);
				late.resolve(true);
			}
			if (["missing", "cancel", "stale", "invalid"].includes(reply)) {
				await until(async () => {
					const details = await status();
					assert.equal(details.runs[0]?.awaitingInputCount, 1);
					if (reply !== "missing") assert.equal(identities.length, 1);
				});
				if (reply === "stale") {
					await session.bindExtensions({ humanInput: null });
					assert.equal(identities[0].signal.aborted, true);
					late.resolve(true);
					await delay(30);
				}
				assert.equal((await status()).runs[0].status, "running");
				assert.equal(existsSync(join(root, "effects.jsonl")), false);
			} else {
				const details = await until(async () => {
					const result = await status();
					assert.equal(result.runs[0]?.status, "completed");
					return result;
				});
				const approved = reply === "true" || reply === "duplicate";
				assert.deepEqual(details.snapshots[0].result, { text: "  durable text  ", approved });
				assert.equal(
					readFileSync(join(root, "receipts.jsonl"), "utf8"),
					`${JSON.stringify({ text: "  durable text  " })}\n`,
				);
				assert.equal(existsSync(join(root, "effects.jsonl")), approved);
				if (approved)
					assert.equal(
						readFileSync(join(root, "effects.jsonl"), "utf8"),
						`${JSON.stringify({ text: "  durable text  " })}\n`,
					);
				await session.bindExtensions({});
				assert.equal(identities.length, 1, "completed approval was presented again");
			}
			assert.equal(createHash("sha256").update(readFileSync(definition)).digest("hex"), hash);
		} finally {
			await session.dispose();
		}
	} else if (mode === "children") {
		// Production routing is essential: test hosts intentionally replace stage/subagent sessions.
		process.env.NODE_ENV = "production";
		delete process.env.NODE_TEST_CONTEXT;
		const { createAssistantMessageEventStream, getCurrentTools, getModel } = await import("@bastani/pi-ai/compat");
		const model = { ...getModel("anthropic", "claude-sonnet-4-5"), provider: "packed-child", id: "fixture" };
		let childCalls = 0;
		const observed = [];
		const params = {
			questions: [
				{
					question: "  exact child question\n",
					header: " Raw ",
					options: [
						{ label: " Yes ", description: " accept ", preview: " raw preview\n" },
						{ label: " No ", description: " refuse " },
					],
				},
			],
		};
		modelRuntime.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "fixture",
			models: [model],
			streamSimple: (_model, context) => {
				childCalls++;
				const tools = context.tools ?? getCurrentTools(context.messages ?? []);
				observed.push({ tools: tools.map((tool) => tool.name), messages: context.messages });
				const ask =
					tools.length === 1 &&
					tools[0].name === "ask_user_question" &&
					!context.messages.some((message) => message.role === "toolResult");
				const stream = createAssistantMessageEventStream();
				const message = {
					role: "assistant",
					content: ask
						? [{ type: "toolCall", id: `question-${childCalls}`, name: "ask_user_question", arguments: params }]
						: [{ type: "text", text: "child complete" }],
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
					stopReason: ask ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				emitAssistant(stream, message);
				return stream;
			},
		});
		const directory = join(root, ".atomic", "workflows");
		mkdirSync(directory, { recursive: true });
		mkdirSync(join(root, ".atomic", "agents"), { recursive: true });
		writeFileSync(
			join(root, ".atomic", "agents", "packed.md"),
			"---\nname: packed\ndescription: Packed child\nmodel: packed-child/fixture\ntools: read\n---\nReply once.\n",
		);
		writeFileSync(
			join(directory, "nested-child.ts"),
			`import { workflow } from "@bastani/atomic/workflows";
export default workflow({ name: "nested-child", description: "nested", inputs: {}, outputs: {}, run: async ctx => {
 await ctx.stage("reviewer", { model: "packed-child/fixture", tools: ["ask_user_question"], builtins: ${JSON.stringify(disabled)} }).prompt("ask the host"); return {};
} });`,
		);
		writeFileSync(
			join(directory, "children.ts"),
			`import { workflow } from "@bastani/atomic/workflows";
import child from "./nested-child.ts";
export default workflow({ name: "children", description: "children", inputs: {}, outputs: {}, run: async ctx => { await ctx.workflow(child); return {}; } });`,
		);
		const received = [],
			identities = [];
		const { session } = await createAgentSession({
			...options(),
			model,
			extensionBindings: {
				humanInput: {
					...host(async () => true),
					questionnaire: async (questions, identity) => {
						received.push(questions);
						identities.push(identity);
						return {
							cancelled: false,
							answers: questions.questions.map((question, questionIndex) => ({
								questionIndex,
								question: question.question,
								kind: "option",
								answer: question.options[0].label,
								preview: question.options[0].preview,
							})),
						};
					},
				},
			},
		});
		try {
			const result = await call(session, "subagent", {
				agent: "packed",
				task: "reply once",
				model: "packed-child/fixture",
				context: "fresh",
				wait: { kind: "foreground", budgetMs: 15_000 },
			});
			assert.ok(childCalls > 0, `subagent did not use the in-process provider: ${JSON.stringify(result)}`);
			assert.equal(result.details.taskResponse.observation.result.kind, "completed");
			assert.equal(Number(result.details.taskRecords[0].output.byteCount), Buffer.byteLength("child complete"));
			await session.prompt("/workflow children --no-picker");
			const details = await until(async () => {
				const status = (await call(session, "workflow", { action: "status" })).details;
				assert.ok(
					status.runs.some((run) => run.name === "children" && run.status === "completed"),
					JSON.stringify(status),
				);
				return status;
			});
			assert.deepEqual(received[0], params, JSON.stringify(observed));
			assert.equal(received.length, 2, "questionnaire plus stage readiness");
			assert.notEqual(identities[0].sessionId, session.sessionId);
			assert.equal(identities[0].workflowStageId, identities[1].workflowStageId);
			assert.notEqual(identities[0].workflowRunId, details.runs.find((run) => run.name === "children").runId);
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
	} else if (mode === "prompt") {
		const { createAssistantMessageEventStream, getModel } = await import("@bastani/pi-ai/compat");
		const model = { ...getModel("anthropic", "claude-sonnet-4-5"), provider: "packed-fixture" };
		const invocations = [
			["write", { path: "receipt.txt", content: "packed coding tool" }],
			["read", { path: "receipt.txt" }],
			["workflow", { action: "status" }],
			["subagent", { action: "list" }],
			["mcp", { list: true }],
			["web_search", { query: "fixture", provider: "gemini" }],
			["intercom", { action: "list" }],
		];
		// No broker acquisition: intercom's missing target validation is still real tool dispatch.
		invocations[6] = ["intercom", { action: "send", message: "fixture" }];
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
			for (const name of invocations.map((entry) => entry[0]))
				assert.ok(session.getActiveToolNames().includes(name), name);
			assert.ok(session.resourceLoader.getSkills().skills.length > 0);
			await session.prompt("Exercise the installed builtin families.");
			assert.equal(readFileSync(join(root, "receipt.txt"), "utf8"), "packed coding tool");
			assert.deepEqual(
				events.filter((event) => event.type === "tool_execution_end").map((event) => event.toolName),
				invocations.map((entry) => entry[0]),
			);
			assert.ok(events.some((event) => event.type === "agent_end"));
		} finally {
			await session.dispose();
		}
	} else {
		const run = (file, args = []) => {
			const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...args], {
				encoding: "utf8",
				timeout: 60_000,
				env: { ...process.env },
			});
			assert.equal(result.status, 0, `${file} ${args}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
			assert.equal(withoutSqliteExperimentalWarning(result.stderr), "", `${file}: unsolicited diagnostics`);
			return result.stdout;
		};
		for (const reply of ["true", "false", "cancel", "missing", "stale", "invalid", "duplicate"])
			run("./consumer-parity.mjs", [`gate-${reply}`]);
		run("./consumer-parity.mjs", ["lifecycle"]);
		run("./consumer-parity.mjs", ["prompt"]);
		const persisted = join(root, "persisted");
		mkdirSync(persisted);
		run("./consumer-parity.mjs", ["persist-start", persisted]);
		run("./consumer-parity.mjs", ["persist-resume", persisted]);
		run("./consumer-parity.mjs", ["children"]);
		const durable = JSON.parse(run("./sdk-host-built-node.mjs").trim());
		assert.equal(durable.effects, 1);
		assert.equal(
			durable.hash,
			createHash("sha256")
				.update(readFileSync(new URL("./sdk-host-durable-workflow.ts", import.meta.url)))
				.digest("hex"),
		);
		for (const file of [
			"sdk-host-lazy-mcp.mjs",
			"sdk-host-web-owners.mjs",
			"sdk-host-web-unavailable.mjs",
			"sdk-host-intercom-owners.mjs",
			"sdk-host-mcp-diagnostics.mjs",
		])
			run(`./${file}`);
	}
} finally {
	await awaitFixtureBrokerExit(join(root, "agent"));
	if (!mode) {
		// Sessions release leases, not the shared service. This fixture owns its disposable cluster.
		const { workflowDependency } = await import("@bastani/atomic/workflows");
		const report = await workflowDependency("doctor");
		if (report.cluster?.server) {
			assert.equal(report.identityVerified, true, JSON.stringify(report));
			assert.equal(report.consumers.length, 0, "session disposal leaked a database lease");
			assert.ok(
				realpathSync(report.cluster.dataDir).startsWith(
					realpathSync(join(process.env.HOME, ".atomic", "postgres")),
				),
			);
			const postgres = report.runtime.installation.executable;
			const stopped = spawnSync(
				join(dirname(postgres), process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl"),
				["-D", report.cluster.dataDir, "-m", "fast", "-w", "-t", "15", "stop"],
				{ encoding: "utf8", timeout: 20_000 },
			);
			assert.equal(stopped.status, 0, stopped.stderr);
		}
	}
	if (!mode?.startsWith("persist-")) await removeFixtureRoot(root);
}
if (!mode)
	console.log(
		JSON.stringify({
			packedConsumer: true,
			hash: createHash("sha256")
				.update(readFileSync(new URL("./sdk-host-durable-workflow.ts", import.meta.url)))
				.digest("hex"),
		}),
	);
