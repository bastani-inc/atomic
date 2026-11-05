import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { isDistributedProvisionError } from "../distributed/harness/errors.mjs";
import { Manifest } from "../distributed/harness/manifest.mjs";

const command = vi.hoisted(() => vi.fn());
vi.mock("../distributed/harness/commands.mjs", async (original) => ({
	...(await original<typeof import("../distributed/harness/commands.mjs")>()),
	runCommand: command,
}));
let dir: string;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const result = (stdout = "") => ({ stdout, stderr: "", exitCode: 0, elapsedMs: 1 });
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "distributed-downloads-"));
	vi.resetModules();
	vi.stubEnv("XDG_CACHE_HOME", dir);
	command.mockReset();
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

test("concurrent runtime downloads validate separate staging files before publishing (#4331)", async () => {
	const { nodeTarball } = await import("../distributed/run.mjs");
	const stages: string[] = [];
	let release: () => void = () => {};
	const both = new Promise<void>((resolve) => {
		release = resolve;
	});
	command.mockImplementation(
		async (
			_context,
			tool: string,
			args: string[],
			options: { operation: string; timeoutMs: number; signal: AbortSignal },
		) => {
			assert.equal(tool, "curl");
			if (args.includes("-o")) {
				const path = args[args.indexOf("-o") + 1] as string;
				assert.deepEqual(args, [
					"-fsSL",
					"-o",
					path,
					"https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz",
				]);
				assert.equal(options.timeoutMs, 600_000);
				assert.equal(options.signal, signal);
				stages.push(path);
				writeFileSync(path, "runtime");
				assert.equal(existsSync(join(dir, "atomic-distributed-test/node/node-v24.22.0-linux-x64.tar.xz")), false);
				if (stages.length === 2) release();
				await both;
				return result();
			}
			assert.deepEqual(args, ["-fsSL", "https://nodejs.org/dist/v24.22.0/SHASUMS256.txt"]);
			assert.equal(options.operation, "download SHASUMS256.txt");
			return result(
				`${"0".repeat(64)}  another-file.tar.xz\n${digest("runtime")}  node-v24.22.0-linux-x64.tar.xz\n`,
			);
		},
	);
	const context = { secrets: new Set<string>() };
	const signal = new AbortController().signal;
	const [a, b] = await Promise.all([
		nodeTarball(context, "v24.22.0", signal),
		nodeTarball(context, "v24.22.0", signal),
	]);
	assert.notEqual(stages[0], stages[1]);
	assert.deepEqual(a, b);
	assert.equal(a.digest, digest("runtime"));
	assert.deepEqual(readdirSync(join(dir, "atomic-distributed-test/node")), ["node-v24.22.0-linux-x64.tar.xz"]);
});

test("a failed runtime checksum leaves no poisoned cache entry (#4331)", async () => {
	const { nodeTarball } = await import("../distributed/run.mjs");
	const { DistributedProvisionError } = await import("../distributed/harness/errors.mjs");
	command.mockImplementation(async (_context, _tool: string, args: string[]) => {
		if (args.includes("-o")) {
			writeFileSync(args[args.indexOf("-o") + 1] as string, "bad");
			return result();
		}
		return result(`${digest("runtime")}  node-v24.22.0-linux-x64.tar.xz\n`);
	});
	await assert.rejects(nodeTarball({ secrets: new Set() }, "v24.22.0", new AbortController().signal), (error) => {
		assert.ok(isDistributedProvisionError(error));
		assert.ok(error instanceof DistributedProvisionError);
		assert.equal(error.code, "provision-failed");
		assert.equal(error.fields.step, "verify Node runtime");
		assert.equal(error.fields.detail, "SHA-256 does not match SHASUMS256.txt");
		return true;
	});
	assert.deepEqual(readdirSync(join(dir, "atomic-distributed-test/node")), []);
});

