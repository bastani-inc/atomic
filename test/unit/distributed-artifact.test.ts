import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	ARTIFACT_REMOTE_ROOT,
	artifactArchivePath,
	artifactBuildScript,
	artifactCleanupScript,
	artifactRemoteDir,
} from "../distributed/harness/artifact.mjs";
import { Manifest } from "../distributed/harness/manifest.mjs";

const command = vi.hoisted(() => vi.fn());
vi.mock("../distributed/harness/commands.mjs", async (original) => ({
	...(await original<typeof import("../distributed/harness/commands.mjs")>()),
	runCommand: command,
}));

type Options = { operation: string; timeoutMs: number; signal?: AbortSignal; cwd: string };

let dir: string;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const result = (stdout = "") => ({ stdout, stderr: "", exitCode: 0, elapsedMs: 1 });
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BUILD_DIR = /^\/tmp\/atomic-distributed-test-build\/[0-9a-f-]{36}$/;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "distributed-artifact-"));
	vi.resetModules();
	vi.stubEnv("XDG_CACHE_HOME", dir);
	command.mockReset();
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

function manifest() {
	return new Manifest(dir, {
		runId: "run-a",
		resourceGroup: "run-a-rg",
		expiresAt: "2026-11-06T00:00:00Z",
		subscription: "s",
		control: { resourceGroup: "control-rg", vnet: "control-vnet" },
		entries: [],
	});
}

function input(overrides: { builder?: string; signal?: AbortSignal } = {}) {
	return {
		sha: SHA,
		repository: "https://example.com/repo.git",
		nodeVersion: "v24.22.0",
		builder: "builder-a",
		manifest: manifest(),
		signal: new AbortController().signal,
		...overrides,
	};
}

class FakeBuilderTmp {
	readonly files = new Map<string, string>();
	private builds = 0;

	run(script: string) {
		for (const match of script.matchAll(/rm -rf (?:-- )?(\/\S+)/g)) {
			const target = match[1] as string;
			for (const path of [...this.files.keys()])
				if (path === target || path.startsWith(`${target}/`)) this.files.delete(path);
		}
		const archive = /^sha256sum (\S+) \| cut/m.exec(script)?.[1];
		if (archive === undefined) return undefined;
		const content = `archive-${++this.builds}`;
		this.files.set(archive, content);
		return content;
	}

	copy(source: string, destination: string) {
		const content = this.files.get(source.replace(/^SANDBOX:/, ""));
		if (content === undefined) throw new Error(`no such file on the builder: ${source}`);
		writeFileSync(destination, content);
	}
}

test("concurrent builds on one builder keep their own build directories through build, copy and cleanup (#4331)", async () => {
	const { buildArtifact } = await import("../distributed/run.mjs");
	const remote = new FakeBuilderTmp();
	const buildScripts: string[] = [];
	const copySources: string[] = [];
	const cleanupScripts: string[] = [];
	let release: () => void = () => {};
	const bothBuilt = new Promise<void>((resolve) => {
		release = resolve;
	});
	command.mockImplementation(async (_context, tool: string, args: string[], options: Options) => {
		assert.equal(tool, "crabbox");
		if (args[0] === "cp") {
			assert.equal(options.operation, "copy artifact");
			copySources.push(args[3] as string);
			remote.copy(args[3] as string, args[4] as string);
			return result();
		}
		assert.deepEqual(args.slice(0, 6), ["run", "--id", "builder-a", "--", "bash", "-lc"]);
		const script = args[6] as string;
		const content = remote.run(script);
		if (content === undefined) {
			assert.equal(options.operation, "remove artifact build directory");
			cleanupScripts.push(script);
			return result();
		}
		buildScripts.push(script);
		if (buildScripts.length === 2) release();
		await bothBuilt;
		return result(`${digest(content)}\n`);
	});
	const [a, b] = await Promise.all([
		buildArtifact({ secrets: new Set() }, input()),
		buildArtifact({ secrets: new Set() }, input()),
	]);

	const buildDirs = buildScripts.map((script) => /^cd (\S+) && tar/m.exec(script)?.[1] as string);
	assert.equal(new Set(buildDirs).size, 2);
	for (const buildDir of buildDirs) assert.match(buildDir, BUILD_DIR);
	assert.deepEqual(copySources.sort(), buildDirs.map((buildDir) => `SANDBOX:${buildDir}/atomic.tar.zst`).sort());
	assert.deepEqual(cleanupScripts.sort(), buildDirs.map((buildDir) => `rm -rf -- ${buildDir}`).sort());
	assert.deepEqual([...remote.files.keys()], []);
	assert.deepEqual([a.cached, b.cached].sort(), [false, true]);
	assert.equal(a.digest, b.digest);
	assert.equal(a.digest, digest(readFileSync(a.path, "utf8")));
});

