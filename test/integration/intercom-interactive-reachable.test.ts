import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, readStreamText, spawnProcess } from "../helpers/runtime.js";
import {
	type ChatRequest,
	messageText,
	type ScriptedReply,
	startScriptedChatServer,
} from "../helpers/scripted-chat-server.js";

const CLI = join(moduleDir(import.meta.url), "../../packages/coding-agent/dist/cli.js");
const CLI_START_TIMEOUT_MS = 60_000;
const LIST_ATTEMPTS = 60;
const LIST_RETRY_MS = 500;

type Reply = ScriptedReply & { readonly label: string };

const say = (label: string, text: string, delayMs = 0): Reply => ({ label, text, chunks: 1, chunkDelayMs: delayMs });
const call = (label: string, args: Record<string, unknown>, delayMs = 0): Reply => ({
	...say(label, `calling intercom ${String(args.action)}`, delayMs),
	toolCalls: [{ name: "intercom", arguments: args }],
});

/** The other session `intercom list` shows: its full id and name, from the "Other visible sessions" section. */
function otherSessions(listResult: string): Array<{ id: string; name: string }> {
	const others = listResult.split("Other visible sessions:")[1] ?? "";
	return [...others.matchAll(/- `?([0-9a-f]{8}-[0-9a-f-]{27})`? \[[^\]]*\].* name: (\S+)/g)].map((match) => ({
		id: match[1]!,
		name: match[2]!,
	}));
}

/**
 * Session A, a print session, lists its group until session B appears, then reaches B by name, by full id and by
 * 8-hex prefix, and asks it a question that B's model answers with `intercom reply`. Session B is an interactive
 * session in another directory that never uses Intercom itself.
 */
function scriptedModels() {
	const seenByB: string[] = [];
	let listed = 0;
	const script = ({ messages }: ChatRequest): Reply => {
		const last = messages.at(-1);
		const lastText = messageText(last);
		if (!messages.some((message) => message.role === "user" && messageText(message).includes("SESSION-A"))) {
			seenByB.push(messages.map((message) => messageText(message)).join("\n"));
			if (last?.role !== "tool" && lastText.includes("PLEASE-REPLY")) {
				return call("b-reply", { action: "reply", message: "PONG-FROM-B" });
			}
			return say("b-ack", "B-ACK");
		}
		if (last?.role !== "tool") return call("a-list", { action: "list" });
		const toolResults = messages.filter((message) => message.role === "tool").map((message) => messageText(message));
		const peer = toolResults.flatMap(otherSessions)[0];
		const sends = toolResults.filter((text) => text.startsWith("Message sent to")).length;
		if (sends === 3 && (lastText.startsWith("Message sent to") || lastText.includes("Current session"))) {
			// Ask once B's model has taken the three messages, so the question does not race B's own turns.
			if (!seenByB.some((text) => text.includes("PING-BY-PREFIX"))) {
				return call("a-wait-for-b", { action: "list" }, LIST_RETRY_MS);
			}
			return call("a-ask", {
				action: "ask",
				to: peer!.name,
				message: "PLEASE-REPLY",
				wait: { kind: "foreground", budgetMs: 60_000 },
			});
		}
		if (lastText.includes("Current session")) {
			const others = otherSessions(lastText);
			if (others.length === 0) {
				listed += 1;
				if (listed >= LIST_ATTEMPTS)
					return say("a-gave-up", `SESSION-B-NOT-LISTED after ${listed} lists: ${lastText}`);
				return call("a-list", { action: "list" }, LIST_RETRY_MS);
			}
			if (others.length !== 1) return say("a-duplicate", `EXPECTED-ONE-PEER: ${lastText}`);
			return call("a-send-name", { action: "send", to: peer!.name, message: "PING-BY-NAME" });
		}
		if (lastText.startsWith("Message sent to") && sends === 1) {
			return call("a-send-id", { action: "send", to: peer!.id, message: "PING-BY-ID" });
		}
		if (lastText.startsWith("Message sent to") && sends === 2) {
			return call("a-send-prefix", { action: "send", to: peer!.id.slice(0, 8), message: "PING-BY-PREFIX" });
		}
		return say("a-done", `SESSION-A-DONE ${JSON.stringify(toolResults)}`);
	};
	return { script, seenByB };
}

