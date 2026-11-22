import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	waitUntilGone,
} from "../helpers/recorded-process.js";
import { makeTempDirectory, moduleDir, readTextSync, sleep } from "../helpers/runtime.js";
import { type ChatRequest, messageText } from "../helpers/scripted-chat-server.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
/** Real PTY session with two isolated-engine process lifetimes (initial + post-crash recovery) and a subagent turn. */
const POST_CRASH_PTY_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 45_000;
const POLL_MS = 50;
const PROVIDER = "guard-loopback";
const MODEL = "guard-model";

const PID_EXTENSION = `import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const cfg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixture.json"), "utf8"));
export default (atomic) => {
	atomic.on("session_start", (_event, ctx) => {
		if (ctx.subagentPolicy !== undefined || ctx.isPresentationOnly === true) return;
		appendFileSync(cfg.pidFile, JSON.stringify({ pid: process.pid }) + "\\n");
	});
};`;

async function readBody(request: IncomingMessage): Promise<string> {
	const parts: Buffer[] = [];
	for await (const part of request) parts.push(part as Buffer);
	return Buffer.concat(parts).toString("utf8");
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
	return `data: ${JSON.stringify({
		id: "scripted",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;
}

function sseEnd(response: ServerResponse, finishReason: "stop" | "tool_calls"): void {
	response.write(sseChunk({}, finishReason));
	response.write(
		`data: ${JSON.stringify({
			id: "scripted",
			object: "chat.completion.chunk",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
		})}\n\n`,
	);
	response.end("data: [DONE]\n\n");
}

function readPids(file: string): number[] {
	try {
		return readTextSync(file, "utf8")
			.split(/\r?\n/u)
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as { pid: number }).pid);
	} catch {
		return [];
	}
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = fn();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
		await sleep(POLL_MS);
	}
}

describe("post-crash subagent recovery in a real PTY", () => {
	test(
		"killing the isolated engine with a running subagent restores it into /tasks after recovery without user resume prompts",
		async () => {
			const root = makeTempDirectory("atomic-post-crash-subagent-");
			const agentDir = join(root, "agent");
			const project = join(root, "project");
			const sessionsDir = join(root, "sessions");
			const installed = join(root, "installed");
			const pidFile = join(root, "engine-pids.jsonl");
			const extension = join(root, "record-pid.ts");

			const childGen1Started = Promise.withResolvers<void>();
			const childGen2Started = Promise.withResolvers<void>();
			const releaseChildGen2 = Promise.withResolvers<void>();
			const openResponses = new Set<ServerResponse>();
			const requestLog: string[] = [];
			let childRequests = 0;

			const server = createServer((request, response) => {
				openResponses.add(response);
				response.once("close", () => openResponses.delete(response));
				void (async () => {
					const parsed = JSON.parse(await readBody(request)) as ChatRequest;
					const last = parsed.messages.at(-1);
					const allText = parsed.messages.map((message) => messageText(message)).join("\n");
					const lastUser = [...parsed.messages].reverse().find((message) => message.role === "user");
					const lastUserText = messageText(lastUser);
					const isChild = !allText.includes("LAUNCH_WORKER") && allText.includes("HOLD_WORKER_TASK");
					requestLog.push(
						`${isChild ? "child" : "main"}(msgs=${parsed.messages.length},last=${last?.role}:${messageText(last).slice(0, 80)})`,
					);
					response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
					response.write(sseChunk({ role: "assistant", content: "" }));

					if (isChild) {
						childRequests++;
						if (childRequests === 1) {
							response.write(sseChunk({ content: "working before crash" }));
							childGen1Started.resolve();
							// Hold stream open until engine #1 is killed.
							await new Promise<void>((resolve) => {
								response.once("close", resolve);
							});
							return;
						}
						response.write(sseChunk({ content: "continuing after crash" }));
						childGen2Started.resolve();
						await Promise.race([
							releaseChildGen2.promise,
							new Promise<void>((resolve) => response.once("close", resolve)),
						]);
						if (!response.destroyed) sseEnd(response, "stop");
						return;
					}

					if (last?.role === "tool" && allText.includes("LAUNCH_WORKER")) {
						response.write(sseChunk({ content: "WORKER_LAUNCHED_OK" }));
						sseEnd(response, "stop");
						return;
					}

					if (last?.role === "user" && lastUserText.includes("LAUNCH_WORKER")) {
						response.write(sseChunk({ content: "Launching worker." }));
						response.write(
							sseChunk({
								tool_calls: [
									{
										index: 0,
										id: "call_launch_worker",
										type: "function",
										function: {
											name: "subagent",
											arguments: JSON.stringify({
												context: "fresh",
												agent: "worker",
												model: `${PROVIDER}/${MODEL}`,
												task: "HOLD_WORKER_TASK",
											}),
										},
									},
								],
							}),
						);
						sseEnd(response, "tool_calls");
						return;
					}

					response.write(sseChunk({ content: "ok" }));
					sseEnd(response, "stop");
				})().catch(() => {
					if (!response.headersSent) response.writeHead(500);
					response.end();
				});
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const { port } = server.address() as AddressInfo;

			let program: PtyProgram | undefined;
			let engine1Proc: RecordedProcess | undefined;
			try {
				prepareAgentDir(agentDir, `http://127.0.0.1:${port}/v1`);
				// Configure resumeInFlight: "ask" to prove automatic engine crash restart never pops a user resume prompt.
				writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ resumeInFlight: "ask" }));
				prepareInstalledPackage(PACKAGE, installed);
				mkdirSync(project, { recursive: true });
				mkdirSync(sessionsDir, { recursive: true });
				writeFileSync(join(root, "fixture.json"), JSON.stringify({ pidFile }));
				writeFileSync(extension, PID_EXTENSION);

				program = startPtyProgram({
					executable: process.execPath,
					args: [
						join(PACKAGE, "dist/cli.js"),
						"--offline",
						"--no-mcp",
						"--approve",
						"--session-dir",
						sessionsDir,
						"-e",
						extension,
					],
					cwd: project,
					env: {
						...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
						HOME: root,
						USERPROFILE: root,
						ATOMIC_CODING_AGENT_DIR: agentDir,
						ATOMIC_PACKAGE_DIR: installed,
						ATOMIC_SKIP_VERSION_CHECK: "1",
						ATOMIC_TELEMETRY: "0",
						CI: "0",
						NODE_ENV: "",
						VITEST: "",
						PATH: process.env.PATH ?? "",
					},
					timeoutMs: POST_CRASH_PTY_TIMEOUT_MS,
					cols: 120,
					rows: 40,
				});

				const engine1Pid = await waitFor(() => readPids(pidFile)[0], STEP_TIMEOUT_MS, "first engine pid");
				engine1Proc = await recordProcess(engine1Pid);

				await program.waitForScreen((screen) => screen.includes("guard-model"), STEP_TIMEOUT_MS, "initial prompt");
				program.write("LAUNCH_WORKER\r");

				// Wait until worker is genuinely streaming in engine #1 and main turn finished launching it.
				await Promise.race([
					childGen1Started.promise,
					sleep(STEP_TIMEOUT_MS).then(() => {
						throw new Error(
							`Child never started in engine #1. pids=${JSON.stringify(readPids(pidFile))} requests=${JSON.stringify(requestLog)}\nScreen:\n${program?.screen()}`,
						);
					}),
				]);
				await program.waitForScreen(
					(screen) => screen.includes("WORKER_LAUNCHED_OK"),
					STEP_TIMEOUT_MS,
					"main launch reply",
				);

				// Kill the real isolated engine process unexpectedly.
				assert.equal(await signalRecordedProcess(engine1Proc, "SIGKILL"), true);
				await waitUntilGone(engine1Proc, 10_000);

				// Replacement engine starts and automatically restores the running worker child.
				const engine2Pid = await waitFor(
					() => readPids(pidFile).find((pid) => pid !== engine1Pid),
					STEP_TIMEOUT_MS,
					"replacement engine pid",
				);
				assert.notEqual(engine2Pid, engine1Pid);

				await Promise.race([
					childGen2Started.promise,
					sleep(STEP_TIMEOUT_MS).then(() => {
						throw new Error(
							`Child never restored in engine #2. pids=${JSON.stringify(readPids(pidFile))} requests=${JSON.stringify(requestLog)}\nScreen:\n${program?.screen()}`,
						);
					}),
				]);

				// Open /tasks in the real PTY and verify worker is listed without any user resume prompt or recovery error.
				program.write("/tasks\r");
				await program.waitForScreen(
					(screen) => screen.includes("worker") && /Tasks|HOLD_WORKER_TASK|running/i.test(screen),
					STEP_TIMEOUT_MS,
					"restored worker listed in /tasks",
				);
				const tasksScreen = program.screen();
				assert.doesNotMatch(tasksScreen, /Resume interrupted subagents/i);
				assert.doesNotMatch(tasksScreen, /Session recovery failed/i);
				assert.equal(childRequests, 2, "exactly one launch before crash and one restore after crash");

				// Close /tasks, let restored worker finish, and quit cleanly.
				releaseChildGen2.resolve();
				program.write("\x1b");
				await sleep(200);
				program.write("/quit\r");
				const exit = await program.exited;
				assert.equal(exit.timedOut, false);
			} finally {
				releaseChildGen2.resolve();
				for (const res of [...openResponses]) res.destroy();
				program?.kill();
				await server.close();
				await removeTempRootReleasingBroker(root, agentDir);
			}
		},
		POST_CRASH_PTY_TIMEOUT_MS,
	);

	test(
		"a second crash while the restored subagent is mid-restore recovers cleanly into engine #3 with no duplicate wake notes",
		async () => {
			const root = makeTempDirectory("atomic-post-crash-second-");
			const agentDir = join(root, "agent");
			const project = join(root, "project");
			const sessionsDir = join(root, "sessions");
			const installed = join(root, "installed");
			const pidFile = join(root, "engine-pids.jsonl");
			const extension = join(root, "record-pid.ts");

			const childGen1Started = Promise.withResolvers<void>();
			const childGen2Started = Promise.withResolvers<void>();
			const childGen3Started = Promise.withResolvers<void>();
			const releaseChildGen3 = Promise.withResolvers<void>();
			const openResponses = new Set<ServerResponse>();
			const childRequestsPayloads: ChatRequest[] = [];

			const server = createServer((request, response) => {
				openResponses.add(response);
				response.once("close", () => openResponses.delete(response));
				void (async () => {
					const parsed = JSON.parse(await readBody(request)) as ChatRequest;
					const last = parsed.messages.at(-1);
					const allText = parsed.messages.map((message) => messageText(message)).join("\n");
					const lastUser = [...parsed.messages].reverse().find((message) => message.role === "user");
					const lastUserText = messageText(lastUser);
					const isChild = !allText.includes("LAUNCH_WORKER") && allText.includes("HOLD_WORKER_TASK");
					response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
					response.write(sseChunk({ role: "assistant", content: "" }));

					if (isChild) {
						childRequestsPayloads.push(parsed);
						const n = childRequestsPayloads.length;
						if (n === 1) {
							response.write(sseChunk({ content: "gen1 working" }));
							childGen1Started.resolve();
							await new Promise<void>((resolve) => response.once("close", resolve));
							return;
						}
						if (n === 2) {
							response.write(sseChunk({ content: "gen2 mid-restore" }));
							childGen2Started.resolve();
							await new Promise<void>((resolve) => response.once("close", resolve));
							return;
						}
						response.write(sseChunk({ content: "gen3 recovered" }));
						childGen3Started.resolve();
						await Promise.race([
							releaseChildGen3.promise,
							new Promise<void>((resolve) => response.once("close", resolve)),
						]);
						if (!response.destroyed) sseEnd(response, "stop");
						return;
					}

					if (last?.role === "tool" && allText.includes("LAUNCH_WORKER")) {
						response.write(sseChunk({ content: "WORKER_LAUNCHED_OK" }));
						sseEnd(response, "stop");
						return;
					}

					if (last?.role === "user" && lastUserText.includes("LAUNCH_WORKER")) {
						response.write(sseChunk({ content: "Launching worker." }));
						response.write(
							sseChunk({
								tool_calls: [
									{
										index: 0,
										id: "call_launch_worker_2",
										type: "function",
										function: {
											name: "subagent",
											arguments: JSON.stringify({
												context: "fresh",
												agent: "worker",
												model: `${PROVIDER}/${MODEL}`,
												task: "HOLD_WORKER_TASK",
											}),
										},
									},
								],
							}),
						);
						sseEnd(response, "tool_calls");
						return;
					}

					response.write(sseChunk({ content: "ok" }));
					sseEnd(response, "stop");
				})().catch(() => {
					if (!response.headersSent) response.writeHead(500);
					response.end();
				});
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const { port } = server.address() as AddressInfo;

			let program: PtyProgram | undefined;
			try {
				prepareAgentDir(agentDir, `http://127.0.0.1:${port}/v1`);
				prepareInstalledPackage(PACKAGE, installed);
				mkdirSync(project, { recursive: true });
				mkdirSync(sessionsDir, { recursive: true });
				writeFileSync(join(root, "fixture.json"), JSON.stringify({ pidFile }));
				writeFileSync(extension, PID_EXTENSION);

				program = startPtyProgram({
					executable: process.execPath,
					args: [
						join(PACKAGE, "dist/cli.js"),
						"--offline",
						"--no-mcp",
						"--approve",
						"--session-dir",
						sessionsDir,
						"-e",
						extension,
					],
					cwd: project,
					env: {
						...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
						HOME: root,
						USERPROFILE: root,
						ATOMIC_CODING_AGENT_DIR: agentDir,
						ATOMIC_PACKAGE_DIR: installed,
						ATOMIC_SKIP_VERSION_CHECK: "1",
						ATOMIC_TELEMETRY: "0",
						CI: "0",
						NODE_ENV: "",
						VITEST: "",
						PATH: process.env.PATH ?? "",
					},
					timeoutMs: POST_CRASH_PTY_TIMEOUT_MS,
					cols: 120,
					rows: 40,
				});

				const engine1Pid = await waitFor(() => readPids(pidFile)[0], STEP_TIMEOUT_MS, "engine #1 pid");
				const engine1Proc = await recordProcess(engine1Pid);

				await program.waitForScreen((screen) => screen.includes("guard-model"), STEP_TIMEOUT_MS, "initial prompt");
				program.write("LAUNCH_WORKER\r");
				await Promise.race([
					childGen1Started.promise,
					sleep(STEP_TIMEOUT_MS).then(() => {
						throw new Error(`Child never started in gen1. Screen:\n${program?.screen()}`);
					}),
				]);
				await program.waitForScreen(
					(screen) => screen.includes("WORKER_LAUNCHED_OK"),
					STEP_TIMEOUT_MS,
					"main launch reply",
				);

				// Crash #1 -> engine #2 restores worker.
				assert.equal(await signalRecordedProcess(engine1Proc, "SIGKILL"), true);
				await waitUntilGone(engine1Proc, 10_000);

				const engine2Pid = await waitFor(
					() => readPids(pidFile).find((pid) => pid !== engine1Pid),
					STEP_TIMEOUT_MS,
					"engine #2 pid",
				);
				const engine2Proc = await recordProcess(engine2Pid);
				await Promise.race([
					childGen2Started.promise,
					sleep(STEP_TIMEOUT_MS).then(() => {
						throw new Error(`Child never restored in gen2. Screen:\n${program?.screen()}`);
					}),
				]);

				// Crash #2 while worker is mid-restore in engine #2 -> engine #3 restores worker cleanly.
				assert.equal(await signalRecordedProcess(engine2Proc, "SIGKILL"), true);
				await waitUntilGone(engine2Proc, 10_000);

				const engine3Pid = await waitFor(
					() => readPids(pidFile).find((pid) => pid !== engine1Pid && pid !== engine2Pid),
					STEP_TIMEOUT_MS,
					"engine #3 pid",
				);
				assert.notEqual(engine3Pid, engine2Pid);
				await Promise.race([
					childGen3Started.promise,
					sleep(STEP_TIMEOUT_MS).then(() => {
						throw new Error(`Child never restored in gen3. Screen:\n${program?.screen()}`);
					}),
				]);

				// Exactly one child turn per generation (initial + one per crash) and one restart note per interrupted turn.
				assert.equal(childRequestsPayloads.length, 3, "exactly one child turn per generation");
				const gen2Notes = childRequestsPayloads[1]!.messages.filter((message) =>
					messageText(message).includes("Atomic restarted while you were working"),
				);
				const gen3Notes = childRequestsPayloads[2]!.messages.filter((message) =>
					messageText(message).includes("Atomic restarted while you were working"),
				);
				assert.equal(gen2Notes.length, 1, `expected 1 restart note in gen2, got ${gen2Notes.length}`);
				assert.equal(gen3Notes.length, 2, `expected 2 restart notes across 2 crashes, got ${gen3Notes.length}`);

				program.write("/tasks\r");
				await program.waitForScreen(
					(screen) => screen.includes("worker") && /Tasks|HOLD_WORKER_TASK|running/i.test(screen),
					STEP_TIMEOUT_MS,
					"restored worker listed in /tasks after second crash",
				);
				assert.doesNotMatch(program.screen(), /Session recovery failed/i);

				releaseChildGen3.resolve();
				program.write("\x1b");
				await sleep(200);
				program.write("/quit\r");
				const exit = await program.exited;
				assert.equal(exit.timedOut, false);
			} finally {
				releaseChildGen3.resolve();
				for (const res of [...openResponses]) res.destroy();
				program?.kill();
				await server.close();
				await removeTempRootReleasingBroker(root, agentDir);
			}
		},
		POST_CRASH_PTY_TIMEOUT_MS,
	);
});
