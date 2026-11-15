import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../src/core/agent-session-persistent-custom-messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { TASK_COMPLETION_MESSAGE_TYPE } from "../src/core/tasks/completion.ts";
import { bunExecutable, cliPath, removeTempDirs } from "./cli-test-helpers.ts";

/** Structural: one real CLI child in RPC mode boots, runs two model requests and a background command, and closes. */
const RPC_PROCESS_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 90_000;

const shellTool = process.platform === "win32" ? "powershell" : "bash";
/** Completes once the test creates `release` in the working directory. */
const WAIT_FOR_RELEASE =
	shellTool === "powershell"
		? "while (-not (Test-Path release)) { Start-Sleep -Milliseconds 50 }; Write-Output released"
		: "while [ ! -f release ]; do sleep 0.05; done; printf released";

const tempDirs: string[] = [];
afterEach(() => removeTempDirs(tempDirs));

/**
 * The first model request starts the command in the background; every later one streams until it is aborted. Each
 * request is counted in `requests.log`.
 */
function writeProvider(root: string): string {
	const path = join(root, "abort-provider.ts");
	writeFileSync(
		path,
		`import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@bastani/atomic";
import { createAssistantMessageEventStream } from "@bastani/pi-ai/compat";

const log = ${JSON.stringify(join(root, "requests.log"))};
let requests = 0;
export default function abortProvider(pi: ExtensionAPI): void {
	pi.registerProvider("abort-test", {
		baseUrl: "https://abort.invalid/v1",
		api: "openai-completions",
		apiKey: "local-test-key",
		models: [{
			id: "scripted",
			name: "Scripted",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: 1000,
		}],
		streamSimple: (model, _context, options) => {
			requests += 1;
			appendFileSync(log, "request\\n");
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant" as const,
				content: [] as unknown[],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as string,
				timestamp: Date.now(),
			};
			if (requests === 1) {
				message.content = [{
					type: "toolCall",
					id: "launch",
					name: ${JSON.stringify(shellTool)},
					arguments: { command: ${JSON.stringify(WAIT_FOR_RELEASE)}, wait: { kind: "background" }, timeout: 120 },
				}];
				message.stopReason = "toolUse";
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "toolUse", message } as never);
				});
				return stream;
			}
			queueMicrotask(() => stream.push({ type: "start", partial: structuredClone(message) } as never));
			const stop = () => {
				message.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: message } as never);
			};
			if (options?.signal?.aborted) stop();
			else options?.signal?.addEventListener("abort", stop, { once: true });
			return stream;
		},
	});
}
`,
	);
	return path;
}

function sessionFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => join(entry.parentPath, entry.name));
}

function customEntries(manager: SessionManager, customType: string): number {
	return manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === customType)
		.length;
}

test(
	"an RPC process that aborts while a background command's completion notice is queued closes cleanly on stdin EOF and keeps the notice once (#5166)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "rpc-abort-notice-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		mkdirSync(agentDir, { recursive: true });
		const provider = writeProvider(root);
		const child = spawn(
			bunExecutable(),
			[
				cliPath,
				"--mode",
				"rpc",
				"--provider",
				"abort-test",
				"--model",
				"scripted",
				"--no-extensions",
				"--extension",
				provider,
				"--tools",
				shellTool,
				"--session-dir",
				sessionDir,
			],
			{
				cwd: root,
				env: {
					...process.env,
					ANTHROPIC_API_KEY: "",
					ANTHROPIC_OAUTH_TOKEN: "",
					ATOMIC_CODING_AGENT_DIR: agentDir,
					PI_CODING_AGENT_DIR: "",
				},
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
		const records: Array<Record<string, unknown>> = [];
		const waiters: Array<{ match: (record: Record<string, unknown>) => boolean; resolve: () => void }> = [];
		let buffered = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			buffered += chunk;
			for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (!line.startsWith("{")) continue;
				const record = JSON.parse(line) as Record<string, unknown>;
				records.push(record);
				for (const waiter of [...waiters]) {
					if (waiter.match(record)) {
						waiters.splice(waiters.indexOf(waiter), 1);
						waiter.resolve();
					}
				}
			}
		});
		const waitFor = (label: string, match: (record: Record<string, unknown>) => boolean): Promise<void> => {
			if (records.some(match)) return Promise.resolve();
			const seen = Promise.withResolvers<void>();
			waiters.push({ match, resolve: seen.resolve });
			const timer = setTimeout(
				() => seen.reject(new Error(`timed out waiting for ${label}\nstderr:\n${stderr}`)),
				STEP_TIMEOUT_MS,
			);
			return seen.promise.finally(() => clearTimeout(timer));
		};
		const send = (command: object) => child.stdin.write(`${JSON.stringify(command)}\n`);
		const turnStarts = () => records.filter((record) => record.type === "turn_start").length;
		try {
			send({ id: "go", type: "prompt", message: "start the command in the background" });
			await waitFor("the second turn", () => turnStarts() >= 2);
			writeFileSync(join(root, "release"), "");
			await waitFor(
				"the completion notice",
				(record) =>
					record.type === "message_end" &&
					(record.message as { customType?: string } | undefined)?.customType === TASK_COMPLETION_MESSAGE_TYPE,
			);
			send({ id: "stop", type: "abort" });
			await waitFor("the abort response", (record) => record.type === "response" && record.id === "stop");
			child.stdin.end();
			const code = await exited;

			const abortAnswered = records.findIndex((record) => record.type === "response" && record.id === "stop");
			const [file, ...others] = sessionFiles(sessionDir);
			assert.ok(file, "the session was saved");
			assert.deepEqual(others, []);
			const reopened = await SessionManager.open(file, sessionDir, root);
			assert.deepEqual(
				{
					code,
					// Like the TUI's Esc, abort holds the queued notice instead of starting a turn for it.
					turnsAfterAbort: records.slice(abortAnswered).filter((record) => record.type === "agent_start").length,
					shutdownErrors: records.filter((record) => record.type === "shutdown_error"),
					unhandled: /unhandled/i.test(stderr),
					modelRequests: readFileSync(join(root, "requests.log"), "utf8").split("\n").filter(Boolean).length,
					cards: customEntries(reopened, TASK_COMPLETION_MESSAGE_TYPE),
					reconciliations: customEntries(reopened, PROTECTED_RECONCILIATION_CUSTOM_TYPE),
				},
				{
					code: 0,
					turnsAfterAbort: 0,
					shutdownErrors: [],
					unhandled: false,
					modelRequests: 2,
					cards: 1,
					reconciliations: 1,
				},
				stderr,
			);
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			await exited;
		}
	},
	RPC_PROCESS_TIMEOUT_MS,
);
