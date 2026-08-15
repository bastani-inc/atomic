/**
 * npm registration preflight for `scripts/cut-release.ts`.
 *
 * `publish.yml` publishes a fixed payload from one tag: the eight native
 * platform packages, `@bastani/atomic-natives`, and `@bastani/atomic`. Its own
 * `npm view` call is an *idempotency* check that runs after the binaries are
 * built — it skips a version that already exists. Nothing before that point
 * asks whether the package **name** exists at all, so a name npm has never seen
 * fails at the last step of a long release: the tag is pushed, the draft is
 * staged, and the publish job dies on a registry the runner cannot create a new
 * name on unattended.
 *
 * This module answers that question while it is still cheap to answer — before
 * `cut-release.ts` touches a worktree, stamps a version, or writes a tag.
 *
 * The payload is read from `publish.yml` rather than restated here. The
 * publisher is the thing that publishes; a second hand-maintained list would
 * drift from it silently, and the preflight would then vouch for a payload
 * nobody ships. The count is deliberately *not* enforced at cut time — the
 * workflow already fails a run whose packed tarballs do not number ten, and
 * `test/ci/release-publisher-contracts.test.ts` pins the ten names this
 * repository expects.
 *
 * No Bun import: the probe is injected, so the whole module runs under Node in
 * the test suites while `cut-release.ts` supplies the real `npm view` call.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The publisher that owns the release payload, relative to the repository root. */
export const PUBLISH_WORKFLOW_PATH = ".github/workflows/publish.yml";

/** The registry `publish.yml` publishes to, and the default this preflight asks. */
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** Number of npm packages one release tag publishes; asserted against `publish.yml` by contract test. */
export const RELEASE_PAYLOAD_PACKAGE_COUNT = 10;

const PACKAGES_ARRAY_RE = /^[ \t]*packages=\(([^)]*)\)[ \t]*$/gmu;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

/** The raw result of one `npm view <name>` invocation. */
export interface NpmViewOutcome {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Resolves to `true` when npm knows the package name, `false` when it does not. */
export type NpmRegistrationProbe = (packageName: string) => Promise<boolean>;

export interface RegistrationPreflightOptions {
	/** Package names to check. Defaults to whatever `publish.yml` publishes. */
	readonly packages: readonly string[];
	readonly isRegistered: NpmRegistrationProbe;
	/** Permit names npm has never seen — a deliberate first publish. */
	readonly allowNew: boolean;
}

export interface RegistrationPreflightResult {
	readonly checked: readonly string[];
	/** Names npm has never seen. Non-empty only when `allowNew` was passed. */
	readonly unregistered: readonly string[];
}

/**
 * The registry to ask.
 *
 * `npm_config_registry` is npm's own configuration variable, so a mirror or an
 * enterprise proxy is honored rather than probed around. Anything else falls
 * back to the registry `publish.yml` names.
 */
export function resolveNpmRegistry(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.npm_config_registry?.trim();
	return configured && configured.length > 0 ? configured : DEFAULT_NPM_REGISTRY;
}

/** Extract the publish payload from `publish.yml`'s `packages=(…)` array. */
export function parseReleasePayloadPackages(workflowSource: string): string[] {
	const matches = [...workflowSource.matchAll(PACKAGES_ARRAY_RE)];
	if (matches.length !== 1) {
		throw new Error(
			`${PUBLISH_WORKFLOW_PATH} must declare exactly one \`packages=(…)\` publish payload array; found ${matches.length}.`,
		);
	}
	const names = (matches[0]?.[1] ?? "").split(/\s+/u).filter((name) => name.length > 0);
	if (names.length === 0) {
		throw new Error(`${PUBLISH_WORKFLOW_PATH} declares an empty \`packages=(…)\` publish payload array.`);
	}
	for (const name of names) {
		if (!PACKAGE_NAME_RE.test(name)) {
			throw new Error(`${PUBLISH_WORKFLOW_PATH} declares "${name}", which is not a publishable npm package name.`);
		}
	}
	const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
	if (duplicates.length > 0) {
		throw new Error(
			`${PUBLISH_WORKFLOW_PATH} declares duplicate publish payload packages: ${duplicates.join(", ")}.`,
		);
	}
	return names;
}

/** Read the publish payload package names out of the repository at `root`. */
export function readReleasePayloadPackages(root: string): string[] {
	const path = join(root, PUBLISH_WORKFLOW_PATH);
	let source: string;
	try {
		source = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`Cannot read the release payload from ${path}: ${(error as Error).message}`);
	}
	return parseReleasePayloadPackages(source);
}