async function sharedProfile() {
	const root = makeTempDirectory("intercom-interactive-reachable-");
	const agentDir = join(root, "agent");
	const cwdA = join(root, "repository-a");
	const cwdB = join(root, "repository-b");
	for (const dir of [agentDir, cwdA, cwdB]) mkdirSync(dir);
	const models = scriptedModels();
	const server = await startScriptedChatServer(models.script);
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
	return {
		cwdA,
		cwdB,
		seenByB: models.seenByB,
		env: {
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

describe("an interactive session that never used Intercom is reachable from another session", () => {
	// An untrusted folder runs in the in-process terminal, where a session joins once its first prompt starts.
	for (const host of ["isolated", "in-process"] as const) {
		test(
			host === "isolated"
				? "lists an idle session, sends to it by name, id and prefix, and gets its reply (isolated terminal)"
				: "lists a session in an untrusted folder after its first prompt, sends to it and gets its reply (in-process terminal)",
			async () => {
				const profile = await sharedProfile();
				const sessionB = startPtyProgram({
					executable: process.execPath,
					args: [CLI, ...profile.args, host === "isolated" ? "--approve" : "--no-approve"],
					cwd: profile.cwdB,
					// The PTY inherits this runner's environment, where the test setup turns the startup join off.
					env: { ...profile.env, TERM: "xterm-256color", ATOMIC_INTERCOM_JOIN_AT_STARTUP: "" },
					timeoutMs: 4 * CLI_START_TIMEOUT_MS,
					cols: 200,
					rows: 48,
				});
				try {
					await sessionB.waitForScreen((s) => s.includes("❯"), CLI_START_TIMEOUT_MS, "session B's prompt");
					if (host === "in-process") {
						sessionB.write("hello");
						await sessionB.waitForScreen((s) => s.includes("❯ hello"), CLI_START_TIMEOUT_MS, "B's first prompt");
						sessionB.write("\r");
						await sessionB.waitForScreen((s) => s.includes("B-ACK"), CLI_START_TIMEOUT_MS, "B's first reply");
					}
					const sessionA = spawnProcess(
						[process.execPath, CLI, ...profile.args, "--no-session", "-p", "SESSION-A"],
						{
							cwd: profile.cwdA,
							env: profile.env,
							stdout: "pipe",
							stderr: "pipe",
							timeout: 2 * CLI_START_TIMEOUT_MS,
						},
					);
					const [code, stdout, stderr] = await Promise.all([
						sessionA.exited,
						readStreamText(sessionA.stdout),
						readStreamText(sessionA.stderr),
					]);
					assert.equal(code, 0, stderr);
					assert.doesNotMatch(stdout, /SESSION-B-NOT-LISTED|EXPECTED-ONE-PEER/, stdout);
					assert.match(stdout, /SESSION-A-DONE/, stdout);
					assert.equal((stdout.match(/Message sent to/g) ?? []).length, 3, stdout);
					assert.match(
						stdout,
						/Reply from subagent-chat-[0-9a-f-]+:[^"]{0,8}PONG-FROM-B/,
						`${stdout}\nB's model saw:\n${profile.seenByB.join("\n---\n")}\nB's screen:\n${sessionB.screen()}`,
					);
					for (const ping of ["PING-BY-NAME", "PING-BY-ID", "PING-BY-PREFIX", "PLEASE-REPLY"]) {
						assert.ok(
							profile.seenByB.some((text) => text.includes(ping)),
							`session B's model never saw ${ping}`,
						);
					}
					await sessionB.waitForScreen(
						(s) => s.includes("PLEASE-REPLY"),
						CLI_START_TIMEOUT_MS,
						"the question on B's screen",
					);
					sessionB.write("/quit");
					await sessionB.waitForScreen((s) => s.includes("❯ /quit"), CLI_START_TIMEOUT_MS, "the quit command");
					sessionB.write("\r");
					assert.equal((await sessionB.exited).exitCode, 0);
				} finally {
					sessionB.kill();
					await profile.close();
				}
			},
			6 * CLI_START_TIMEOUT_MS,
		);
	}
});
