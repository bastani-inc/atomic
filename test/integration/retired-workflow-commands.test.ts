import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import type { LifecycleTraceLine } from "../../packages/coding-agent/src/core/lifecycle-timings.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, readStreamText, spawnProcess } from "../helpers/runtime.js";
import { messageText, startScriptedChatServer } from "../helpers/scripted-chat-server.js";

const CLI = join(moduleDir(import.meta.url), "../../packages/coding-agent/dist/cli.js");
const COMMANDS = [
	"/workflow",
	"/workflows",
	"/workflow-authoring",
	"/workflow old-run",
	"/workflows old-run",
	"/workflow-authoring old-file",
];
// The real CLI loads its bundled resources under Node; print mode starts a separate process for each invocation.
const CLI_START_TIMEOUT_MS = 60_000;

async function isolatedProfile() {
	const root = makeTempDirectory("retired-workflow-commands-");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const requests: string[] = [];
	const server = await startScriptedChatServer(({ messages }) => {
		const last = messageText(messages.findLast((message) => message.role === "user"));
		requests.push(last);
		return { label: last, text: "Response from the test model", chunks: 1, chunkDelayMs: 0 };
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
	// Keep the shell and the runner's temp directory, not the caller's provider configuration.
	const osEnv: Record<string, string> = {};
	for (const key of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
		const value = process.env[key];
		if (value !== undefined) osEnv[key] = value;
	}
	return {
		cwd,
		trace: join(root, "startup.jsonl"),
		env: {
			...osEnv,
			HOME: root,
			USERPROFILE: root,
			ATOMIC_CODING_AGENT_DIR: agentDir,
			ATOMIC_CODING_AGENT_SESSION_DIR: "",
			ATOMIC_STORAGE: "",
			ATOMIC_SESSIONS_STORAGE: "",
			ATOMIC_INTERCOM_SESSION_ID: "",
			ATOMIC_TELEMETRY: "0",
		},
		args: ["--offline", "--provider", "scripted", "--model", "local"],
		requests,
		async close() {
			try {
				await server.close();
			} finally {
				await removeTempRootReleasingBroker(root, agentDir);
			}
		},
	};
}

test(
	"print mode displays a conversion notice and exits successfully without calling the model",
	async () => {
		const profile = await isolatedProfile();
		try {
			for (const input of COMMANDS) {
				const child = spawnProcess([process.execPath, CLI, ...profile.args, "--no-session", "-p", input], {
					cwd: profile.cwd,
					env: profile.env,
					stdout: "pipe",
					stderr: "pipe",
					timeout: CLI_START_TIMEOUT_MS,
				});
				const [code, stdout, stderr] = await Promise.all([
					child.exited,
					readStreamText(child.stdout),
					readStreamText(child.stderr),
				]);
				assert.equal(code, 0, stderr);
				assert.deepEqual(profile.requests, [], input);
				assert.match(stdout, /convert.*skills/i, input);
			}
		} finally {
			await profile.close();
		}
	},
	6 * CLI_START_TIMEOUT_MS,
);

test(
	"RPC prompts acknowledge each retired command as handled and emit its conversion notice",
	async () => {
		const profile = await isolatedProfile();
		const client = new RpcClient({
			cliPath: CLI,
			runtimeExecutable: process.execPath,
			cwd: profile.cwd,
			args: [...profile.args, "--no-session"],
			env: profile.env,
		});
		const notices: string[] = [];
		client.onExtensionUIRequest((request) => {
			if (request.method === "notify") notices.push(request.message);
		});
		try {
			await client.start();
			for (const input of COMMANDS) {
				assert.equal(await client.prompt(input), "handled", input);
				assert.match(notices.pop() ?? "", /convert.*skills/i, input);
			}
			assert.deepEqual(profile.requests, []);
			// An unregistered name with the same prefix remains ordinary input.
			await client.promptAndWait("/workflow-notes");
			assert.deepEqual(profile.requests, ["/workflow-notes"]);
		} finally {
			await client.stop();
			await profile.close();
		}
	},
	CLI_START_TIMEOUT_MS,
);

test.each(["in-process", "isolated"] as const)(
	"the %s terminal displays conversion notices without a model request",
	async (host) => {
		const profile = await isolatedProfile();
		mkdirSync(join(profile.cwd, ".atomic"));
		writeFileSync(join(profile.cwd, ".atomic", "settings.json"), "{}");
		const program = startPtyProgram({
			executable: process.execPath,
			args: [CLI, ...profile.args, host === "isolated" ? "--approve" : "--no-approve"],
			cwd: profile.cwd,
			env: { ...profile.env, TERM: "xterm-256color", ATOMIC_STARTUP_TRACE: profile.trace },
			timeoutMs: 2 * CLI_START_TIMEOUT_MS,
			cols: 200,
			rows: 48,
		});
		try {
			await program.waitForScreen((s) => s.includes("❯"), CLI_START_TIMEOUT_MS, "the prompt");
			for (const input of COMMANDS) {
				program.write(input);
				await program.waitForScreen((s) => s.includes(`❯ ${input}`), CLI_START_TIMEOUT_MS, input);
				program.write("\r");
				const notice = `${input.split(" ")[0]} was removed. Workflows are now skills.`;
				await program.waitForScreen(
					(s) => s.includes("Response from the test model") || (s.includes(notice) && !s.includes(`❯ ${input}`)),
					CLI_START_TIMEOUT_MS,
					notice,
				);
				assert.match(program.screen(), /convert your old workflow files into skills/i);
				assert.deepEqual(profile.requests, [], input);
			}
			program.write("control prompt");
			await program.waitForScreen((s) => s.includes("❯ control prompt"), CLI_START_TIMEOUT_MS, "the control prompt");
			program.write("\r");
			await program.waitForScreen(
				(s) => s.includes("Response from the test model"),
				CLI_START_TIMEOUT_MS,
				"the control response",
			);
			assert.deepEqual(profile.requests, ["control prompt"]);
			program.write("/quit");
			await program.waitForScreen((s) => s.includes("❯ /quit"), CLI_START_TIMEOUT_MS, "the quit command");
			program.write("\r");
			assert.equal((await program.exited).exitCode, 0);
			const trace = readFileSync(profile.trace, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as LifecycleTraceLine);
			assert.equal(
				trace.some((mark) => mark.label === "interactive-engine-spawn"),
				host === "isolated",
			);
		} finally {
			program.kill();
			await program.exited;
			await profile.close();
		}
	},
	3 * CLI_START_TIMEOUT_MS,
);