/**
 * Decide what one `npm view` invocation actually said.
 *
 * Exit 0 is registered and a 404 is not registered. **Every other failure is
 * indeterminate and throws**: an unreachable registry, a missing npm, or an
 * auth error says nothing about whether the name exists, and reading it as
 * "new" would let `--allow-new` wave through a broken probe.
 */
export function classifyNpmViewOutcome(packageName: string, outcome: NpmViewOutcome): boolean {
	if (outcome.exitCode === 0) return true;
	const answer = `${outcome.stdout}\n${outcome.stderr}`;
	if (answer.includes("E404") || answer.includes("404 Not Found") || answer.includes("is not in this registry")) {
		return false;
	}
	// The first lines carry npm's error code; the tail is a log path and proxy advice.
	const detail = answer
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(0, 3)
		.join(" | ")
		.slice(0, 300);
	throw new Error(
		`\`npm view ${packageName}\` exited ${outcome.exitCode ?? "with a signal"} without a 404, so its registration is unknown` +
			`${detail ? `: ${detail}` : "."}`,
	);
}

/** The abort message for names npm has never seen. */
export function describeUnregisteredPackages(unregistered: readonly string[], checkedCount: number): string {
	const listed = unregistered.map((name) => `  - ${name}`).join("\n");
	return (
		`Refusing to cut a release: ${unregistered.length} of ${checkedCount} publish-payload packages ` +
		`${unregistered.length === 1 ? "is" : "are"} not registered on npm:\n${listed}\n` +
		"One tag publishes the whole payload, so a name npm has never seen fails after the binaries are built. " +
		"Re-run with --allow-new to publish these names for the first time deliberately."
	);
}

/**
 * Probe every payload package and refuse the release unless each one exists.
 *
 * Throws — the caller aborts on it — when a name is unregistered without
 * `--allow-new`, or when any probe could not determine an answer. `--allow-new`
 * relaxes only the first case.
 */
export async function verifyReleasePackagesRegistered(
	options: RegistrationPreflightOptions,
): Promise<RegistrationPreflightResult> {
	const packages = [...options.packages];
	if (packages.length === 0) {
		throw new Error("Release payload preflight requires at least one package name.");
	}
	const outcomes = await Promise.allSettled(
		packages.map(async (name) => ({ name, registered: await options.isRegistered(name) })),
	);

	const indeterminate: string[] = [];
	const unregistered: string[] = [];
	for (const [index, outcome] of outcomes.entries()) {
		if (outcome.status === "rejected") {
			const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
			indeterminate.push(`  - ${packages[index]}: ${reason}`);
		} else if (!outcome.value.registered) {
			unregistered.push(outcome.value.name);
		}
	}

	if (indeterminate.length > 0) {
		throw new Error(
			`Refusing to cut a release: npm registration could not be determined for ${indeterminate.length} of ` +
				`${packages.length} publish-payload packages:\n${indeterminate.join("\n")}\n` +
				"--allow-new does not cover an unreadable registry answer.",
		);
	}
	if (unregistered.length > 0 && !options.allowNew) {
		throw new Error(describeUnregisteredPackages(unregistered, packages.length));
	}
	return { checked: packages, unregistered };
}