test("a failed copy still removes its build directory and keeps the copy failure first (#4331)", async () => {
	const { buildArtifact } = await import("../distributed/run.mjs");
	const { DistributedProvisionError } = await import("../distributed/harness/errors.mjs");
	const cleanupFailure = new Error("builder unreachable");
	const calls: string[] = [];
	command.mockImplementation(async (_context, _tool: string, args: string[], options: Options) => {
		calls.push(options.operation);
		if (args[0] === "cp") {
			writeFileSync(args[4] as string, "corrupted");
			return result();
		}
		if (options.operation === "remove artifact build directory") throw cleanupFailure;
		return result(`${digest("expected")}\n`);
	});
	await assert.rejects(buildArtifact({ secrets: new Set() }, input()), (error) => {
		assert.ok(error instanceof DistributedProvisionError);
		assert.equal(error.fields.step, "copy artifact");
		assert.equal(Reflect.get(error, "cleanupCause"), cleanupFailure);
		return true;
	});
	assert.deepEqual(calls, ["build ref artifact", "copy artifact", "remove artifact build directory"]);
});

test("a cleanup failure after a good build is reported rather than dropped (#4331)", async () => {
	const { buildArtifact } = await import("../distributed/run.mjs");
	const cleanupFailure = new Error("builder unreachable");
	command.mockImplementation(async (_context, _tool: string, args: string[], options: Options) => {
		if (args[0] === "cp") {
			writeFileSync(args[4] as string, "artifact");
			return result();
		}
		if (options.operation === "remove artifact build directory") throw cleanupFailure;
		return result(`${digest("artifact")}\n`);
	});
	await assert.rejects(buildArtifact({ secrets: new Set() }, input()), (error) => error === cleanupFailure);
});

test("a cancelled build still removes its build directory under its own bounded timeout (#4331)", async () => {
	const { buildArtifact } = await import("../distributed/run.mjs");
	const controller = new AbortController();
	const abort = new Error("cancelled");
	const cleanups: Options[] = [];
	const cleanupArgs: string[][] = [];
	let buildScript = "";
	command.mockImplementation(async (_context, _tool: string, args: string[], options: Options) => {
		if (options.operation === "build ref artifact") {
			buildScript = args[6] as string;
			controller.abort(abort);
			throw abort;
		}
		cleanups.push(options);
		cleanupArgs.push(args);
		return result();
	});
	await assert.rejects(
		buildArtifact({ secrets: new Set() }, input({ signal: controller.signal })),
		(error) => error === abort,
	);
	const buildDir = /^cd (\S+) && tar/m.exec(buildScript)?.[1] as string;
	assert.deepEqual(cleanupArgs, [["run", "--id", "builder-a", "--", "bash", "-lc", `rm -rf -- ${buildDir}`]]);
	assert.equal(cleanups.length, 1);
	assert.equal(cleanups[0]?.operation, "remove artifact build directory");
	assert.equal(cleanups[0]?.timeoutMs, 600_000);
	assert.equal(cleanups[0]?.signal, undefined);
	assert.equal(cleanups[0]?.cwd, process.cwd());
});

test("a builder the harness warmed is stopped instead of cleaned (#4331)", async () => {
	const { buildArtifact } = await import("../distributed/run.mjs");
	const operations: string[] = [];
	command.mockImplementation(async (_context, _tool: string, args: string[], options: Options) => {
		operations.push(options.operation);
		if (args[0] === "warmup") return result("leased cbx_abc slug=warm-builder\n");
		if (args[0] === "cp") {
			writeFileSync(args[4] as string, "artifact");
			return result();
		}
		if (args[0] === "stop") {
			assert.deepEqual(args, ["stop", "warm-builder"]);
			return result();
		}
		assert.equal(args[2], "warm-builder");
		return result(`${digest("artifact")}\n`);
	});
	const built = await buildArtifact({ secrets: new Set() }, input({ builder: undefined }));
	assert.equal(built.cached, false);
	assert.deepEqual(operations, ["crabbox warmup", "build ref artifact", "copy artifact", "crabbox stop"]);
});

