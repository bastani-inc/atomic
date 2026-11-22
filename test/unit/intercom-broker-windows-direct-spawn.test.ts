import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep, win32 } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { stopDetachedBroker } from "../helpers/detached-broker.js";
import { removePathSync } from "../helpers/runtime.js";

const agentDir = mkdtempSync(join(tmpdir(), "ic-dir-100%TEMP%-"));
const previousAgentDirEnv = {
	atomic: process.env.ATOMIC_CODING_AGENT_DIR,
	pi: process.env.PI_CODING_AGENT_DIR,
} as const;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

type SpawnModule = typeof import("../../packages/intercom/broker/spawn.js");
type PathsModule = typeof import("../../packages/intercom/broker/paths.js");

let spawnModule: SpawnModule;
let pathsModule: PathsModule;

function createBundledJitiCli(extensionDir: string): string {
	const jitiPkg = join(extensionDir, "node_modules", "jiti", "package.json");
	const jitiCli = join(extensionDir, "node_modules", "jiti", "lib", "jiti-cli.mjs");
	mkdirSync(dirname(jitiCli), { recursive: true });
	writeFileSync(jitiPkg, JSON.stringify({ name: "jiti", version: "0.0.0" }), "utf8");
	writeFileSync(jitiCli, "export {};\n", "utf8");
	return jitiCli;
}

beforeAll(async () => {
	pathsModule = await import("../../packages/intercom/broker/paths.js");
	spawnModule = await import("../../packages/intercom/broker/spawn.js");
	mkdirSync(pathsModule.getIntercomDirPath(), { recursive: true });
});

