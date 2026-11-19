import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { LifecycleTraceLine } from "../../packages/coding-agent/src/core/lifecycle-timings.ts";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, readStreamText, spawnProcess } from "../helpers/runtime.js";
import { messageText, startScriptedChatServer } from "../helpers/scripted-chat-server.js";

const CLI = join(moduleDir(import.meta.url), "../../packages/coding-agent/dist/cli.js");
const NAMES = ["/workflow", "/workflows", "/workflow-authoring"];
// A real CLI startup loads its bundled resources under Node. Print mode starts once for each input.
const CLI_START_TIMEOUT_MS = 60_000;

const modelReply = (input: string) => `Test model received [${input}]`;
const extensionReply = (input: string) => `USER-COMMAND-RAN[${input.slice("/workflow".length).trim()}]`;

async function isolatedProfile(userCommand: boolean, enableSkillCommands = false) {
	const root = makeTempDirectory("workflow-command-routing-");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	if (userCommand) {
		mkdirSync(join(agentDir, "extensions"));
		writeFileSync(
			join(agentDir, "extensions", "user-command.ts"),
			`export default (api) => {
			api.registerCommand("workflow", { description: "User-owned command", handler: async (args, ctx) => {
				const message = "USER-COMMAND-RAN[" + args + "]";
				if (ctx.hasUI) ctx.ui.notify(message, "info");
				else await api.sendMessage({ customType: "user-command", content: message, display: true }, { triggerTurn: false });
			} });
		};`,
		);
	}
	if (enableSkillCommands) {
		const dir = join(agentDir, "skills", "foo-files");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			"---\nname: foo-files\ndescription: A normal completion control.\n---\nRead a file.",
		);
	}
	const requests: string[] = [];
	const server = await startScriptedChatServer(({ messages }) => {
		const input = messageText(messages.findLast((message) => message.role === "user"));
		requests.push(input);
		return {
			label: String(requests.length),
			text: enableSkillCommands ? `Skill reply ${requests.length}` : modelReply(input),
			chunks: 1,
			chunkDelayMs: 0,
		};
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
	// Compare submitted commands, not intentionally selected skill completions.
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ enableSkillCommands, sessionSummary: { enabled: false }, onboardedVersion: "0.0.0" }),
	);
	const osEnv: Record<string, string> = {};
	for (const key of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
		const value = process.env[key];
		if (value !== undefined) osEnv[key] = value;
	}
	return {
		cwd,
		requests,
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
		async close() {
			try {
				await server.close();
			} finally {
				await removeTempRootReleasingBroker(root, agentDir);
			}
		},
	};
}

