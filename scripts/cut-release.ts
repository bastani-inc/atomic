#!/usr/bin/env bun

/**
 * Cut a release without ever moving the working branch.
 *
 * Atomic keeps `main` versionless: every package manifest (plus the
 * lockfile, the native binding checks, and README badges) sits at the `0.0.0`
 * placeholder. The real version is materialized **only** on a throwaway
 * `Release <version>` commit that is created off the chosen base, tagged, and
 * then abandoned. The commit is reachable solely through the tag — it is never
 * merged back into `main`. This mirrors how openai/codex tags releases.
 *
 * Mechanically:
 *   1. validate the version, drop the inherited repository-local git
 *      environment, and require a clean working tree
 *   2. resolve the current attached branch (or `--base`) to its exact remote branch SHA
 *   3. read publish.yml **out of that base commit** and verify every package it
 *      publishes is already registered on npm, before anything in the
 *      repository is touched (see --allow-new)
 *   4. stamp the real version into the worktree via scripts/bump-version.ts
 *      (including package-lock.json's workspace entries: `npm ci` refuses to
 *      install when the lockfile and a package.json disagree)
 *   5. regenerate release artifacts that must carry the stamped version, including
 *      packages/coding-agent/npm-shrinkwrap.json
 *   6. commit `Release <version>` and tag `<version>` inside the worktree
 *   7. remove the worktree — the tag (and its commit) persist in the repo
 *
 * Pushing the version tag directly starts publish.yml, which verifies the tag
 * commit identity before building and publishing the release.
 *
 * Usage:
 *   bun run scripts/cut-release.ts <version> [--base <ref>] [--push] [--yes] [--allow-new]
 *
 * Examples:
 *   bun run scripts/cut-release.ts 0.8.31
 *   bun run scripts/cut-release.ts 0.9.0-alpha.1
 *   bun run scripts/cut-release.ts 0.8.31 --base main --push
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { canonicalReleaseBaseRef } from "./release-base.js";
import {
	classifyNpmViewOutcome,
	type NpmRegistrationProbe,
	PUBLISH_WORKFLOW_PATH,
	parseReleasePublisher,
	type RegistrationPreflightResult,
	type ReleasePublisher,
	verifyReleasePackagesRegistered,
} from "./release-npm-preflight.js";

const STRICT_RELEASE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.([1-9]\d*))?$/;
const PLACEHOLDER_VERSIONS = new Set(["0.0.0", "0.0.0-dev"]);

const ROOT = resolve(import.meta.dir, "..");

interface Options {
	version: string;
	base: string | undefined;
	push: boolean;
	yes: boolean;
	allowNew: boolean;
}

function parseArgs(): Options {
	const argv = process.argv.slice(2);
	let version: string | undefined;
	let base: string | undefined;
	let push = false;
	let yes = false;
	let allowNew = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--base") {
			const candidate = argv[++i];
			if (!candidate || candidate.startsWith("-")) fail("--base requires a canonical remote branch name.");
			base = candidate;
		} else if (arg === "--push") {
			push = true;
		} else if (arg === "--allow-new") {
			allowNew = true;
		} else if (arg === "--yes" || arg === "-y") {
			yes = true;
		} else if (arg.startsWith("-")) {
			fail(`Unknown flag: ${arg}`);
		} else if (version === undefined) {
			version = arg;
		} else {
			fail(`Unexpected extra argument: ${arg}`);
		}
	}

	if (!version) {
		fail("Usage: bun run scripts/cut-release.ts <version> [--base <ref>] [--push] [--yes] [--allow-new]");
	}

	return { version: version as string, base, push, yes, allowNew };
}

function fail(message: string): never {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function validateVersion(version: string): void {
	if (PLACEHOLDER_VERSIONS.has(version)) {
		fail(`"${version}" is the development placeholder and must never be released.`);
	}
	if (!STRICT_RELEASE_VERSION_RE.test(version)) {
		fail(
			`"${version}" is not a valid release version. Expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-alpha.REVISION (e.g. 0.8.31 or 0.9.0-alpha.1).`,
		);
	}
}

/**
 * Git's repository-local environment variables, named by git itself.
 *
 * The fallback is only for a git too old to print the list; it names the six
 * that actually redirect a command.
 */
const FALLBACK_GIT_LOCAL_ENV_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

/**
 * Remove the inherited repository-local git environment from this process.
 *
 * Git honors `GIT_DIR` and its siblings over `-C <path>` and over a literal
 * path argument alike, and every repository this script touches is addressed
 * by path: the checkout it reads, and the temporary worktree it stamps,
 * commits, and tags. A caller that exports them — a git hook, or the
 * publish-release workflow running under one — would otherwise redirect all of
 * that into a repository nobody is releasing. `git rev-parse --local-env-vars`
 * is the list's own source, so this cannot drift as git adds to it.
 *
 * Every child is spawned after this runs, so deleting the keys here is what
 * scrubs `git`, `npm`, and the nested `bun` alike.
 */
