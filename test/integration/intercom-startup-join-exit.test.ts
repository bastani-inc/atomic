import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { isProcessAlive } from "../../packages/intercom/broker/broker-stop.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, sleep } from "../helpers/runtime.js";
import { startScriptedChatServer } from "../helpers/scripted-chat-server.js";

const CLI = join(moduleDir(import.meta.url), "../../packages/coding-agent/dist/cli.js");
const CLI_START_TIMEOUT_MS = 60_000;
/** Quitting a session whose Intercom has not started yet takes about 0.2 s; a waited-for broker start takes seconds. */
const EXIT_BOUND_MS = 3_000;
const BROKER_GONE_BOUND_MS = 2_000;

/** A broker that starts, announces itself as a real one does, and never listens. */
const HUNG_BROKER = `
const fs = require("node:fs");
const path = process.env.ATOMIC_INTERCOM_BROKER_ANNOUNCE_PATH;
const token = process.env.ATOMIC_INTERCOM_BROKER_ANNOUNCE_TOKEN;
if (path && token) fs.writeFileSync(path, token + " " + process.pid + "\\n");
fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`;

async function hungBrokerProfile() {
	const root = makeTempDirectory("intercom-startup-join-exit-");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const marker = join(root, "broker.pid");
	for (const dir of [agentDir, join(agentDir, "intercom"), cwd]) mkdirSync(dir, { recursive: true });
	const server = await startScriptedChatServer(() => ({ label: "reply", text: "B-ACK", chunks: 1, chunkDelayMs: 0 }));
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
	// A script file rather than `-e`: on Windows the broker command runs through a launcher's command line.
	const hungBroker = join(root, "hung-broker.cjs");
	writeFileSync(hungBroker, HUNG_BROKER);
	writeFileSync(
		join(agentDir, "intercom", "config.json"),
		JSON.stringify({ brokerCommand: process.execPath, brokerArgs: [hungBroker, marker] }),
	);
	const osEnv: Record<string, string> = {};
	for (const key of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
		const value = process.env[key];
		if (value !== undefined) osEnv[key] = value;
	}
	return {
		cwd,
		marker,
		env: {
			...osEnv,
			HOME: root,
			USERPROFILE: root,
			TERM: "xterm-256color",
			ATOMIC_CODING_AGENT_DIR: agentDir,
			ATOMIC_CODING_AGENT_SESSION_DIR: "",
			ATOMIC_STORAGE: "",
			ATOMIC_SESSIONS_STORAGE: "",
			ATOMIC_INTERCOM_SESSION_ID: "",
			ATOMIC_INTERCOM_GROUP: "",
			// The PTY inherits this runner's environment, where the test setup turns the startup join off.
			ATOMIC_INTERCOM_JOIN_AT_STARTUP: "",
			ATOMIC_TELEMETRY: "0",
		},
		brokerPid(): number | undefined {
			return existsSync(marker) ? Number(readFileSync(marker, "utf8")) : undefined;
		},
		async close() {
			try {
				await server.close();
			} finally {
				await removeTempRootReleasingBroker(root, agentDir);
			}
		},
	};
}

describe("quitting a session whose startup join is waiting for a broker that never listens", () => {
	for (const host of ["isolated", "in-process"] as const) {
		test(
			`exits at once and leaves no broker running (${host} terminal)`,
			async () => {
				const profile = await hungBrokerProfile();
				const session = startPtyProgram({
					executable: process.execPath,
					args: [
						CLI,
						"--offline",
						"--provider",
						"scripted",
						"--model",
						"local",
						host === "isolated" ? "--approve" : "--no-approve",
					],
					cwd: profile.cwd,
					env: profile.env,
					timeoutMs: 3 * CLI_START_TIMEOUT_MS,
					cols: 160,
					rows: 40,
				});
				let brokerPid: number | undefined;
				try {
					await session.waitForScreen((s) => s.includes("❯"), CLI_START_TIMEOUT_MS, "the prompt");
					if (host === "in-process") {
						// An untrusted folder joins once its first prompt starts.
						session.write("hello");
						await session.waitForScreen((s) => s.includes("❯ hello"), CLI_START_TIMEOUT_MS, "the first prompt");
						session.write("\r");
						await session.waitForScreen((s) => s.includes("B-ACK"), CLI_START_TIMEOUT_MS, "the first reply");
					}
					const deadline = Date.now() + CLI_START_TIMEOUT_MS;
					brokerPid = profile.brokerPid();
					while (brokerPid === undefined) {
						assert.ok(Date.now() < deadline, "the session never started a broker");
						await sleep(50);
						brokerPid = profile.brokerPid();
					}
					session.write("/quit");
					await session.waitForScreen((s) => s.includes("❯ /quit"), CLI_START_TIMEOUT_MS, "the quit command");
					const quitAt = performance.now();
					session.write("\r");
					assert.equal((await session.exited).exitCode, 0);
					const exitMs = performance.now() - quitAt;
					assert.ok(exitMs < EXIT_BOUND_MS, `quitting waited ${Math.round(exitMs)} ms for the broker start`);
					// On Windows the isolated terminal stops its engine with TerminateProcess, so the engine cannot stop a
					// broker start in flight; a broker that does start listening retires on its own once no session joins.
					if (process.platform !== "win32" || host === "in-process") {
						const goneBy = Date.now() + BROKER_GONE_BOUND_MS;
						while (isProcessAlive(brokerPid) && Date.now() < goneBy) await sleep(50);
						assert.equal(isProcessAlive(brokerPid), false, "the broker the session started outlived it");
					}
				} finally {
					session.kill();
					if (brokerPid !== undefined && isProcessAlive(brokerPid)) {
						try {
							process.kill(brokerPid, "SIGKILL");
						} catch {}
					}
					await profile.close();
				}
			},
			4 * CLI_START_TIMEOUT_MS,
		);
	}
});
