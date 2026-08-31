#!/usr/bin/env node
/** #2765 public-boundary idle retirement: --runtime=source|compiled */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WINDOW_MS = 7_000;
const STARTUP_MS = 30_000;
const UNIX_SOCKET_PATH_MAX = 104;
const INTERNAL_BROKER_ARG = "--atomic-internal-intercom-broker";
const runtime = process.argv.find((arg) => arg.startsWith("--runtime="))?.slice("--runtime=".length);
if (runtime !== "source" && runtime !== "compiled") {
	console.error("usage: node test/helpers/intercom-broker-idle-retirement-e2e.mjs --runtime=source|compiled");
	process.exit(2);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const pidPath = (agentDir) => join(agentDir, "intercom", "broker.pid");
function socketPath(agentDir) {
	if (process.platform === "win32") {
		const segment = agentDir.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "default";
		return `\\\\.\\pipe\\pi-intercom-${segment}`;
	}
	return join(agentDir, "intercom", "broker.sock");
}
function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function bunBin() {
	const override = process.env.ATOMIC_BUN_EXECUTABLE;
	if (override && existsSync(override)) return override;
	const homeBun = join(process.env.HOME ?? "", ".bun", "bin", "bun");
	if (existsSync(homeBun)) return homeBun;
	if (spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0) return "bun";
	throw new Error("bun is required to launch the source Atomic CLI");
}
function ensureCompiled() {
	const bin = process.env.ATOMIC_COMPILED_BINARY || join(repoRoot, "packages/coding-agent/dist/atomic");
	const broker = join(dirname(bin), "builtin", "intercom", "broker", "broker.ts");
	if (existsSync(bin) && existsSync(broker)) return { bin, broker };
	const built = spawnSync("npm", ["--workspace=@bastani/atomic", "run", "build:binary"], {
		cwd: repoRoot,
		stdio: "inherit",
		env: process.env,
	});
	if (built.status !== 0) throw new Error("npm --workspace=@bastani/atomic run build:binary failed");
	if (!existsSync(bin) || !existsSync(broker)) throw new Error(`compiled broker artifacts missing: ${bin} ${broker}`);
	return { bin, broker };
}
function launchBroker(agentDir) {
	const env = { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined };
	if (runtime === "compiled") {
		const { bin, broker } = ensureCompiled();
		console.log(`[idle-retirement] launch compiled ${bin} ${INTERNAL_BROKER_ARG} ${broker}`);
		return { child: spawn(bin, [INTERNAL_BROKER_ARG, broker], { env, stdio: ["ignore", "pipe", "pipe"] }) };
	}
	const project = mkdtempSync(join(tmpdir(), "icli-"));
	const spawnHref = pathToFileURL(join(repoRoot, "packages/intercom/broker/spawn.ts")).href;
	const extension = join(project, "spawn-broker-extension.ts");
	writeFileSync(
		extension,
		`export default function () {\n  void import(${JSON.stringify(spawnHref)}).then((mod) =>\n    mod.spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]),\n  );\n}\n`,
	);
	const cli = join(repoRoot, "packages/coding-agent/src/cli.ts");
	const bun = bunBin();
	console.log(`[idle-retirement] launch source ${bun} ${cli}`);
	return {
		project,
		child: spawn(bun, [cli, "--mode", "rpc", "--offline", "--no-session", "--extension", extension], {
			cwd: project,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		}),
	};
}
async function waitPid(agentDir, child) {
	const deadline = Date.now() + STARTUP_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`launcher exited before broker pid (code ${child.exitCode} signal ${child.signalCode})`);
		}
		if (existsSync(pidPath(agentDir))) {
			const pid = Number.parseInt(readFileSync(pidPath(agentDir), "utf8").trim(), 10);
			if (Number.isFinite(pid) && pidAlive(pid)) return pid;
		}
		await sleep(20);
	}
	throw new Error("broker pid file did not appear");
}
async function waitPidExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return;
		await sleep(20);
	}
	throw new Error(`broker pid ${pid} did not exit within ${timeoutMs}ms`);
}
function connect(agentDir) {
	return new Promise((resolveConnected, reject) => {
		const socket = net.createConnection(socketPath(agentDir));
		socket.once("connect", () => resolveConnected(socket));
		socket.once("error", reject);
	});
}
function registerFrame() {
	const payload = Buffer.from(
		JSON.stringify({
			type: "register",
			session: {
				cwd: "/tmp/idle-e2e",
				model: "test-model",
				pid: process.pid,
				startedAt: Date.now(),
				lastActivity: Date.now(),
				name: "idle-e2e-live",
			},
		}),
		"utf8",
	);
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length);
	return Buffer.concat([header, payload]);
}
async function stopLaunch(launch) {
	if (launch.child.exitCode === null && launch.child.signalCode === null) {
		launch.child.kill("SIGTERM");
		await Promise.race([new Promise((resolveExit) => launch.child.once("exit", resolveExit)), sleep(1_000)]);
	}
	if (launch.project) rmSync(launch.project, { recursive: true, force: true });
}
async function runCase(name, body) {
	const runtimeMark = runtime === "compiled" ? "c" : "s";
	const agentDir = mkdtempSync(join(tmpdir(), `i${runtimeMark}${name[0]}-`));
	if (process.platform !== "win32") {
		const path = socketPath(agentDir);
		if (Buffer.byteLength(path) >= UNIX_SOCKET_PATH_MAX) {
			throw new Error(`broker socket path exceeds Unix sockaddr limit (${Buffer.byteLength(path)}): ${path}`);
		}
	}
	const launch = launchBroker(agentDir);
	try {
		const pid = await waitPid(agentDir, launch.child);
		const armedAt = Date.now();
		console.log(`[idle-retirement] runtime=${runtime} case=${name} pid=${pid} armedAt=${armedAt}`);
		await body({ agentDir, pid, armedAt });
	} finally {
		try {
			if (existsSync(pidPath(agentDir))) {
				const pid = Number.parseInt(readFileSync(pidPath(agentDir), "utf8").trim(), 10);
				if (Number.isFinite(pid)) process.kill(pid, "SIGTERM");
			}
		} catch {
			// Cleanup is best-effort.
		}
		await stopLaunch(launch);
		rmSync(agentDir, { recursive: true, force: true });
	}
}

