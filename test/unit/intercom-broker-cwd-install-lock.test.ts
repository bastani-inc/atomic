import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, test } from "vitest";
import { BROKER_CONTROL_TIMEOUT_MS, controlRequest } from "../../packages/intercom/broker/control-request.js";
import { getBrokerPidPath, getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import {
	getBrokerSpawnOptions,
	getBrokerSpawnOptionsAsync,
	getJitiCliPath,
	resolveBrokerEntrypoint,
	resolveBrokerEntrypointAsync,
	spawnBrokerIfNeeded,
} from "../../packages/intercom/broker/spawn.js";
import { stopDetachedBroker } from "../helpers/detached-broker.js";
import { moduleDir, removePathSync } from "../helpers/runtime.js";

const REPO = resolve(moduleDir(import.meta.url), "../..");
const BUILT_INTERCOM_DIR = join(REPO, "packages", "coding-agent", "dist", "builtin", "intercom");
const SOURCE_INTERCOM_DIR = join(REPO, "packages", "intercom");

const tempRoots: string[] = [];
const brokerAgentDirs: string[] = [];
const savedEnv = {
	atomicAgentDir: process.env.ATOMIC_CODING_AGENT_DIR,
	piAgentDir: process.env.PI_CODING_AGENT_DIR,
};

function makeTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	while (brokerAgentDirs.length > 0) {
		const agentDir = brokerAgentDirs.pop()!;
		await stopDetachedBroker(agentDir);
	}
	if (savedEnv.atomicAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = savedEnv.atomicAgentDir;
	if (savedEnv.piAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedEnv.piAgentDir;
	while (tempRoots.length > 0) {
		removePathSync(tempRoots.pop()!, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	}
});

describe("Intercom broker working directory never pins the installation directory", () => {
	test("getBrokerSpawnOptions and getBrokerSpawnOptionsAsync choose a safe cwd outside extensionDir, install root, project cwd, and agentDir", async () => {
		const root = makeTempRoot("ic-cwd-opt-");
		const installPkg = join(root, "node_modules", "@bastani", "atomic");
		const extensionDir = join(installPkg, "dist", "builtin", "intercom");
		const agentDir = join(root, "agent");
		mkdirSync(extensionDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_CODING_AGENT_DIR;

		const syncOptions = getBrokerSpawnOptions(extensionDir);
		const asyncOptions = await getBrokerSpawnOptionsAsync(extensionDir);

		for (const options of [syncOptions, asyncOptions]) {
			assert.equal(isAbsolute(options.cwd), true, `expected absolute cwd, got ${options.cwd}`);
			const normCwd = resolve(options.cwd).toLowerCase();
			for (const forbidden of [extensionDir, installPkg, join(root, "node_modules", "@bastani"), agentDir]) {
				const normForbidden = resolve(forbidden).toLowerCase();
				assert.equal(
					normCwd === normForbidden ||
						normCwd.startsWith(`${normForbidden}${process.platform === "win32" ? "\\" : "/"}`),
					false,
					`broker cwd ${options.cwd} must not be inside ${forbidden}`,
				);
			}
			if (process.platform !== "win32") {
				assert.equal(options.cwd, "/");
			} else {
				assert.equal(options.cwd.startsWith("\\\\?\\"), false, `expected short Windows cwd, got ${options.cwd}`);
				assert.ok(options.cwd.length < 248, `expected <248-char Windows cwd, got ${options.cwd.length}`);
			}
		}
	});

	test("resolves broker entrypoint, jiti runner, and relative agent-dir env to absolute paths independent of broker cwd", async () => {
		const relExtensionDir = "packages/intercom";
		const syncEntry = resolveBrokerEntrypoint(relExtensionDir);
		const asyncEntry = await resolveBrokerEntrypointAsync(relExtensionDir);
		const jitiCli = getJitiCliPath(relExtensionDir);

		assert.equal(isAbsolute(syncEntry), true, `expected absolute entrypoint, got ${syncEntry}`);
		assert.equal(isAbsolute(asyncEntry), true, `expected absolute async entrypoint, got ${asyncEntry}`);
		assert.equal(isAbsolute(jitiCli), true, `expected absolute jiti CLI path, got ${jitiCli}`);

		process.env.ATOMIC_CODING_AGENT_DIR = join("relative-agent-dir", "nested");
		delete process.env.PI_CODING_AGENT_DIR;
		const expectedAbs = resolve(process.env.ATOMIC_CODING_AGENT_DIR);

		assert.equal(getBrokerSpawnOptions(SOURCE_INTERCOM_DIR).env.ATOMIC_CODING_AGENT_DIR, expectedAbs);
		assert.equal((await getBrokerSpawnOptionsAsync(SOURCE_INTERCOM_DIR)).env.ATOMIC_CODING_AGENT_DIR, expectedAbs);
	});

	test("spawning the real bundled broker leaves the install directory renameable on disk while the broker stays alive", async () => {
		assert.equal(
			existsSync(join(BUILT_INTERCOM_DIR, "broker", "broker.bundle.mjs")),
			true,
			"built intercom bundle required",
		);
		const root = makeTempRoot("ic-rename-live-");
		const scopeDir = join(root, "node_modules", "@bastani");
		const installPkg = join(scopeDir, "atomic");
		const extensionDir = join(installPkg, "dist", "builtin", "intercom");
		const agentDir = join(root, "agent");
		mkdirSync(dirname(extensionDir), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		cpSync(BUILT_INTERCOM_DIR, extensionDir, { recursive: true });

		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_CODING_AGENT_DIR;
		brokerAgentDirs.push(agentDir);

		await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], 20_000, extensionDir);

		const pid = Number.parseInt(readFileSync(getBrokerPidPath(agentDir), "utf8").trim(), 10);
		assert.ok(Number.isInteger(pid) && pid > 0, `expected valid broker pid, got ${pid}`);

		if (process.platform === "linux") {
			const liveCwd = readlinkSync(`/proc/${pid}/cwd`);
			assert.equal(liveCwd, "/", `broker live cwd should be / on Linux, got ${liveCwd}`);
		}

		// Mirror what `npm install -g` does first: rename `@bastani/atomic` -> `@bastani/.atomic-retire`.
		// On Windows, a broker whose cwd is `dist\builtin\intercom` fails this rename with EBUSY.
		const retiredPkg = join(scopeDir, ".atomic-retire");
		renameSync(installPkg, retiredPkg);
		assert.equal(existsSync(retiredPkg), true);

		// Confirm the broker is still alive and answering control requests after the install directory moved.
		const socketPath = getBrokerSocketPath(process.platform, agentDir);
		const answer = await controlRequest(socketPath, "broker_status", "broker_status", BROKER_CONTROL_TIMEOUT_MS);
		assert.equal(answer.connected, true);
	});

	test("custom relative brokerCommand resolves against caller cwd rather than broker safe cwd", async () => {
		const root = makeTempRoot("ic-rel-cmd-");
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const script = join(root, "probe-cwd.cjs");
		const outFile = join(root, "recorded-cwd.txt");
		writeFileSync(
			script,
			`const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(outFile)}, process.cwd()); process.exit(9);\n`,
			"utf8",
		);
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_CODING_AGENT_DIR;
		brokerAgentDirs.push(agentDir);

		await assert.rejects(
			() => spawnBrokerIfNeeded(process.execPath, [script], 10_000, SOURCE_INTERCOM_DIR),
			/exited before startup with code 9/u,
		);
		const recordedCwd = readFileSync(outFile, "utf8").trim();
		assert.notEqual(resolve(recordedCwd).toLowerCase(), resolve(SOURCE_INTERCOM_DIR).toLowerCase());
		if (process.platform !== "win32") {
			assert.equal(recordedCwd, "/");
		}
	});

	test("spawning the real broker succeeds when ATOMIC_CODING_AGENT_DIR is relative (absolutizing broker.log and env for relay)", async () => {
		const root = makeTempRoot("ic-rel-agent-live-");
		const relAgent = join(root, "rel-agent");
		mkdirSync(relAgent, { recursive: true });
		const origCwd = process.cwd();
		process.chdir(root);
		process.env.ATOMIC_CODING_AGENT_DIR = process.platform === "win32" ? ".\\rel-agent" : "./rel-agent";
		delete process.env.PI_CODING_AGENT_DIR;
		brokerAgentDirs.push(relAgent);
		try {
			await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], 20_000, BUILT_INTERCOM_DIR);
			const socketPath = getBrokerSocketPath(process.platform, relAgent);
			const answer = await controlRequest(socketPath, "broker_status", "broker_status", BROKER_CONTROL_TIMEOUT_MS);
			assert.equal(answer.connected, true);
		} finally {
			process.chdir(origCwd);
		}
	});

	test.runIf(process.platform === "win32")(
		"spawning the real Windows broker resolves drive-relative rooted paths on subst drives and mixed-case env keys",
		async () => {
			const root = makeTempRoot("ic-win-r2-");
			const driveRoot = join(root, "drive");
			const proj = join(driveRoot, "proj");
			const rootedAgent = join(driveRoot, "r-agent");
			const extDir = join(driveRoot, "pkg", "dist", "builtin", "intercom");
			mkdirSync(proj, { recursive: true });
			mkdirSync(rootedAgent, { recursive: true });
			mkdirSync(extDir, { recursive: true });
			cpSync(BUILT_INTERCOM_DIR, extDir, { recursive: true });

			const drive = ["R:", "T:", "U:", "V:", "W:", "X:", "Y:", "Z:"].find((letter) => !existsSync(`${letter}\\`));
			assert.ok(drive, "expected an available Windows drive letter for subst");
			execFileSync("subst.exe", [drive!, driveRoot], { stdio: "ignore" });
			const origCwd = process.cwd();
			try {
				process.chdir(`${drive}\\proj`);
				process.env.ATOMIC_CODING_AGENT_DIR = "\\r-agent";
				delete process.env.PI_CODING_AGENT_DIR;
				brokerAgentDirs.push(rootedAgent);

				const opts = await getBrokerSpawnOptionsAsync(`${drive}\\pkg\\dist\\builtin\\intercom`);
				assert.equal(opts.env.ATOMIC_CODING_AGENT_DIR, `${drive}\\r-agent`);

				await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], 20_000, `${drive}\\pkg\\dist\\builtin\\intercom`);
				assert.equal(existsSync(`${drive}\\r-agent\\intercom\\broker.pid`), true);
				const answer = await controlRequest(
					getBrokerSocketPath("win32", `${drive}\\r-agent`),
					"broker_status",
					"broker_status",
					BROKER_CONTROL_TIMEOUT_MS,
				);
				assert.equal(answer.connected, true);
				await stopDetachedBroker(rootedAgent);

				const lowerAgent = join(proj, "rel-lower");
				mkdirSync(lowerAgent, { recursive: true });
				delete process.env.ATOMIC_CODING_AGENT_DIR;
				process.env.atomic_coding_agent_dir = ".\\rel-lower";
				brokerAgentDirs.push(lowerAgent);
				try {
					const lowerOpts = await getBrokerSpawnOptionsAsync(BUILT_INTERCOM_DIR);
					const matching = Object.entries(lowerOpts.env).filter(
						([k]) => k.toLowerCase() === "atomic_coding_agent_dir",
					);
					assert.equal(
						matching.length,
						1,
						`expected single case-insensitive key, got ${JSON.stringify(matching)}`,
					);
					assert.equal((matching[0]![1] ?? "").toLowerCase(), `${drive}\\proj\\rel-lower`.toLowerCase());

					await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"], 20_000, BUILT_INTERCOM_DIR);
					const lowerAnswer = await controlRequest(
						getBrokerSocketPath("win32", `${drive}\\proj\\rel-lower`),
						"broker_status",
						"broker_status",
						BROKER_CONTROL_TIMEOUT_MS,
					);
					assert.equal(lowerAnswer.connected, true);
				} finally {
					delete process.env.atomic_coding_agent_dir;
				}
			} finally {
				process.chdir(origCwd);
				await stopDetachedBroker(rootedAgent);
				await stopDetachedBroker(join(proj, "rel-lower"));
				try {
					execFileSync("subst.exe", [drive!, "/D"], { stdio: "ignore" });
				} catch {}
			}
		},
	);
});
