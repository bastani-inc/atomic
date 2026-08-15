import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";
import { bunExecutable, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Two package names no registry has ever seen. The fixture's `publish.yml`
 * declares them as its publish payload, so the real script asks the real `npm`
 * about them — the preflight runs end to end rather than against a stub.
 */
const fixturePackages = ["@atomic-release-preflight-fixture/one", "@atomic-release-preflight-fixture/two"] as const;

/**
 * A registry that answers 404 to everything.
 *
 * It replaces the public registry for these runs, which keeps the test
 * hermetic — offline, behind a mirror, and on Windows, where a shell-script
 * `npm` stub on PATH would not be executed at all.
 */
let registry: Server;
let registryUrl: string;

beforeAll(async () => {
	registry = createServer((_request, response) => {
		response.writeHead(404, { "content-type": "application/json" });
		response.end('{"error":"Not found"}');
	});
	await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
	registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => registry.close(() => resolve()));
});

function git(root: string, args: string[]): void {
	const result = spawnSyncCollect(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
	assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr.toString()}`);
}

interface Fixture {
	/** Removed wholesale by the test; holds the repository and npm's cache. */
	readonly stage: string;
	readonly root: string;
	readonly npmCache: string;
}

/**
 * A repository whose only content is the release script under test, its two
 * modules, and a `publish.yml` declaring the fixture payload. `ROOT` inside
 * `cut-release.ts` resolves to the parent of its own directory, so the copied
 * script operates on this fixture and never on the real checkout.
 *
 * npm's cache lives beside the repository rather than inside it: a cache
 * written under the working tree would leave it dirty, which is a different
 * refusal from the one under test.
 */
function createFixture(): Fixture {
	const stage = mkdtempSync(join(tmpdir(), "atomic-cut-release-preflight-"));
	const root = join(stage, "repo");
	mkdirSync(join(root, "scripts"), { recursive: true });
	mkdirSync(join(root, ".github", "workflows"), { recursive: true });
	for (const script of ["cut-release.ts", "release-base.ts", "release-npm-preflight.ts"]) {
		copyFileSync(join(repoRoot, "scripts", script), join(root, "scripts", script));
	}
	writeFileSync(
		join(root, ".github", "workflows", "publish.yml"),
		["jobs:", "  publish-npm:", "    run: |", `      packages=(${fixturePackages.join(" ")})`, ""].join("\n"),
	);
	git(root, ["init", "-b", "main"]);
	git(root, ["add", "-A"]);
	git(root, [
		"-c",
		"user.name=atomic-release-test",
		"-c",
		"user.email=atomic-release-test@users.noreply.github.com",
		// A developer's global `commit.gpgsign` would otherwise ask for a key.
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"fixture",
	]);
	return { stage, root, npmCache: join(stage, "npm-cache") };
}

interface CutResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}
/**
 * Spawned asynchronously on purpose: `spawnSync` would block this process's
 * event loop, and the loopback registry npm is talking to lives in it.
 */
async function runCutRelease(fixture: Fixture, args: string[], registryOverride?: string): Promise<CutResult> {
	const environment: Record<string, string | undefined> = { ...process.env };
	// npm's own configuration variable, which the preflight resolves before it
	// pins `--registry`. Retries are disabled so an unreachable registry fails
	// now instead of after npm's minute-long backoff, and the proxy keys are
	// cleared so a developer proxy cannot intercept the loopback registry.
	environment.npm_config_registry = registryOverride ?? registryUrl;
	environment.npm_config_cache = fixture.npmCache;
	environment.npm_config_fetch_retries = "0";
	environment.NO_UPDATE_NOTIFIER = "1";
	for (const key of [
		"npm_config_proxy",
		"npm_config_https_proxy",
		"http_proxy",
		"https_proxy",
		"HTTP_PROXY",
		"HTTPS_PROXY",
	]) {
		environment[key] = undefined;
	}

	const child = spawnProcess({
		cmd: [bunExecutable(), "run", join(fixture.root, "scripts", "cut-release.ts"), ...args],
		cwd: fixture.root,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
		child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

/** Everything the script could have mutated, read back after it exits. */
function repositoryState(root: string): { tags: string; status: string; worktrees: boolean } {
	const read = (args: string[]): string =>
		spawnSyncCollect(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" })
			.stdout.toString()
			.trim();
	return {
		tags: read(["tag", "--list"]),
		status: read(["status", "--porcelain"]),
		worktrees: existsSync(join(root, ".git", "worktrees")),
	};
}

/**
 * Each case spawns Bun, two real `npm view` processes, and several `git`
 * invocations, and lands near half a second — well inside the shared per-test
 * budget, so no explicit timeout is declared here.
 */
describe("cut-release npm registration preflight", () => {
	test("cut-release-aborts-on-unregistered-package", async () => {
		const fixture = createFixture();
		try {
			const result = await runCutRelease(fixture, ["9.9.9", "--base", "main", "--yes"]);

			assert.equal(result.exitCode, 1, result.stdout + result.stderr);
			assert.match(result.stderr, /2 of 2 publish-payload packages are not registered on npm/u);
			for (const name of fixturePackages) assert.ok(result.stderr.includes(name), `missing ${name}`);
			assert.match(result.stderr, /Re-run with --allow-new/u);

			// The abort lands before the script announces the cut, and before it
			// prunes, adds a worktree, stamps a version, or writes a tag.
			assert.doesNotMatch(result.stdout, /Cutting release/u);
			assert.deepEqual(repositoryState(fixture.root), { tags: "", status: "", worktrees: false });
		} finally {
			rmSync(fixture.stage, { recursive: true, force: true });
		}
	});

	test("--allow-new is required for a first publish and lets the cut proceed", async () => {
		const fixture = createFixture();
		try {
			const result = await runCutRelease(fixture, ["9.9.9", "--base", "main", "--yes", "--allow-new"]);

			// Past the preflight: the run now fails on the fixture's missing
			// origin, which is the next check after the registry one.
			assert.doesNotMatch(result.stderr, /not registered on npm/u);
			assert.match(result.stdout, /--allow-new: first publish for 2 package\(s\)/u);
			for (const name of fixturePackages) assert.ok(result.stdout.includes(`+ ${name}`), `missing ${name}`);
			assert.match(result.stderr, /Base ref "refs\/heads\/main" does not exist on origin\./u);
			assert.equal(result.exitCode, 1);
			assert.deepEqual(repositoryState(fixture.root), { tags: "", status: "", worktrees: false });
		} finally {
			rmSync(fixture.stage, { recursive: true, force: true });
		}
	});

	test("a registry that cannot answer stops the release even with --allow-new", async () => {
		const fixture = createFixture();
		try {
			// Port 1 refuses the connection, so `npm view` fails without a 404 —
			// the one answer the escape hatch deliberately does not cover.
			const result = await runCutRelease(fixture, ["9.9.9", "--yes", "--allow-new"], "http://127.0.0.1:1/");

			assert.equal(result.exitCode, 1, result.stdout);
			assert.match(result.stderr, /npm registration could not be determined for 2 of 2/u);
			assert.match(result.stderr, /--allow-new does not cover an unreadable registry answer/u);
			assert.deepEqual(repositoryState(fixture.root), { tags: "", status: "", worktrees: false });
		} finally {
			rmSync(fixture.stage, { recursive: true, force: true });
		}
	});
});
