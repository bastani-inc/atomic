import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, test } from "vitest";
import { BROKER_READY_TIMEOUT_MS } from "../../packages/intercom/broker/startup-timeout.js";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { startPtyProgram } from "../helpers/pty-program.js";
import {
	type RecordedProcess,
	recordProcess,
	signalRecordedProcess,
	waitUntilGone,
} from "../helpers/recorded-process.js";
import { makeTempDirectory, moduleDir, sleep } from "../helpers/runtime.js";
import { startScriptedChatServer } from "../helpers/scripted-chat-server.js";

const CLI = join(moduleDir(import.meta.url), "../../packages/coding-agent/dist/cli.js");
const CLI_START_TIMEOUT_MS = 60_000;
/**
 * How long each host's quit may take. Its shutdown handlers get 5 s (ENGINE_SHUTDOWN_GRACE_MS): a quit that waited for
 * the broker start is cut there and leaves the broker running, which the broker check catches on both hosts. In the
 * in-process terminal the quit stops the start as it begins: under 0.3 s on an idle Linux machine, and up to 5.4 s on
 * a loaded Windows one, past the grace itself. Its bound is half the time a broker start is waited for: a quit that
 * waited for the start without being cut at the grace would take nearly that whole wait (BROKER_READY_TIMEOUT_MS). An
 * isolated terminal's quit also ends its engine and then exits the host, which on a loaded Windows machine can take
 * past the grace on its own, with or without a broker; this test does not bound that, and holds it only to the CLI's
 * step bound, so a quit that hangs still fails.
 */
const IN_PROCESS_EXIT_BOUND_MS = BROKER_READY_TIMEOUT_MS / 2;
const EXIT_BOUND_MS = { "in-process": IN_PROCESS_EXIT_BOUND_MS, isolated: CLI_START_TIMEOUT_MS } as const;
const BROKER_GONE_BOUND_MS = 2_000;

/** A broker that starts, announces itself as a real one does (with when it was created, when asked), and never listens. */
const HUNG_BROKER = `
const fs = require("node:fs");
const path = process.env.ATOMIC_INTERCOM_BROKER_ANNOUNCE_PATH;
const token = process.env.ATOMIC_INTERCOM_BROKER_ANNOUNCE_TOKEN;
const started = process.env.ATOMIC_INTERCOM_BROKER_ANNOUNCE_START === "1" && process.platform === "win32"
	? require(${JSON.stringify(createRequire(import.meta.url).resolve("@bastani/atomic-natives"))}).processCreationTime(process.pid)
	: null;
if (path && token) fs.writeFileSync(path, token + " " + process.pid + (started === null ? "" : " " + started) + "\\n");
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
		compileCache: join(root, "compile-cache"),
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

/**
 * Run a session once, unmeasured, in the compile cache the measured run then uses: start it, send its first prompt
 * and quit. It does not join Intercom, so it starts no broker.
 */
async function warmCompileCache(args: readonly string[], cwd: string, env: Record<string, string>): Promise<void> {
	const warmup = startPtyProgram({
		executable: process.execPath,
		args,
		cwd,
		env: { ...env, ATOMIC_INTERCOM_JOIN_AT_STARTUP: "0" },
		timeoutMs: 3 * CLI_START_TIMEOUT_MS,
		cols: 160,
		rows: 40,
	});
	try {
		await warmup.waitForScreen((s) => s.includes("❯"), CLI_START_TIMEOUT_MS, "the warm-up prompt");
		warmup.write("hello");
		await warmup.waitForScreen((s) => s.includes("❯ hello"), CLI_START_TIMEOUT_MS, "the warm-up's first prompt");
		warmup.write("\r");
		await warmup.waitForScreen((s) => s.includes("B-ACK"), CLI_START_TIMEOUT_MS, "the warm-up's first reply");
		warmup.write("/quit");
		await warmup.waitForScreen((s) => s.includes("❯ /quit"), CLI_START_TIMEOUT_MS, "the warm-up's quit command");
		warmup.write("\r");
		assert.equal((await warmup.exited).exitCode, 0);
	} finally {
		warmup.kill();
	}
}

describe("quitting a session whose startup join is waiting for a broker that never listens", () => {
	for (const host of ["isolated", "in-process"] as const) {
		test(
			`exits at once and leaves no broker running (${host} terminal)`,
			async () => {
				const profile = await hungBrokerProfile();
				const args = [
					CLI,
					"--offline",
					"--provider",
					"scripted",
					"--model",
					"local",
					host === "isolated" ? "--approve" : "--no-approve",
				];
				// Each session has a compile cache of its own. The isolated terminal's engine starts with it cold, as on
				// the first run after an install, when its runtime would spend seconds writing the cache on exit
				// (#6075). An in-process terminal writing its whole cache on exit takes seconds too, so it starts warm.
				const env = { ...profile.env, NODE_COMPILE_CACHE: profile.compileCache };
				if (host === "in-process") {
					await warmCompileCache(args, profile.cwd, env);
					assert.equal(profile.brokerPid(), undefined, "the warm-up started no broker");
				}
				const session = startPtyProgram({
					executable: process.execPath,
					args,
					cwd: profile.cwd,
					env,
					timeoutMs: 3 * CLI_START_TIMEOUT_MS,
					cols: 160,
					rows: 40,
				});
				let broker: RecordedProcess | undefined;
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
					let brokerPid = profile.brokerPid();
					while (brokerPid === undefined) {
						assert.ok(Date.now() < deadline, "the session never started a broker");
						await sleep(50);
						brokerPid = profile.brokerPid();
					}
					// #6125: recorded while it waits to be stopped, so a later process given its pid is not taken for it.
					broker = await recordProcess(brokerPid);
					session.write("/quit");
					await session.waitForScreen((s) => s.includes("❯ /quit"), CLI_START_TIMEOUT_MS, "the quit command");
					const quitAt = performance.now();
					session.write("\r");
					assert.equal((await session.exited).exitCode, 0);
					const exitMs = performance.now() - quitAt;
					assert.equal(
						await waitUntilGone(broker, BROKER_GONE_BOUND_MS, 50),
						true,
						"the broker the session started outlived it",
					);
					assert.ok(
						exitMs < EXIT_BOUND_MS[host],
						`quitting took ${Math.round(exitMs)} ms of its ${EXIT_BOUND_MS[host]} ms`,
					);
				} finally {
					session.kill();
					if (broker !== undefined) await signalRecordedProcess(broker);
					await profile.close();
				}
			},
			4 * CLI_START_TIMEOUT_MS,
		);
	}
});
