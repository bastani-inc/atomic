import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { bunExecutable, readStreamText, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Package names no registry has ever seen. The fixture's `publish.yml` declares
 * them as its publish payload, so the real script asks the real `npm` about
 * them — the preflight runs end to end rather than against a stub.
 */
const fixturePackages = ["@atomic-release-preflight-fixture/one", "@atomic-release-preflight-fixture/two"] as const;
/** The payload of a *different* branch, used to prove which commit is read. */
const basePackages = ["@atomic-release-preflight-base/one", "@atomic-release-preflight-base/two"] as const;
const localOnlyPackage = "@atomic-release-preflight-local/only";

/**
 * Structural: every case spawns Bun, which transforms three `.ts` scripts on a
 * cold start, then one real `npm` child per payload package — npm's own cold
 * start dominates — plus a dozen `git` children; the cases that clear the
 * preflight spawn a second Bun for the version stamp. The cost is process
 * startup rather than a slow assertion, so the budget is named here per the
 * per-test timeout policy in AGENTS.md.
 */
const CUT_RELEASE_FIXTURE_TIMEOUT_MS = 120_000;

/** A registry, and every package path it was asked about. */
interface FakeRegistry {
	readonly url: string;
	readonly requests: string[];
	close(): Promise<void>;
}

/**
 * Two loopback registries replace the public one, which keeps these runs
 * hermetic — offline, behind a mirror, and on Windows, where a shell-script
 * `npm` stub on PATH would not be executed at all.
 *
 * `missing` answers 404 to everything; `mirror` answers "this package exists"
 * to everything. Which one the preflight asks is the whole point of two.
 */
let missing: FakeRegistry;
let mirror: FakeRegistry;

async function startRegistry(respond: (name: string) => { status: number; body: string }): Promise<FakeRegistry> {
	const requests: string[] = [];
	const server: Server = createServer((request, response) => {
		const path = (request.url ?? "").split("?")[0] ?? "";
		const name = decodeURIComponent(path.replace(/^\//u, ""));
		requests.push(name);
		const { status, body } = respond(name);
		response.writeHead(status, { "content-type": "application/json" });
		response.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

beforeAll(async () => {
	missing = await startRegistry(() => ({ status: 404, body: '{"error":"Not found"}' }));
	mirror = await startRegistry((name) => ({
		status: 200,
		body: JSON.stringify({
			name,
			"dist-tags": { latest: "1.0.0" },
			versions: { "1.0.0": { name, version: "1.0.0" } },
		}),
	}));
});

afterAll(async () => {
	await Promise.all([missing.close(), mirror.close()]);
});

/**
 * Every git child this fixture spawns runs with the repository-local part of
 * the environment removed.
 *
 * Git hooks export `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY` and
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, and git honors them over `-C <path>` and
 * over a literal path argument alike. `git init --bare <path>` under an
 * inherited `GIT_DIR` therefore does not initialize `<path>`: it re-initializes
 * the repository `GIT_DIR` names — this checkout, which is a linked worktree —
 * as bare, and every worktree sharing that git dir stops resolving. This suite
 * did exactly that when it ran under the repository's own pre-push hook.
 *
 * `createGitEnvironment` is the repository's existing scrubber and mirrors
 * `git rev-parse --local-env-vars`, so it covers those six and the rest.
 * `git-fixture-cannot-reach-the-repository-under-test` is what proves the
 * scrub is wired to every spawn rather than merely available.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
	return createGitEnvironment();
}

function git(root: string, args: string[]): void {
	const result = spawnSyncCollect(["git", "-C", root, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: gitEnvironment(),
	});
	assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr.toString()}`);
}

/** One git query, trimmed. Failures return "" so a snapshot can record them rather than throw. */
function gitOutput(root: string, args: string[]): string {
	return spawnSyncCollect(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnvironment() })
		.stdout.toString()
		.trim();
}

/**
 * Everything a stray git command would disturb in a repository that is not the
 * fixture: whether it is still a working checkout rather than a bare one, which
 * git dir it resolves to, what it has checked out, and its local configuration.
 */
function foreignRepositorySnapshot(root: string): Record<string, string> {
	return {
		bare: gitOutput(root, ["rev-parse", "--is-bare-repository"]),
		gitDir: gitOutput(root, ["rev-parse", "--absolute-git-dir"]),
		head: gitOutput(root, ["rev-parse", "HEAD"]),
		config: gitOutput(root, ["config", "--list", "--local"]),
	};
}

/** The same, plus the refs — used for a repository this file owns outright. */
function repositoryFingerprint(root: string): Record<string, string> {
	return { ...foreignRepositorySnapshot(root), refs: gitOutput(root, ["show-ref"]) };
}

/**
 * A repository standing in for the checkout that runs this suite, and the
 * hook-style environment aimed at it.
 *
 * Asserting the hostile case against the real checkout would mean risking it;
 * this one is owned by the test, so it can be compared byte for byte.
 */
function createSentinel(): { stage: string; path: string; hostile: Record<string, string> } {
	const stage = mkdtempSync(join(tmpdir(), "atomic-cut-release-sentinel-"));
	const path = join(stage, "checkout");
	mkdirSync(path, { recursive: true });
	git(path, ["init", "-b", "main"]);
	writeFileSync(join(path, "tracked.txt"), "sentinel\n");
	commit(path, "sentinel");
	// Exactly what a git hook exports.
	return {
		stage,
		path,
		hostile: {
			GIT_DIR: join(path, ".git"),
			GIT_WORK_TREE: path,
			GIT_INDEX_FILE: join(path, ".git", "index"),
			GIT_COMMON_DIR: join(path, ".git"),
			GIT_OBJECT_DIRECTORY: join(path, ".git", "objects"),
			GIT_ALTERNATE_OBJECT_DIRECTORIES: join(path, ".git", "objects"),
		},
	};
}

function commit(root: string, message: string): void {
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
		message,
	]);
}

/** A `publish.yml` that publishes `packages` to `registry`, in the publisher's own shape. */
function publishWorkflow(packages: readonly string[], registry: string): string {
	return [
		"jobs:",
		"  publish-npm:",
		"    run: |",
		`      packages=(${packages.join(" ")})`,
		`      for name in "\${packages[@]}"; do`,
		`        npm publish "\${tarballs[$name]}" --access public --registry ${registry}`,
		"      done",
		"",
	].join("\n");
}

interface FixtureOptions {
	/** The payload declared on `main`, which is what a `--base main` cut publishes. */
	readonly packages: readonly string[];
	/** The registry `publish.yml` pins. */
	readonly registry: string;
	/** When set, a second branch is checked out whose `publish.yml` declares these instead. */
	readonly localPackages?: readonly string[];
}

interface Fixture {
	/** Removed wholesale by the test; holds the repository, its origin, and npm's cache. */
	readonly stage: string;
	readonly root: string;
	readonly npmCache: string;
	readonly traceLog: string;
}

/**
 * A repository whose only content is the release script under test, its
 * modules, a stub version stamper, and a `publish.yml` declaring the fixture
 * payload. `ROOT` inside `cut-release.ts` resolves to the parent of its own
 * directory, so the copied script operates on this fixture and never on the
 * real checkout.
 *
 * It has a real `origin`, because base resolution now runs *before* the
 * preflight: the release is cut from the base commit, so that commit is what
 * the preflight has to read.
 *
 * npm's cache lives beside the repository rather than inside it: a cache
 * written under the working tree would leave it dirty, which is a different
 * refusal from the one under test.
 */
function createFixture(options: FixtureOptions): Fixture {
	const stage = mkdtempSync(join(tmpdir(), "atomic-cut-release-preflight-"));
	const root = join(stage, "repo");
	const origin = join(stage, "origin.git");
	mkdirSync(join(root, "scripts"), { recursive: true });
	mkdirSync(join(root, ".github", "workflows"), { recursive: true });
	for (const script of ["cut-release.ts", "release-base.ts", "release-npm-preflight.ts"]) {
		copyFileSync(join(repoRoot, "scripts", script), join(root, "scripts", script));
	}
	// The real stamper is out of scope here; a stub ends the run at the first
	// step after the preflight, which is what the cleared-gate cases assert.
	writeFileSync(
		join(root, "scripts", "bump-version.ts"),
		'console.error("stub bump-version: the preflight was cleared");\nprocess.exit(3);\n',
	);
	const workflow = join(root, ".github", "workflows", "publish.yml");
	writeFileSync(workflow, publishWorkflow(options.packages, options.registry));
	git(root, ["init", "-b", "main"]);
	commit(root, "fixture");
	// The path argument, and only the path argument, decides what becomes bare.
	const bare = spawnSyncCollect(["git", "init", "--bare", origin], {
		stdout: "pipe",
		stderr: "pipe",
		env: gitEnvironment(),
	});
	assert.equal(bare.exitCode, 0, bare.stderr.toString());
	assert.equal(gitOutput(origin, ["rev-parse", "--is-bare-repository"]), "true", "the origin was not initialized");
	git(root, ["remote", "add", "origin", origin]);
	git(root, ["push", "origin", "main"]);

	if (options.localPackages) {
		git(root, ["checkout", "-b", "local"]);
		writeFileSync(workflow, publishWorkflow(options.localPackages, options.registry));
		commit(root, "local-only payload");
	}
	return { stage, root, npmCache: join(stage, "npm-cache"), traceLog: join(stage, "git-trace.log") };
}

interface CutResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Spawned asynchronously on purpose: `spawnSync` would block this process's
 * event loop, and the loopback registries npm is talking to live in it.
 */
async function runCutRelease(
	fixture: Fixture,
	args: string[],
	extraEnv: Record<string, string> = {},
): Promise<CutResult> {
	// Scrubbed for the same reason as every git child above: the script's own
	// git commands are what create the worktree and write the tag, and an
	// inherited GIT_DIR would aim them at this checkout instead of the fixture.
	// `extraEnv` is how the one case that puts those variables *back* does it.
	const environment: Record<string, string | undefined> = { ...gitEnvironment() };
	// npm's own configuration, pointed at the mirror that answers "yes" to
	// everything — including the scope-specific form, which npm prefers over
	// `--registry`. The preflight must ignore both and ask the registry
	// `publish.yml` pins. Retries are disabled so an unreachable registry fails
	// now instead of after npm's minute-long backoff, and the proxy keys are
	// cleared so a developer proxy cannot intercept a loopback registry.
	environment.npm_config_registry = mirror.url;
	for (const scope of new Set([...fixturePackages, ...basePackages, localOnlyPackage].map((n) => n.split("/")[0]))) {
		environment[`npm_config_${scope}:registry`] = mirror.url;
	}
	environment.npm_config_cache = fixture.npmCache;
	environment.npm_config_fetch_retries = "0";
	environment.NO_UPDATE_NOTIFIER = "1";
	// Git's own record of every command the script ran, in order.
	environment.GIT_TRACE = fixture.traceLog;
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

	Object.assign(environment, extraEnv);

	const child = spawnProcess({
		cmd: [bunExecutable(), "run", join(fixture.root, "scripts", "cut-release.ts"), ...args],
		cwd: fixture.root,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		readStreamText(child.stdout),
		readStreamText(child.stderr),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

/**
 * Every git command the script ran, in order, with commit ids normalized.
 *
 * Residual state alone cannot tell an untouched repository from one that added
 * a worktree and removed it again, so the ordering claim is checked against
 * what git was actually asked to do.
 *
 * `upload-pack` is git's own child of `ls-remote` over a local path — the
 * transport answering the query, not a command the script issued — so it is
 * dropped rather than pinned into the expected sequence.
 */
function gitCommands(fixture: Fixture): string[] {
	if (!existsSync(fixture.traceLog)) return [];
	return readFileSync(fixture.traceLog, "utf8")
		.split(/\r?\n/u)
		.map((line) => /trace: built-in: git (.*)$/u.exec(line)?.[1])
		.filter((command): command is string => command !== undefined)
		.map((command) => command.replace(/\b[0-9a-f]{40}\b/gu, "<sha>").trim())
		.filter((command) => !/^(?:upload-pack|receive-pack|index-pack|pack-objects) /u.test(command));
}

/** Everything the script could have mutated, read back after it exits. */
function repositoryState(root: string): { tags: string; status: string } {
	return { tags: gitOutput(root, ["tag", "--list"]), status: gitOutput(root, ["status", "--porcelain"]) };
}

describe("cut-release npm registration preflight", () => {
	test(
		"cut-release-aborts-on-unregistered-package",
		async () => {
			const fixture = createFixture({ packages: fixturePackages, registry: missing.url });
			try {
				const result = await runCutRelease(fixture, ["9.9.9", "--base", "main", "--yes"]);

				assert.equal(result.exitCode, 1, result.stdout + result.stderr);
				assert.match(result.stderr, /2 of 2 publish-payload packages are not registered on npm/u);
				for (const name of fixturePackages) assert.ok(result.stderr.includes(name), `missing ${name}`);
				assert.match(result.stderr, /Re-run with --allow-new/u);

				// The ordering claim, from git's own record: the run read the base
				// and the publisher and then stopped. It never pruned, added a
				// worktree, stamped a version, committed, or wrote a tag.
				assert.deepEqual(gitCommands(fixture), [
					"rev-parse --local-env-vars",
					"status --porcelain",
					"tag --list 9.9.9",
					"rev-parse --abbrev-ref HEAD",
					"ls-remote --exit-code --refs origin refs/heads/main",
					"show <sha>:.github/workflows/publish.yml",
				]);
				assert.doesNotMatch(result.stdout, /Cutting release/u);
				assert.deepEqual(repositoryState(fixture.root), { tags: "", status: "" });
			} finally {
				rmSync(fixture.stage, { recursive: true, force: true });
			}
		},
		CUT_RELEASE_FIXTURE_TIMEOUT_MS,
	);

	test(
		"the registry asked is the one publish.yml pins, not the one npm is configured with",
		async () => {
			// publish.yml pins the registry that says every name exists, while npm's
			// own configuration points at the one that 404s. The publisher decides:
			// a mirror's answer is not evidence about the registry the release
			// actually publishes to.
			const fixture = createFixture({ packages: fixturePackages, registry: mirror.url });
			const missingBefore = missing.requests.length;
			try {
				const result = await runCutRelease(fixture, ["9.9.9", "--base", "main", "--yes"]);

				assert.doesNotMatch(result.stderr, /not registered on npm/u);
				assert.match(result.stdout, new RegExp(`2/2 publish-payload packages registered on ${mirror.url}`, "u"));
				for (const name of fixturePackages) assert.ok(mirror.requests.includes(name), `unasked ${name}`);
				assert.equal(missing.requests.length, missingBefore, "the configured registry was asked");
				// Cleared gate: the run reached the first mutation and died in the
				// stub stamper, so the tag was never written.
				assert.ok(
					gitCommands(fixture).some((command) => command.startsWith("worktree add")),
					"the cut never reached the worktree",
				);
				assert.match(result.stderr, /stub bump-version: the preflight was cleared/u);
				assert.equal(repositoryState(fixture.root).tags, "");
			} finally {
				rmSync(fixture.stage, { recursive: true, force: true });
			}
		},
		CUT_RELEASE_FIXTURE_TIMEOUT_MS,
	);

	test(
		"the payload is read from the base commit, not from the caller's checkout",
		async () => {
			// `--base main` is cut from main, so main's publish.yml is the one that
			// will publish. The checked-out branch declares a different payload and
			// must not be consulted at all.
			const fixture = createFixture({
				packages: basePackages,
				registry: missing.url,
				localPackages: [localOnlyPackage],
			});
			try {
				const result = await runCutRelease(fixture, ["9.9.9", "--base", "main", "--yes"]);

				assert.equal(result.exitCode, 1, result.stdout + result.stderr);
				for (const name of basePackages) assert.ok(result.stderr.includes(name), `missing ${name}`);
				assert.ok(!result.stderr.includes(localOnlyPackage), "the checked-out payload was checked");
				for (const name of basePackages) assert.ok(missing.requests.includes(name), `unasked ${name}`);
				assert.ok(!missing.requests.includes(localOnlyPackage), "the checked-out payload was probed");
				assert.deepEqual(repositoryState(fixture.root), { tags: "", status: "" });
			} finally {
				rmSync(fixture.stage, { recursive: true, force: true });
			}
		},
		CUT_RELEASE_FIXTURE_TIMEOUT_MS,
	);

	test(
		"--allow-new is required for a first publish and lets the cut proceed",
		async () => {
			const fixture = createFixture({ packages: fixturePackages, registry: missing.url });
			try {
				const result = await runCutRelease(fixture, ["9.9.9", "--base", "main", "--yes", "--allow-new"]);

				assert.doesNotMatch(result.stderr, /not registered on npm/u);
				assert.match(result.stdout, /--allow-new: first publish for 2 package\(s\)/u);
				for (const name of fixturePackages) assert.ok(result.stdout.includes(`+ ${name}`), `missing ${name}`);
				assert.match(result.stdout, /Cutting release 9\.9\.9/u);
				assert.ok(
					gitCommands(fixture).some((command) => command.startsWith("worktree add")),
					"the cut never reached the worktree",
				);
				assert.match(result.stderr, /stub bump-version: the preflight was cleared/u);
				assert.equal(repositoryState(fixture.root).tags, "");
			} finally {
				rmSync(fixture.stage, { recursive: true, force: true });
			}
		},
		CUT_RELEASE_FIXTURE_TIMEOUT_MS,
	);

	test(
		"a registry that cannot answer stops the release even with --allow-new",
		async () => {
			// Port 1 refuses the connection, so `npm view` fails without a 404 —
			// the one answer the escape hatch deliberately does not cover.
			const fixture = createFixture({ packages: fixturePackages, registry: "http://127.0.0.1:1/" });
			try {
				const result = await runCutRelease(fixture, ["9.9.9", "--base", "main", "--yes", "--allow-new"]);

				assert.equal(result.exitCode, 1, result.stdout);
				assert.match(result.stderr, /npm registration could not be determined for 2 of 2/u);
				assert.match(result.stderr, /--allow-new does not cover an unreadable registry answer/u);
				assert.ok(
					!gitCommands(fixture).some((command) => command.startsWith("worktree")),
					"the failed probe still touched a worktree",
				);
				assert.deepEqual(repositoryState(fixture.root), { tags: "", status: "" });
			} finally {
				rmSync(fixture.stage, { recursive: true, force: true });
			}
		},
		CUT_RELEASE_FIXTURE_TIMEOUT_MS,
	);

	test(
		"git-fixture-cannot-reach-the-repository-under-test",
		async () => {
			// `GIT_DIR` overrides `-C <path>` and the path argument of `git init
			// --bare` alike, so an unscrubbed fixture builds itself inside — and on
			// top of — whichever repository the ambient environment names. Under
			// this repository's own pre-push hook that repository is this checkout,
			// which is a linked worktree: initializing it bare detaches all of them.
			const sentinel = createSentinel();
			const sentinelBefore = repositoryFingerprint(sentinel.path);
			const selfBefore = foreignRepositorySnapshot(repoRoot);
			assert.equal(selfBefore.bare, "false", "the repository under test is already bare");

			const saved = new Map(Object.keys(sentinel.hostile).map((key) => [key, process.env[key]] as const));
			Object.assign(process.env, sentinel.hostile);

			let fixture: Fixture | undefined;
			try {
				try {
					fixture = createFixture({ packages: fixturePackages, registry: missing.url });
					const result = await runCutRelease(fixture, ["9.9.9", "--base", "main", "--yes"]);

					// The whole run still landed on the fixture: it resolved its own
					// base, read its own publisher, and aborted on its own payload.
					assert.equal(result.exitCode, 1, result.stdout + result.stderr);
					assert.match(result.stderr, /2 of 2 publish-payload packages are not registered on npm/u);
					assert.equal(gitOutput(fixture.root, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
					assert.deepEqual(repositoryState(fixture.root), { tags: "", status: "" });
				} finally {
					for (const [key, value] of saved) {
						if (value === undefined) delete process.env[key];
						else process.env[key] = value;
					}
					if (fixture) rmSync(fixture.stage, { recursive: true, force: true });
				}

				// Neither repository was initialized, committed into, or turned bare.
				assert.deepEqual(
					repositoryFingerprint(sentinel.path),
					sentinelBefore,
					"the fixture wrote to the ambient repository",
				);
				assert.deepEqual(foreignRepositorySnapshot(repoRoot), selfBefore, "the fixture wrote to this checkout");
			} finally {
				rmSync(sentinel.stage, { recursive: true, force: true });
			}
		},
		CUT_RELEASE_FIXTURE_TIMEOUT_MS,
	);

	test(
		"an exported GIT_DIR cannot redirect the cut into another repository",
		async () => {
			// The same hook environment, handed to the script itself rather than
			// erased by the fixture. `cut-release.ts` addresses every repository it
			// touches by path — the checkout it reads, and the temporary worktree it
			// stamps and tags — so it scrubs the inherited variables before its
			// first git command. Without that, the run reads the sentinel's state
			// and would stamp and tag the sentinel.
			const sentinel = createSentinel();
			const sentinelBefore = repositoryFingerprint(sentinel.path);
			const fixture = createFixture({ packages: fixturePackages, registry: missing.url });
			try {
				const result = await runCutRelease(fixture, ["9.9.9", "--base", "main", "--yes"], sentinel.hostile);

				// It read the fixture's base and the fixture's publisher: the
				// sentinel has no origin, so a redirected run dies on the base
				// instead, and never names a payload package at all.
				assert.equal(result.exitCode, 1, result.stdout + result.stderr);
				assert.match(result.stderr, /2 of 2 publish-payload packages are not registered on npm/u);
				for (const name of fixturePackages) assert.ok(result.stderr.includes(name), `missing ${name}`);
				assert.doesNotMatch(result.stderr, /does not exist on origin/u);
				assert.deepEqual(repositoryFingerprint(sentinel.path), sentinelBefore, "the cut wrote to the sentinel");
				assert.deepEqual(repositoryState(fixture.root), { tags: "", status: "" });
			} finally {
				rmSync(fixture.stage, { recursive: true, force: true });
				rmSync(sentinel.stage, { recursive: true, force: true });
			}
		},
		CUT_RELEASE_FIXTURE_TIMEOUT_MS,
	);
});