test("the artifact build fetches exactly the requested commit into its own directory and prints the tarball digest last (#4331)", () => {
	const remoteDir = artifactRemoteDir("0b6f1d4e-2c3a-4f5b-8a9c-0d1e2f3a4b5c");
	assert.equal(ARTIFACT_REMOTE_ROOT, "/tmp/atomic-distributed-test-build");
	assert.equal(remoteDir, "/tmp/atomic-distributed-test-build/0b6f1d4e-2c3a-4f5b-8a9c-0d1e2f3a4b5c");
	assert.equal(artifactArchivePath(remoteDir), `${remoteDir}/atomic.tar.zst`);
	assert.equal(artifactCleanupScript(remoteDir), `rm -rf -- ${remoteDir}`);
	assert.match(artifactRemoteDir(), BUILD_DIR);
	assert.notEqual(artifactRemoteDir(), artifactRemoteDir());
	const script = artifactBuildScript({
		sha: SHA,
		repository: "https://github.com/example/atomic.git",
		nodeVersion: "v24.22.0",
		bunVersion: "1.4.4",
		remoteDir,
	});
	assert.deepEqual(script.split("\n"), [
		"set -euo pipefail",
		"if ! command -v cc >/dev/null || ! command -v zstd >/dev/null; then sudo apt-get update -qq >/dev/null && sudo apt-get install -y -qq build-essential pkg-config unzip zstd git >/dev/null; fi",
		'export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"',
		'if [ "$(node --version 2>/dev/null)" != "v24.22.0" ]; then mkdir -p "$HOME/.local/node" && curl -fsSL https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz | tar -xJ -C "$HOME/.local/node" --strip-components=1; fi',
		'if [ "$(bun --version 2>/dev/null)" != "1.4.4" ]; then curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4" >/dev/null; fi',
		"if ! command -v cargo >/dev/null; then curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable >/dev/null; fi",
		`mkdir -p /tmp/atomic-distributed-test-build && mkdir ${remoteDir} ${remoteDir}/atomic && cd ${remoteDir}/atomic`,
		"git init -q . && git remote add origin https://github.com/example/atomic.git",
		`git fetch -q --depth 1 origin ${SHA} && git checkout -q FETCH_HEAD`,
		`test "$(git rev-parse HEAD)" = "${SHA}"`,
		`npm ci --ignore-scripts --no-audit --no-fund >${remoteDir}/npm-ci.log 2>&1 || { tail -40 ${remoteDir}/npm-ci.log; exit 1; }`,
		`npm run build >${remoteDir}/build.log 2>&1 || { tail -60 ${remoteDir}/build.log; exit 1; }`,
		`printf '{"sha":"%s","node":"%s","builtAt":"%s"}\\n' ${SHA} "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .atomic-distributed-artifact.json`,
		"rm -rf .git",
		"find . -type d -name target -prune -path '*/crates/*' -exec rm -rf {} + 2>/dev/null || true",
		"rm -rf target packages/natives/target",
		`cd ${remoteDir} && tar -I 'zstd -T0 -6' -cf atomic.tar.zst atomic`,
		`sha256sum ${remoteDir}/atomic.tar.zst | cut -d' ' -f1`,
	]);
	assert.equal(
		artifactBuildScript({
			sha: SHA,
			repository: "https://example.com/a b.git; rm -rf ~",
			nodeVersion: "v24.22.0",
			bunVersion: "1.4.4",
			remoteDir,
		}).split("\n")[7],
		"git init -q . && git remote add origin 'https://example.com/a b.git; rm -rf ~'",
	);
	for (const ref of ["main", SHA.toUpperCase(), SHA.slice(1), `${SHA}0`, `x${SHA}`, `${SHA}x`, `${SHA};rm -rf /`]) {
		assert.throws(
			() => artifactBuildScript({ sha: ref, repository: "r", nodeVersion: "v", bunVersion: "b", remoteDir }),
			(error) =>
				error instanceof TypeError && error.message === "artifactBuildScript needs a full lowercase commit SHA",
			ref,
		);
	}
});

test("only a single build directory under the build root is ever built in, copied from or removed (#4331)", () => {
	const good = "/tmp/atomic-distributed-test-build/0b6f1d4e-2c3a-4f5b-8a9c-0d1e2f3a4b5c";
	for (const remoteDir of [
		ARTIFACT_REMOTE_ROOT,
		`${ARTIFACT_REMOTE_ROOT}/`,
		"/tmp",
		"/",
		`${good}/..`,
		`${ARTIFACT_REMOTE_ROOT}/../0b6f1d4e-2c3a-4f5b-8a9c-0d1e2f3a4b5c`,
		`${good.toUpperCase()}`,
		`${good}; rm -rf /`,
		` ${good}`,
		`${good}\n`,
		`/var${good}`,
	]) {
		const rejected = (error: unknown) =>
			error instanceof TypeError && error.message === `not an artifact build directory: ${remoteDir}`;
		assert.throws(() => artifactCleanupScript(remoteDir), rejected, remoteDir);
		assert.throws(() => artifactArchivePath(remoteDir), rejected, remoteDir);
		assert.throws(
			() => artifactBuildScript({ sha: SHA, repository: "r", nodeVersion: "v", bunVersion: "b", remoteDir }),
			rejected,
			remoteDir,
		);
	}
	assert.throws(() => artifactRemoteDir("../x"), TypeError);
	assert.equal(artifactCleanupScript(good), `rm -rf -- ${good}`);
});