test("concurrent builds keep the published artifact and return its digest (#4331)", async () => {
	const { buildArtifact } = await import("../distributed/run.mjs");
	const stages: string[] = [];
	let release: () => void = () => {};
	const both = new Promise<void>((resolve) => {
		release = resolve;
	});
	command.mockImplementation(
		async (
			_context,
			tool: string,
			args: string[],
			options: { operation: string; timeoutMs: number; signal: AbortSignal; cwd: string },
		) => {
			assert.equal(tool, "crabbox");
			if (args[0] === "run") return result(`${digest("artifact")}\n`);
			assert.equal(args[0], "cp");
			const path = args.at(-1) as string;
			assert.deepEqual(args.slice(0, 3), ["cp", "--id", "builder-a"]);
			assert.match(
				args[3] as string,
				/^SANDBOX:\/tmp\/atomic-distributed-test-build\/[0-9a-f-]{36}\/atomic\.tar\.zst$/,
			);
			assert.equal(args.length, 5);
			assert.equal(options.operation, "copy artifact");
			assert.equal(options.timeoutMs, 1_800_000);
			assert.equal(options.signal, input.signal);
			assert.equal(options.cwd, process.cwd());
			stages.push(path);
			writeFileSync(path, "artifact");
			if (stages.length === 2) release();
			await both;
			return result();
		},
	);
	const manifest = new Manifest(dir, {
		runId: "run-a",
		resourceGroup: "run-a-rg",
		expiresAt: "2026-11-06T00:00:00Z",
		subscription: "s",
		control: { resourceGroup: "control-rg", vnet: "control-vnet" },
		entries: [],
	});
	const input = {
		sha: "a".repeat(40),
		repository: "https://example.com/repo.git",
		nodeVersion: "v24.22.0",
		builder: "builder-a",
		manifest,
		signal: new AbortController().signal,
	};
	const context = { secrets: new Set<string>() };
	const [a, b] = await Promise.all([buildArtifact(context, input), buildArtifact(context, input)]);
	assert.notEqual(stages[0], stages[1]);
	assert.deepEqual([a.cached, b.cached].sort(), [false, true]);
	assert.equal(a.path, b.path);
	assert.equal(a.digest, b.digest);
	assert.equal(a.digest, digest(readFileSync(a.path, "utf8")));
	assert.deepEqual(readdirSync(join(dir, "atomic-distributed-test/artifacts")), [`atomic-${input.sha}.tar.zst`]);
});

test("database extraction publishes a complete binary through the same cache protocol (#4331)", async () => {
	const { sqldBinary } = await import("../distributed/run.mjs");
	command.mockImplementation(async (_context, tool: string, args: string[]) => {
		if (tool !== "docker") {
			assert.deepEqual(args, ["--version"]);
			return result("sqld 0.24.33\n");
		}
		if (args[0] === "create") return result("container-a\n");
		if (args[0] === "cp") {
			assert.equal(args[1], "container-a:/bin/sqld");
			writeFileSync(args.at(-1) as string, "binary");
		}
		return result();
	});
	const a = await sqldBinary(
		{ secrets: new Set() },
		{ image: "vendor/database@sha256:example", version: "v0.24.33" },
		new AbortController().signal,
	);
	assert.equal(a.digest, digest("binary"));
	assert.equal(a.version, "sqld 0.24.33");
	assert.deepEqual(readdirSync(join(dir, "atomic-distributed-test/sqld/v0.24.33")), ["sqld"]);
});

test("a runtime missing from the checksum manifest fails with the typed verification error (#4331)", async () => {
	const { nodeTarball } = await import("../distributed/run.mjs");
	const { DistributedProvisionError } = await import("../distributed/harness/errors.mjs");
	command.mockImplementation(async (_context, _tool: string, args: string[]) => {
		if (args.includes("-o")) {
			writeFileSync(args[args.indexOf("-o") + 1] as string, "runtime");
			return result();
		}
		return result(`${digest("runtime")}  a-different-file.tar.xz\n`);
	});
	await assert.rejects(nodeTarball({ secrets: new Set() }, "v24.22.0", new AbortController().signal), (error) => {
		assert.ok(error instanceof DistributedProvisionError);
		assert.equal(error.fields.step, "verify Node runtime");
		return true;
	});
});

test("an artifact that differs from its builder digest is never cached (#4331)", async () => {
	const { buildArtifact } = await import("../distributed/run.mjs");
	const { DistributedProvisionError } = await import("../distributed/harness/errors.mjs");
	command.mockImplementation(async (_context, _tool: string, args: string[]) => {
		if (args[0] === "run") return result(`${digest("expected")}\n`);
		writeFileSync(args.at(-1) as string, "corrupted");
		return result();
	});
	const manifest = new Manifest(dir, {
		runId: "run-a",
		resourceGroup: "run-a-rg",
		expiresAt: "2026-11-06T00:00:00Z",
		subscription: "s",
		control: { resourceGroup: "control-rg", vnet: "control-vnet" },
		entries: [],
	});
	await assert.rejects(
		buildArtifact(
			{ secrets: new Set() },
			{
				sha: "b".repeat(40),
				repository: "https://example.com/repo.git",
				nodeVersion: "v24.22.0",
				builder: "builder-a",
				manifest,
				signal: new AbortController().signal,
			},
		),
		(error) => {
			assert.ok(error instanceof DistributedProvisionError);
			assert.equal(error.code, "provision-failed");
			assert.equal(error.fields.step, "copy artifact");
			assert.equal(error.fields.detail, "digest differs from the builder's");
			return true;
		},
	);
	assert.deepEqual(readdirSync(join(dir, "atomic-distributed-test/artifacts")), []);
});