await runCase("no-connection", async ({ pid, armedAt }) => {
	await waitPidExit(pid, WINDOW_MS);
	const elapsedMs = Date.now() - armedAt;
	if (elapsedMs > WINDOW_MS) throw new Error(`no-connection exceeded window: ${elapsedMs}ms`);
	console.log(`[idle-retirement] runtime=${runtime} case=no-connection pid=${pid} elapsedMs=${elapsedMs} exit=0`);
});
await runCase("pre-register", async ({ agentDir, pid }) => {
	const socket = await connect(agentDir);
	await new Promise((resolveClosed) => {
		socket.once("close", resolveClosed);
		socket.destroy();
	});
	const closedAt = Date.now();
	await waitPidExit(pid, WINDOW_MS);
	const elapsedMs = Date.now() - closedAt;
	if (elapsedMs > WINDOW_MS) throw new Error(`pre-register exceeded window: ${elapsedMs}ms`);
	console.log(`[idle-retirement] runtime=${runtime} case=pre-register pid=${pid} elapsedMs=${elapsedMs} exit=0`);
});
await runCase("live", async ({ agentDir, pid }) => {
	const socket = await connect(agentDir);
	socket.write(registerFrame());
	await sleep(WINDOW_MS);
	if (!pidAlive(pid)) throw new Error("registered live session was retired during the idle window");
	console.log(`[idle-retirement] runtime=${runtime} case=live pid=${pid} aliveAfterMs=${WINDOW_MS} alive=true`);
	socket.end();
});
console.log(`[idle-retirement] runtime=${runtime} ok`);
