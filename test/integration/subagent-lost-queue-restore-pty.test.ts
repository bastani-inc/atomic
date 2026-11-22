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
import { fileExistsSync, makeTempDirectory, moduleDir, readTextSync, sleep } from "../helpers/runtime.js";
import { type ChatRequest, messageText } from "../helpers/scripted-chat-server.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
/** Real PTY session with isolated-engine crash, receipt lookup, subagent restore, and child composer reopen. */
const SUBAGENT_QUEUE_PTY_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 45_000;
const POLL_MS = 50;
const PROVIDER = "guard-loopback";
const MODEL = "guard-model";

const TEST_EXTENSION = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const cfg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixture.json"), "utf8"));
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part && part.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}
export default (atomic) => {
	atomic.on("session_start", (_event, ctx) => {
		if (ctx.subagentPolicy !== undefined || ctx.isPresentationOnly === true) return;
		appendFileSync(cfg.pidFile, JSON.stringify({ pid: process.pid }) + "\\n");
	});
	atomic.on("message_end", async (event, ctx) => {
		if (ctx.subagentPolicy === undefined) return;
		if (event.message.role !== "user") return;
		if (!textOf(event.message.content).includes("UNSENT_SUBAGENT_MSG")) return;
		writeFileSync(cfg.takenFile, String(process.pid));
		// Hold before appendMessage so the message is shown unsaved with an authoritative receipt and absent from disk.
		await new Promise(() => {});
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

describe("restoring a lost subagent chat's unsaved queued messages in a real PTY", () => {
	test(
		"crash -> main pending notice -> reopen child -> child composer holds unsent absent-receipt and listed messages once, never touching main",
		async () => {
			const root = makeTempDirectory("atomic-subagent-queue-pty-");
			const agentDir = join(root, "agent");
			const extensionsDir = join(agentDir, "extensions");
			const project = join(root, "project");
			const sessionsDir = join(root, "sessions");
			const installed = join(root, "installed");
			const pidFile = join(root, "engine-pids.jsonl");
			const takenFile = join(root, "child-taken.txt");

			const childGen1Started = Promise.withResolvers<void>();
			const releaseChildGen1 = Promise.withResolvers<void>();
			const childGen2Started = Promise.withResolvers<void>();
			const releaseChildGen2 = Promise.withResolvers<void>();
			const openResponses = new Set<ServerResponse>();
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
					const isChild = !allText.includes("LAUNCH_WORKER") && allText.includes("HOLD_QUEUE_TASK");
					response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
					response.write(sseChunk({ role: "assistant", content: "" }));

					if (isChild) {
						childRequests++;
						if (childRequests === 1) {
							response.write(sseChunk({ content: "worker busy before crash" }));
							childGen1Started.resolve();
							await Promise.race([
								releaseChildGen1.promise,
								new Promise<void>((resolve) => response.once("close", resolve)),
							]);
							// Finish turn 1 so the child takes UNSENT_SUBAGENT_MSG from its steering queue (hitting message_start hook).
							if (!response.destroyed) sseEnd(response, "stop");
							return;
						}
						response.write(sseChunk({ content: "worker continuing after crash" }));
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
										id: "call_launch_worker_queue",
										type: "function",
										function: {
											name: "subagent",
											arguments: JSON.stringify({
												context: "fresh",
												agent: "worker",
												model: `${PROVIDER}/${MODEL}`,
												task: "HOLD_QUEUE_TASK",
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
				mkdirSync(extensionsDir, { recursive: true });
				writeFileSync(join(extensionsDir, "fixture.json"), JSON.stringify({ pidFile, takenFile }));
				writeFileSync(join(extensionsDir, "queue-pty-fixture.ts"), TEST_EXTENSION);
				prepareInstalledPackage(PACKAGE, installed);
				mkdirSync(project, { recursive: true });
				mkdirSync(sessionsDir, { recursive: true });

				program = startPtyProgram({
					executable: process.execPath,
					args: [join(PACKAGE, "dist/cli.js"), "--offline", "--no-mcp", "--approve", "--session-dir", sessionsDir],
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
					timeoutMs: SUBAGENT_QUEUE_PTY_TIMEOUT_MS,
					cols: 120,
					rows: 40,
				});

				const engine1Pid = await waitFor(() => readPids(pidFile)[0], STEP_TIMEOUT_MS, "engine #1 pid");
				engine1Proc = await recordProcess(engine1Pid);

				await program.waitForScreen((screen) => screen.includes("guard-model"), STEP_TIMEOUT_MS, "initial prompt");
				program.write("LAUNCH_WORKER\r");

				await Promise.race([
					childGen1Started.promise,
					sleep(STEP_TIMEOUT_MS).then(() => {
						throw new Error(`Child never started in engine #1. Screen:\n${program?.screen()}`);
					}),
				]);
				await program.waitForScreen(
					(screen) => screen.includes("WORKER_LAUNCHED_OK"),
					STEP_TIMEOUT_MS,
					"main launch reply",
				);

				// Open worker's chat view through /tasks.
				program.write("/tasks\r");
				await program.waitForScreen(
					(screen) =>
						screen.includes("enter/→ open") && screen.includes("worker") && screen.includes("HOLD_QUEUE_TASK"),
					STEP_TIMEOUT_MS,
					"worker listed in /tasks",
				);
				program.write("\r");
				await program.waitForScreen(
					(screen) => screen.includes("Message @worker"),
					STEP_TIMEOUT_MS,
					"worker chat view opened",
				);

				// Queue two steering messages while worker is busy: first will be taken pre-save, second remains listed.
				program.write("UNSENT_SUBAGENT_MSG\r");
				await program.waitForScreen(
					(screen) => screen.includes("Steering: UNSENT_SUBAGENT_MSG"),
					STEP_TIMEOUT_MS,
					"first message queued",
				);
				program.write("LISTED_SUBAGENT_MSG\r");
				await program.waitForScreen(
					(screen) => screen.includes("Steering: LISTED_SUBAGENT_MSG"),
					STEP_TIMEOUT_MS,
					"second message queued",
				);

				// End turn 1 so worker takes UNSENT_SUBAGENT_MSG and pauses in message_start (unsaved with receipt).
				releaseChildGen1.resolve();
				await waitFor(() => (fileExistsSync(takenFile) ? true : undefined), STEP_TIMEOUT_MS, "child taken message");
				// Wait for the host to observe the taken delivery status (UNSENT_SUBAGENT_MSG moved out of Steering row).
				await program.waitForScreen(
					(screen) => !screen.includes("Steering: UNSENT_SUBAGENT_MSG") && screen.includes("LISTED_SUBAGENT_MSG"),
					STEP_TIMEOUT_MS,
					"host received view status with taken receipt",
				);

				// Crash the real isolated engine process unexpectedly.
				assert.equal(await signalRecordedProcess(engine1Proc, "SIGKILL"), true);
				await waitUntilGone(engine1Proc, 10_000);

				// Wait for replacement engine #2 and the main-chat pending restore notice.
				await waitFor(
					() => readPids(pidFile).find((pid) => pid !== engine1Pid),
					STEP_TIMEOUT_MS,
					"replacement engine #2 pid",
				);
				await program.waitForScreen(
					(screen) =>
						/2 queued messages to worker weren't sent;\s*they're back in its editor when you open it/i.test(
							screen,
						),
					STEP_TIMEOUT_MS,
					"main pending restore notice",
				);

				// Main's composer must NOT hold either of the subagent's lost messages.
				const mainScreen = program.screen();
				assert.doesNotMatch(mainScreen, /❯[^\n]*UNSENT_SUBAGENT_MSG/);
				assert.doesNotMatch(mainScreen, /❯[^\n]*LISTED_SUBAGENT_MSG/);

				// Wait until post-crash recovery restored worker in engine #2, then reopen worker via /tasks.
				await Promise.race([
					childGen2Started.promise,
					sleep(STEP_TIMEOUT_MS).then(() => {
						throw new Error(`Child never restored in engine #2. Screen:\n${program?.screen()}`);
					}),
				]);
				program.write("/tasks\r");
				await program.waitForScreen(
					(screen) =>
						screen.includes("enter/→ open") && screen.includes("worker") && screen.includes("HOLD_QUEUE_TASK"),
					STEP_TIMEOUT_MS,
					"restored worker listed in /tasks",
				);
				program.write("\r");

				// Reopening worker's writable chat restores UNSENT_SUBAGENT_MSG then LISTED_SUBAGENT_MSG into its composer.
				await program.waitForScreen(
					(screen) =>
						screen.includes("UNSENT_SUBAGENT_MSG") &&
						screen.includes("LISTED_SUBAGENT_MSG") &&
						screen.includes("worker"),
					STEP_TIMEOUT_MS,
					"restored messages in worker's composer",
				);
				const childScreen = program.screen();
				const firstIdx = childScreen.indexOf("UNSENT_SUBAGENT_MSG");
				const secondIdx = childScreen.indexOf("LISTED_SUBAGENT_MSG");
				assert.ok(firstIdx >= 0 && secondIdx > firstIdx, `expected unsent before listed. Screen:\n${childScreen}`);

				// Clear worker's composer (Ctrl+C), return to main (Left), reopen worker -> one-shot (never restored twice).
				program.write("\x03");
				await program.waitForScreen(
					(screen) => !screen.includes("UNSENT_SUBAGENT_MSG") && !screen.includes("LISTED_SUBAGENT_MSG"),
					STEP_TIMEOUT_MS,
					"worker composer cleared",
				);
				program.write("\x1b[D");
				await program.waitForScreen(
					(screen) => !screen.includes("Message @worker"),
					STEP_TIMEOUT_MS,
					"returned to main",
				);
				program.write("/tasks\r");
				await program.waitForScreen(
					(screen) =>
						screen.includes("enter/→ open") && screen.includes("worker") && screen.includes("HOLD_QUEUE_TASK"),
					STEP_TIMEOUT_MS,
					"worker listed in /tasks on second open",
				);
				program.write("\r");
				await program.waitForScreen(
					(screen) => screen.includes("Message @worker"),
					STEP_TIMEOUT_MS,
					"worker reopened empty (one-shot)",
				);
				const reopenedScreen = program.screen();
				assert.doesNotMatch(reopenedScreen, /UNSENT_SUBAGENT_MSG/);
				assert.doesNotMatch(reopenedScreen, /LISTED_SUBAGENT_MSG/);

				// Clean shutdown.
				releaseChildGen2.resolve();
				program.write("\x1b[D");
				await sleep(200);
				program.write("/quit\r");
				const exit = await program.exited;
				assert.equal(exit.timedOut, false);
			} finally {
				releaseChildGen1.resolve();
				releaseChildGen2.resolve();
				for (const res of [...openResponses]) res.destroy();
				program?.kill();
				await server.close();
				await removeTempRootReleasingBroker(root, agentDir);
			}
		},
		SUBAGENT_QUEUE_PTY_TIMEOUT_MS,
	);
});