afterAll(async () => {
	try {
		await stopDetachedBroker(agentDir);
	} finally {
		if (previousAgentDirEnv.atomic === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDirEnv.atomic;
		if (previousAgentDirEnv.pi === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv.pi;
		removePathSync(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	}
});

describe("Windows direct broker launch spec (no wscript or VBS launcher)", () => {
	test("starts Node source and bundled brokers directly on Windows without wscript or cmd", () => {
		const extDir = mkdtempSync(join(tmpdir(), "ic-ext-"));
		try {
			const jitiCli = createBundledJitiCli(extDir);
			const nodePath = String.raw`C:\Program Files\Atomic 100%\node.exe`;
			const tsBroker = join(extDir, "broker", "broker.ts");
			const tsSpec = spawnModule.getBrokerLaunchSpec(
				tsBroker,
				"npx",
				["--no-install", "tsx"],
				extDir,
				"win32",
				String.raw`C:\Users\100%user\.atomic\agent\intercom`,
				nodePath,
				"node",
				String.raw`C:\Users\100%user\.atomic\agent\intercom\broker.log`,
			);

			assert.equal(tsSpec.kind, "direct");
			assert.equal(tsSpec.command, nodePath);
			assert.deepEqual(tsSpec.args, [jitiCli, tsBroker]);
			assert.equal(win32.basename(tsSpec.command).toLowerCase(), "node.exe");
			assert.equal(tsSpec.verbatimArguments, undefined);
			assert.equal(tsSpec.noWindow, undefined);

			const bundleBroker = String.raw`C:\Users\100%user\atomic\builtin\intercom\broker\broker.bundle.mjs`;
			const bundleSpec = spawnModule.getBrokerLaunchSpec(
				bundleBroker,
				"npx",
				["--no-install", "tsx"],
				extDir,
				"win32",
				String.raw`C:\Users\100%user\.atomic\agent\intercom`,
				nodePath,
				"node",
				String.raw`C:\Users\100%user\.atomic\agent\intercom\broker.log`,
			);

			assert.equal(bundleSpec.kind, "direct");
			assert.equal(bundleSpec.command, nodePath);
			assert.deepEqual(bundleSpec.args, [bundleBroker]);
			assert.equal(bundleSpec.verbatimArguments, undefined);
			assert.equal(bundleSpec.noWindow, undefined);
		} finally {
			removePathSync(extDir, { recursive: true, force: true });
		}
	});

	test("starts Bun source and standalone binary brokers directly on Windows", () => {
		const brokerPath = String.raw`C:\Users\100%user\atomic\builtin\intercom\broker\broker.ts`;
		const bunPath = String.raw`C:\Users\100%user\.bun\bin\bun.exe`;
		const bunSpec = spawnModule.getBrokerLaunchSpec(
			brokerPath,
			"npx",
			["--no-install", "tsx"],
			String.raw`C:\ext`,
			"win32",
			String.raw`C:\agent\intercom`,
			bunPath,
			"bun-source",
		);
		assert.equal(bunSpec.kind, "direct");
		assert.equal(bunSpec.command, bunPath);
		assert.deepEqual(bunSpec.args, [brokerPath]);
		assert.equal(bunSpec.noWindow, undefined);

		const atomicExe = String.raw`C:\Program Files\Atomic\atomic.exe`;
		const binSpec = spawnModule.getBrokerLaunchSpec(
			brokerPath,
			"npx",
			["--no-install", "tsx"],
			String.raw`C:\ext`,
			"win32",
			String.raw`C:\agent\intercom`,
			atomicExe,
			"bun-binary",
		);
		assert.equal(binSpec.kind, "direct");
		assert.equal(binSpec.command, atomicExe);
		assert.deepEqual(binSpec.args, [spawnModule.INTERNAL_INTERCOM_BROKER_ARG, brokerPath]);
		assert.equal(binSpec.noWindow, undefined);
	});

	test("passes custom exe overrides directly on Windows with noWindow enabled and without wscript or cmd", () => {
		const brokerPath = String.raw`C:\ext\broker\broker.ts`;
		const spec = spawnModule.getBrokerLaunchSpec(
			brokerPath,
			"bun",
			["--smol", "arg-%TEMP%-100%"],
			String.raw`C:\ext`,
			"win32",
			String.raw`C:\agent\intercom`,
			String.raw`C:\node.exe`,
			"node",
		);

		assert.equal(spec.kind, "direct");
		assert.equal(spec.command, "bun");
		assert.deepEqual(spec.args, ["--smol", "arg-%TEMP%-100%", brokerPath]);
		assert.equal(spec.verbatimArguments, undefined);
		assert.equal(spec.noWindow, true);

		const linuxSpec = spawnModule.getBrokerLaunchSpec(
			"/ext/broker/broker.ts",
			"bun",
			["--smol"],
			"/ext",
			"linux",
			"/agent/intercom",
			"/usr/bin/node",
			"node",
		);
		assert.equal(linuxSpec.noWindow, undefined);
	});

	test("runs custom Windows .cmd/.bat overrides via direct cmd.exe with noWindow and without wscript or 2>> redirection", () => {
		const brokerPath = String.raw`C:\ext\broker\broker.ts`;
		const batchPath = String.raw`C:\tools\my broker.cmd`;
		const spec = spawnModule.getBrokerLaunchSpec(
			brokerPath,
			batchPath,
			["--flag", "value"],
			String.raw`C:\ext`,
			"win32",
			String.raw`C:\agent\intercom`,
			String.raw`C:\node.exe`,
			"node",
		);

		assert.equal(spec.kind, "direct");
		assert.match(spec.command, /cmd\.exe$/iu);
		assert.doesNotMatch(spec.command, /wscript/iu);
		assert.equal(spec.verbatimArguments, true);
		assert.equal(spec.noWindow, true);
		assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
		assert.ok(spec.args[3]?.includes(batchPath), spec.args[3]);
		assert.equal(spec.args[3]?.includes(">>"), false, "stderr must travel via inherited handle, not 2>>");
	});
});

describe("direct broker spawn captures stderr and exit code with % in paths and args", () => {
	test("preserves literal % in agent dir and custom args, captures stderr, reports exit code, and writes no VBS file", async () => {
		const marker = `PERCENT-STDERR-%TEMP%-100%-${Date.now()}`;
		const scriptPath = join(agentDir, "crash-percent.cjs");
		writeFileSync(scriptPath, "console.error(process.argv[2]); process.exit(7);\n", "utf8");

		await assert.rejects(
			() => spawnModule.spawnBrokerIfNeeded(process.execPath, [scriptPath, marker], 15_000),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Intercom broker exited before startup with code 7/u, error.message);
				assert.ok(error.message.includes(marker), `expected literal % marker in error:\n${error.message}`);
				assert.ok(error.message.includes(pathsModule.getBrokerLogPath()), error.message);
				return true;
			},
		);

		const logContent = readFileSync(pathsModule.getBrokerLogPath(), "utf8");
		assert.ok(logContent.includes(marker), `expected literal % marker in broker.log:\n${logContent}`);
		assert.equal(
			existsSync(join(pathsModule.getIntercomDirPath(), "broker-launch.vbs")),
			false,
			"direct spawn must never write broker-launch.vbs",
		);
		assert.equal(
			existsSync(pathsModule.getBrokerStartAnnouncementPath()),
			false,
			"direct spawn does not need a broker.starting announcement file",
		);
		assert.equal(sep === "\\" || sep === "/", true);
	});
});
