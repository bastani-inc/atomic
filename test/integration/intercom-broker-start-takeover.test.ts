import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { isProcessAlive } from "../../packages/intercom/broker/broker-stop.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, readStreamText, sleep, spawnProcess } from "../helpers/runtime.js";
import { type ChatRequest, messageText, startScriptedChatServer } from "../helpers/scripted-chat-server.js";

const REPO = join(moduleDir(import.meta.url), "../..");
const CLI = join(REPO, "packages/coding-agent/dist/cli.js");
const JITI_CLI = join(REPO, "node_modules/jiti/lib/jiti-cli.mjs");
const CLI_START_TIMEOUT_MS = 60_000;

/**
 * The first start (session A's) announces itself and never listens; every later start runs the real broker, which the
 * spawner passes as the last argument.
 */
const FIRST_START_HANGS = `
const fs = require("node:fs");
const [marker, jiti, broker] = process.argv.slice(2);
if (!fs.existsSync(marker)) {
	const path = process.env.ATOMIC_INTERCOM_BROKER_ANNOUNCE_PATH;
	const token = process.env.ATOMIC_INTERCOM_BROKER_ANNOUNCE_TOKEN;
	if (path && token) fs.writeFileSync(path, token + " " + process.pid + "\\n");
	fs.writeFileSync(marker, String(process.pid));
	setInterval(() => {}, 1000);
} else {
	const child = require("node:child_process").spawn(process.execPath, [jiti, broker], { stdio: "inherit" });
	child.on("exit", (code) => process.exit(code ?? 0));
}
`;

test(
	"a session waiting for the broker another session was starting gets one when that session quits",
	async () => {
		const root = makeTempDirectory("intercom-broker-takeover-");
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const marker = join(root, "first-broker.pid");
		for (const dir of [agentDir, join(agentDir, "intercom"), cwd]) mkdirSync(dir, { recursive: true });
		const fakeBroker = join(root, "first-start-hangs.cjs");
		writeFileSync(fakeBroker, FIRST_START_HANGS);
		writeFileSync(
			join(agentDir, "intercom", "config.json"),
			JSON.stringify({ brokerCommand: process.execPath, brokerArgs: [fakeBroker, marker, JITI_CLI] }),
		);
		const waitingUses = Promise.withResolvers<void>();
		const server = await startScriptedChatServer(({ messages }: ChatRequest) => {
			const last = messages.at(-1);
			if (!messages.some((message) => message.role === "user" && messageText(message).includes("SESSION-B"))) {
				return { label: "a", text: "A-ACK", chunks: 1, chunkDelayMs: 0 };
			}
			if (last?.role !== "tool") {
				waitingUses.resolve();
				return {
					label: "b-list",
					text: "listing",
					chunks: 1,
					chunkDelayMs: 0,
					toolCalls: [{ name: "intercom", arguments: { action: "list" } }],
				};
			}
			return { label: "b-done", text: `B-DONE ${messageText(last)}`, chunks: 1, chunkDelayMs: 0 };
		});
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					scripted: {
						api: "openai-completions",
						apiKey: "fixture",
						baseUrl: server.baseUrl,
						models: [{ id: "local" }],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ sessionSummary: { enabled: false }, onboardedVersion: "0.0.0" }),
		);
		const osEnv: Record<string, string> = {};
		for (const key of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
			const value = process.env[key];
			if (value !== undefined) osEnv[key] = value;
		}
		const env = {
			...osEnv,
			HOME: root,
			USERPROFILE: root,
			ATOMIC_CODING_AGENT_DIR: agentDir,
			ATOMIC_CODING_AGENT_SESSION_DIR: "",
			ATOMIC_STORAGE: "",
			ATOMIC_SESSIONS_STORAGE: "",
			ATOMIC_INTERCOM_SESSION_ID: "",
			ATOMIC_INTERCOM_GROUP: "",
			ATOMIC_TELEMETRY: "0",
		};
		const args = ["--offline", "--provider", "scripted", "--model", "local"];
		const sessionA = startPtyProgram({
			executable: process.execPath,
			args: [CLI, ...args, "--approve"],
			cwd,
			// The PTY inherits this runner's environment, where the test setup turns the startup join off.
			env: { ...env, TERM: "xterm-256color", ATOMIC_INTERCOM_JOIN_AT_STARTUP: "" },
			timeoutMs: 3 * CLI_START_TIMEOUT_MS,
			cols: 160,
			rows: 40,
		});
		let firstBrokerPid: number | undefined;
		try {
			await sessionA.waitForScreen((s) => s.includes("❯"), CLI_START_TIMEOUT_MS, "session A's prompt");
			const deadline = Date.now() + CLI_START_TIMEOUT_MS;
			while (!existsSync(marker)) {
				assert.ok(Date.now() < deadline, "session A never started its broker");
				await sleep(50);
			}
			firstBrokerPid = Number(readFileSync(marker, "utf8"));

			const sessionB = spawnProcess([process.execPath, CLI, ...args, "--no-session", "-p", "SESSION-B"], {
				cwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
				timeout: 2 * CLI_START_TIMEOUT_MS,
			});
			const outcome = Promise.all([
				sessionB.exited,
				readStreamText(sessionB.stdout),
				readStreamText(sessionB.stderr),
			]);
			await waitingUses.promise;
			// B is now waiting for the broker A is starting; A quits, which stops that start.
			await sleep(1_000);
			sessionA.write("/quit");
			await sessionA.waitForScreen((s) => s.includes("❯ /quit"), CLI_START_TIMEOUT_MS, "the quit command");
			sessionA.write("\r");
			assert.equal((await sessionA.exited).exitCode, 0);

			const [code, stdout, stderr] = await outcome;
			assert.equal(code, 0, stderr);
			assert.match(stdout, /B-DONE .*Current session/s, stdout);
		} finally {
			sessionA.kill();
			if (firstBrokerPid !== undefined && isProcessAlive(firstBrokerPid)) {
				try {
					process.kill(firstBrokerPid, "SIGKILL");
				} catch {}
			}
			try {
				await server.close();
			} finally {
				await removeTempRootReleasingBroker(root, agentDir);
			}
		}
	},
	4 * CLI_START_TIMEOUT_MS,
);