for (const userCommand of [false, true]) {
	describe(userCommand ? "a user-registered /workflow" : "unregistered workflow names behave like /foo", () => {
		const inputs = userCommand
			? ["/workflow", "/workflow custom argument"]
			: ["/foo", ...NAMES, ...NAMES.map((name) => `${name} old argument`)];
		const expected = userCommand ? extensionReply : modelReply;

		test(
			"print returns the normal result and exit code",
			async () => {
				const profile = await isolatedProfile(userCommand);
				try {
					for (const input of inputs) {
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
						assert.equal(stdout.trim(), expected(input));
					}
					assert.deepEqual(profile.requests, userCommand ? [] : inputs);
				} finally {
					await profile.close();
				}
			},
			7 * CLI_START_TIMEOUT_MS,
		);

		test(
			"JSON print mode emits ordinary replies or the user extension’s output",
			async () => {
				const profile = await isolatedProfile(userCommand);
				try {
					const child = spawnProcess(
						[process.execPath, CLI, ...profile.args, "--no-session", "--mode", "json", ...inputs],
						{ cwd: profile.cwd, env: profile.env, stdout: "pipe", stderr: "pipe", timeout: CLI_START_TIMEOUT_MS },
					);
					const [code, stdout, stderr] = await Promise.all([
						child.exited,
						readStreamText(child.stdout),
						readStreamText(child.stderr),
					]);
					assert.equal(code, 0, stderr);
					const results = stdout
						.trim()
						.split("\n")
						.map(
							(line) =>
								JSON.parse(line) as {
									type: string;
									message?: { role: string; content: string | Array<{ type: string; text?: string }> };
								},
						)
						.flatMap(({ type, message }) => {
							if (type !== "message_end" || message?.role !== (userCommand ? "custom" : "assistant")) return [];
							return [
								typeof message.content === "string"
									? message.content
									: message.content.map((part) => part.text ?? "").join(""),
							];
						});
					assert.deepEqual(results, inputs.map(expected));
					assert.deepEqual(profile.requests, userCommand ? [] : inputs);
				} finally {
					await profile.close();
				}
			},
			CLI_START_TIMEOUT_MS,
		);

		test(
			"RPC returns the normal disposition and dispatches once",
			async () => {
				const profile = await isolatedProfile(userCommand);
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
					for (const input of inputs) {
						const ended = Promise.withResolvers<void>();
						const stop = client.onEvent((event) => {
							if (event.type === "agent_end") ended.resolve();
						});
						try {
							assert.equal(await client.prompt(input), userCommand ? "handled" : "started", input);
							if (userCommand) assert.equal(notices.pop(), expected(input));
							else await ended.promise;
						} finally {
							stop();
						}
					}
					assert.deepEqual(profile.requests, userCommand ? [] : inputs);
				} finally {
					await client.stop();
					await profile.close();
				}
			},
			CLI_START_TIMEOUT_MS,
		);

		test.each(["in-process", "isolated"] as const)(
			"the %s terminal dispatches the submitted text normally",
			async (host) => {
				const profile = await isolatedProfile(userCommand);
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
					for (const input of inputs) {
						program.write(input);
						await program.waitForScreen((s) => s.includes(`❯ ${input}`), CLI_START_TIMEOUT_MS, input);
						program.write("\r");
						await program.waitForScreen(
							(s) => s.includes(expected(input)) || s.includes(modelReply(input)),
							CLI_START_TIMEOUT_MS,
							expected(input),
						);
						assert.ok(program.screen().includes(expected(input)), program.screen());
					}
					assert.deepEqual(profile.requests, userCommand ? [] : inputs);
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
	});
}

test(
	"Enter and Tab on /workflows use the highlighted skill just like another fuzzy prefix",
	async () => {
		const profile = await isolatedProfile(false, true);
		const program = startPtyProgram({
			executable: process.execPath,
			args: [CLI, ...profile.args, "--approve"],
			cwd: profile.cwd,
			env: { ...profile.env, TERM: "xterm-256color" },
			timeoutMs: 2 * CLI_START_TIMEOUT_MS,
			cols: 200,
			rows: 48,
		});
		try {
			await program.waitForScreen(
				(s) => s.includes("[Skills]") && s.includes("foo-files") && s.includes("workflow-files"),
				CLI_START_TIMEOUT_MS,
				"the loaded skill catalog",
			);
			for (const tab of [false, true]) {
				for (const [prefix, skill] of [
					["/foos", "foo-files"],
					["/workflows", "workflow-files"],
				]) {
					const before = profile.requests.length;
					let typed = "";
					for (const char of prefix) {
						program.write(char);
						typed += char;
						await program.waitForScreen(
							(s) => s.split("\n").some((line) => line.trimEnd() === `❯ ${typed}`),
							CLI_START_TIMEOUT_MS,
							typed,
						);
					}
					await program.waitForScreen(
						(s) => s.includes(`❯ skill:${skill}`),
						CLI_START_TIMEOUT_MS,
						`highlighted ${skill}`,
					);
					if (tab) {
						program.write("\t");
						await program.waitForScreen(
							(s) => s.includes(`❯ /skill:${skill}`),
							CLI_START_TIMEOUT_MS,
							`Tab to complete ${skill}`,
						);
						assert.equal(profile.requests.length, before, "Tab only completes the input");
					}
					program.write("\r");
					await program.waitForScreen(
						(s) => s.includes(`Skill reply ${before + 1}`),
						CLI_START_TIMEOUT_MS,
						`the model's answer for ${skill}`,
					);
					assert.equal(profile.requests.length, before + 1);
					assert.ok(
						profile.requests[before]!.includes(`<skill name="${skill}"`),
						`expected the model to receive ${skill}`,
					);
				}
			}
		} finally {
			program.kill();
			await program.exited;
			await profile.close();
		}
	},
	3 * CLI_START_TIMEOUT_MS,
);
