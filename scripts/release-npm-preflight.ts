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
 * Both halves of the question are read out of `publish.yml` rather than
 * restated here: which names ship, and which registry they ship to. The
 * publisher is the thing that publishes; a second hand-maintained list would
 * drift from it silently, and the preflight would then vouch for a payload
 * nobody ships or for a registry nobody publishes to. The count is deliberately
 * *not* enforced at cut time — the workflow already fails a run whose packed
 * tarballs do not number ten, and `test/unit/release-npm-preflight.test.ts`
 * pins the ten names this repository expects.
 *
 * The source is a string, never a path: `cut-release.ts` reads `publish.yml`
 * out of the *release base commit* it is about to tag, not out of the caller's
 * checkout, and those two differ whenever `--base` names another branch.
 *
 * No Bun import: the probe is injected, so the whole module runs under Node in
 * the test suites while `cut-release.ts` supplies the real `npm view` call.
 */

/** The publisher that owns the release payload, relative to the repository root. */
export const PUBLISH_WORKFLOW_PATH = ".github/workflows/publish.yml";

/**
 * The registry `publish.yml` publishes to.
 *
 * Documentation and a unit-test anchor, **not** a fallback: the registry the
 * preflight asks is always parsed from the publisher, so this constant going
 * stale fails a test rather than quietly redirecting a probe.
 */
export const PUBLISHER_NPM_REGISTRY = "https://registry.npmjs.org";

/** Number of npm packages one release tag publishes; asserted against `publish.yml` by unit test. */
export const RELEASE_PAYLOAD_PACKAGE_COUNT = 10;

const PACKAGES_ARRAY_RE = /^[ \t]*packages=\(([^)]*)\)[ \t]*$/gmu;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const REGISTRY_FLAG_RE = /--registry[= \t]+([^\s"'|;&]+)/gu;

/** The raw result of one `npm view <name>` invocation. */
export interface NpmViewOutcome {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Resolves to `true` when npm knows the package name, `false` when it does not. */
export type NpmRegistrationProbe = (packageName: string) => Promise<boolean>;

/** What `publish.yml` publishes, and where. */
export interface ReleasePublisher {
	readonly packages: readonly string[];
	readonly registry: string;
}

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

/**
 * The registry to ask: the one `publish.yml` pins on its own npm commands.
 *
 * npm's `npm_config_registry` is deliberately **not** consulted. A mirror or a
 * proxy can answer "yes" for a name that does not exist on the registry the
 * release will actually publish to, and that answer would clear a preflight
 * whose entire job is to predict the publish. The publisher passes `--registry`
 * explicitly on every npm command it runs, so the flag is parsed from the same
 * file — and the same commit — the payload comes from.
 */
export function parsePublisherNpmRegistry(workflowSource: string): string {
	const values = [...new Set([...workflowSource.matchAll(REGISTRY_FLAG_RE)].map((match) => match[1] as string))];
	if (values.length === 0) {
		throw new Error(
			`${PUBLISH_WORKFLOW_PATH} pins no \`--registry\` on its npm commands, so the registry the release ` +
				"publishes to cannot be determined. The preflight refuses to guess one.",
		);
	}
	if (values.length > 1) {
		throw new Error(
			`${PUBLISH_WORKFLOW_PATH} pins more than one \`--registry\`: ${values.join(", ")}. ` +
				"The preflight cannot tell which one the release publishes to.",
		);
	}
	const registry = values[0] as string;
	let parsed: URL;
	try {
		parsed = new URL(registry);
	} catch {
		throw new Error(`${PUBLISH_WORKFLOW_PATH} pins \`--registry ${registry}\`, which is not an absolute URL.`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`${PUBLISH_WORKFLOW_PATH} pins \`--registry ${registry}\`, which is not an http(s) registry.`);
	}
	return registry;
}

/** Read both halves of the publisher's contract out of one `publish.yml` source. */
export function parseReleasePublisher(workflowSource: string): ReleasePublisher {
	return {
		packages: parseReleasePayloadPackages(workflowSource),
		registry: parsePublisherNpmRegistry(workflowSource),
	};
}

/**
 * Decide what one `npm view` invocation actually said.
 *
 * Exit 0 is registered and a 404 is not registered. **Every other outcome is
 * indeterminate and throws**: an unreachable registry, a missing npm, or an
 * auth error says nothing about whether the name exists, and reading it as
 * "new" would let `--allow-new` wave through a broken probe.
 *
 * A null exit code is checked *first*, before any output is read. It means the
 * command was killed by a signal, so whatever it had printed by then is a
 * fragment of an answer it never finished giving — a 404 in that fragment is
 * not a registry verdict, and treating it as one would let a timeout or a
 * Ctrl-C register as "this package is new".
 */
export function classifyNpmViewOutcome(packageName: string, outcome: NpmViewOutcome): boolean {
	const answer = `${outcome.stdout}\n${outcome.stderr}`;
	if (outcome.exitCode === null) {
		throw new Error(
			`\`npm view ${packageName}\` was terminated by a signal, so its registration is unknown` +
				`${describeNpmViewAnswer(answer)}`,
		);
	}
	if (outcome.exitCode === 0) return true;
	if (answer.includes("E404") || answer.includes("404 Not Found") || answer.includes("is not in this registry")) {
		return false;
	}
	throw new Error(
		`\`npm view ${packageName}\` exited ${outcome.exitCode} without a 404, so its registration is unknown` +
			`${describeNpmViewAnswer(answer)}`,
	);
}

/** The first lines carry npm's error code; the tail is a log path and proxy advice. */
function describeNpmViewAnswer(answer: string): string {
	const detail = answer
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(0, 3)
		.join(" | ")
		.slice(0, 300);
	return detail ? `: ${detail}` : ".";
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