async function scrubGitEnvironment(): Promise<void> {
	const listed = await $`git rev-parse --local-env-vars`.nothrow().quiet();
	const names =
		listed.exitCode === 0 ? listed.stdout.toString().split(/\s+/u).filter(Boolean) : FALLBACK_GIT_LOCAL_ENV_VARS;
	for (const name of names) delete process.env[name];
}

async function gitText(args: string[], cwd: string = ROOT): Promise<string> {
	return (await $`git -C ${cwd} ${args}`.text()).trim();
}

/**
 * Ask npm whether it knows a package name.
 *
 * The registry is pinned twice. `--registry` sets the default, and
 * `--<scope>:registry` overrides any scope-specific redirect an `.npmrc` on
 * this machine declares — npm resolves a scoped name through that redirect in
 * preference to `--registry`, so without the second flag the preflight could
 * vouch for a mirror while the release publishes somewhere else. npm's own
 * `npm_config_registry` is deliberately not consulted for the same reason.
 *
 * Any answer that is neither "yes" nor a 404 throws rather than counting as a
 * new package.
 */
function createNpmRegistrationProbe(registry: string): NpmRegistrationProbe {
	return async (packageName) => {
		const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
		const args = [
			"view",
			packageName,
			"name",
			`--registry=${registry}`,
			...(scope ? [`--${scope}:registry=${registry}`] : []),
		];
		const result = await $`npm ${args}`.nothrow().quiet();
		return classifyNpmViewOutcome(packageName, {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		});
	};
}

/**
 * Read publish.yml out of the commit that is about to be tagged.
 *
 * The caller's checkout is not the release. `--base` names another branch as
 * often as not, and the worktree, the version stamp, and the tag all come from
 * that branch's remote SHA — so a payload or a registry read from the working
 * tree would describe a release nobody is cutting.
 */
async function readPublisherAtBase(baseRef: string, baseSha: string): Promise<ReleasePublisher> {
	const shown = await $`git -C ${ROOT} show ${`${baseSha}:${PUBLISH_WORKFLOW_PATH}`}`.nothrow().quiet();
	if (shown.exitCode !== 0) {
		const detail = shown.stderr.toString().trim().split(/\r?\n/u)[0] ?? "git show failed";
		return fail(
			`Cannot read ${PUBLISH_WORKFLOW_PATH} from ${baseRef} (${baseSha.slice(0, 9)}): ${detail}. ` +
				`Fetch the base commit first: git fetch origin ${baseRef}`,
		);
	}
	try {
		return parseReleasePublisher(shown.stdout.toString());
	} catch (error) {
		return fail(`${(error as Error).message} (read from ${baseRef} at ${baseSha.slice(0, 9)})`);
	}
}

/**
 * The registration preflight, run before the first repository mutation.
 *
 * publish.yml publishes ten npm packages from one tag and its own `npm view`
 * call only skips versions that already exist — a name npm has never seen is
 * discovered at the end of the release, after the tag is pushed and the
 * binaries are built. Checking here costs one concurrent registry round-trip
 * and fails with nothing to unwind.
 */
async function preflightNpmRegistration(
	publisher: ReleasePublisher,
	allowNew: boolean,
): Promise<RegistrationPreflightResult> {
	try {
		const registration = await verifyReleasePackagesRegistered({
			packages: publisher.packages,
			isRegistered: createNpmRegistrationProbe(publisher.registry),
			allowNew,
		});
		if (registration.unregistered.length > 0) {
			console.log(`--allow-new: first publish for ${registration.unregistered.length} package(s):`);
			for (const name of registration.unregistered) console.log(`  + ${name}`);
			console.log("");
		}
		return registration;
	} catch (error) {
		return fail((error as Error).message);
	}
}

async function main(): Promise<void> {
	const { version, base, push, yes, allowNew } = parseArgs();
	validateVersion(version);
	await scrubGitEnvironment();

	// Refuse to operate on a dirty tree — the worktree is created from committed
	// state, so uncommitted edits would silently be excluded from the release.
	const dirty = await gitText(["status", "--porcelain"]);
	if (dirty) {
		fail("Working tree is not clean. Commit or stash changes before cutting a release.");
	}

	// The tag is the release. Never clobber an existing one.
	const existingTag = await $`git -C ${ROOT} tag --list ${version}`.text();
	if (existingTag.trim()) {
		fail(`Tag ${version} already exists.`);
	}

	// Resolve the base before anything is checked against it: the release is cut
	// from this commit, so this is the publish.yml the preflight must read.
	const branch = await gitText(["rev-parse", "--abbrev-ref", "HEAD"]);
	const baseBranch = base ?? branch;
	if (baseBranch === "HEAD") {
		fail("A canonical remote base branch is required when cutting a release from detached HEAD.");
	}
	let baseRef: string;
	try {
		baseRef = canonicalReleaseBaseRef(baseBranch);
	} catch (error) {
		return fail((error as Error).message);
	}
	const remoteBase = await $`git -C ${ROOT} ls-remote --exit-code --refs origin ${baseRef}`.nothrow().quiet();
	if (remoteBase.exitCode !== 0) {
		fail(`Base ref "${baseRef}" does not exist on origin.`);
	}
	const remoteFields = remoteBase.stdout.toString().trim().split(/\s+/u);
	const baseSha = remoteFields[0];
	if (!baseSha || !/^[0-9a-f]{40}$/u.test(baseSha) || remoteFields[1] !== baseRef || remoteFields.length !== 2) {
		fail(`Base ref "${baseRef}" did not resolve to exactly one immutable remote commit.`);
	}

	const publisher = await readPublisherAtBase(baseRef, baseSha);
	const registration = await preflightNpmRegistration(publisher, allowNew);

	const name = (await $`git -C ${ROOT} config user.name`.nothrow().text()).trim() || "atomic-release";
	const email =
		(await $`git -C ${ROOT} config user.email`.nothrow().text()).trim() || "atomic-release@users.noreply.github.com";

	const registered = registration.checked.length - registration.unregistered.length;
	console.log(`Cutting release ${version}`);
	console.log(`  base:   ${baseRef} (${baseSha.slice(0, 9)})`);
	console.log(
		`  npm:    ${registered}/${registration.checked.length} publish-payload packages registered on ${publisher.registry}`,
	);
	console.log(`  branch: ${branch} (left untouched)\n`);

	if (!yes) console.log("Proceeding immediately; pass --yes to suppress this notice.\n");

	// Every mutation below this line — the prune, the worktree, the stamp, the
	// tag — is preceded by the registry check, so an unregistered package name
	// aborts a release that has changed nothing.
	await $`git -C ${ROOT} worktree prune`.quiet();

	const tmpRoot = mkdtempSync(join(tmpdir(), "atomic-release-"));
	const worktreeDir = join(tmpRoot, "wt");
	let worktreeAdded = false;

	try {
		await $`git -C ${ROOT} worktree add --detach ${worktreeDir} ${baseSha}`.quiet();
		worktreeAdded = true;

		// Stamp the real version into the detached worktree only, then regenerate
		// release artifacts that encode the stamped version. The shrinkwrap generator
		// is hermetic: internal Atomic packages use deterministic registry tarball
		// URLs derived from local package metadata rather than npm registry metadata.
		await $`bun run ${join(ROOT, "scripts/bump-version.ts")} ${version} --root ${worktreeDir}`;
		await $`bun run ${join(worktreeDir, "scripts/generate-coding-agent-shrinkwrap.mjs")}`;

		// bump-version.ts also stamps package-lock.json's workspace entries, so the
		// tagged commit installs cleanly with `npm ci`. No relock is needed: only
		// first-party versions changed, which avoids a network round-trip here.
		await $`git -C ${worktreeDir} add -A`;
		const commitMessage = `Release ${version}\n\nRelease-base-ref: ${baseRef}\nRelease-base-sha: ${baseSha}`;
		await $`git -C ${worktreeDir} -c user.name=${name} -c user.email=${email} commit --no-verify -m ${commitMessage}`.quiet();
		// Lightweight tag, matching the repo's publish trigger + verification convention.
		await $`git -C ${worktreeDir} -c user.name=${name} -c user.email=${email} tag ${version}`.quiet();
	} finally {
		if (worktreeAdded) {
			await $`git -C ${ROOT} worktree remove --force ${worktreeDir}`.nothrow().quiet();
		}
		rmSync(tmpRoot, { recursive: true, force: true });
	}

	// Sanity-check the tagged tree carries the real version (and main does not).
	const taggedVersion = JSON.parse(
		await $`git -C ${ROOT} show ${`${version}:packages/coding-agent/package.json`}`.text(),
	).version as string;
	if (taggedVersion !== version) {
		fail(`Tagged commit version ${taggedVersion} does not match ${version} — aborting.`);
	}

	const tagSha = await gitText(["rev-list", "-n", "1", version]);
	console.log(`\nCreated tag ${version} -> ${tagSha.slice(0, 9)} (Release ${version})`);
	console.log(`${branch} stays versionless; the release commit lives only on the tag.\n`);

	if (push) {
		console.log(`Pushing tag ${version}...`);
		// Fully-qualified on both sides. `git push origin <version>` resolves the
		// bare name against every ref namespace, so a branch sharing the version's
		// name would push refs/heads and refs/tags together — one command, two ref
		// updates, two publish.yml runs racing the same npm version. Naming the tag
		// ref explicitly makes that impossible regardless of what else is named.
		await $`git -C ${ROOT} push origin ${`refs/tags/${version}:refs/tags/${version}`}`;
		console.log(`Tag pushed. This is the publication signal: publish.yml is now running for ${version}.`);
		console.log(
			"Do not push this tag again — a second push re-triggers the publisher against a version that is already being published.",
		);
	} else {
		console.log("Next: push the tag to trigger the publisher:");
		console.log(`  git push origin refs/tags/${version}:refs/tags/${version}`);
	}
}

await main();
