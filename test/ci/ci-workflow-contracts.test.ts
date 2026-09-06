import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { parse as parseYaml } from "yaml";
import {
	canonicalReleaseBaseRef,
	parseReleaseBaseTrailers,
	validateCanonicalReleaseBaseRef,
} from "../../scripts/release-base.js";
import {
	chmodSync,
	makeDirectorySync,
	makeTempDirectory,
	readJson,
	readTextSync,
	removeTempDirectory,
	spawnSyncCollect,
	writeTextSync,
} from "../helpers/runtime.js";
import { jobBlock, jobBlocks, jobSteps, namedStep, readText } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const publishPath = join(root, ".github/workflows/publish.yml");
const testPath = join(root, ".github/workflows/test.yml");
const warmPath = join(root, ".github/workflows/warm-toolchain-cache.yml");

/**
 * The `test` job's own topology contracts live in test-workflow-topology.test.ts.
 * It is now a result gate over five concurrent work jobs, and the
 * anti-un-protection assertions belong beside the ones describing that split.
 */
/**
 * The per-test timeout budget is declared once, in vitest.config.ts.
 *
 * It used to live in the three `test:*` package scripts as `--timeout 30000`,
 * because Bun 1.3.14 silently ignores `[test] timeout` in bunfig.toml and CI
 * reached every suite through `bun run <script>`. Under vitest the budget is a
 * config value, so the choke point moves with it -- the policy does not: one
 * platform-neutral value, resolved identically by every project and by CI, never
 * a Windows-only branch. This asserts the resolution, not the spelling.
 */
test("every test suite entry point resolves to one shared per-test timeout", async () => {
	const manifest = (await readJson(join(root, "package.json"))) as { scripts: Record<string, string> };
	const config = (await import("../../vitest.config.js")) as {
		default: { test?: { projects?: { test?: { name?: string; testTimeout?: number } }[] } };
	};
	const projects = config.default.test?.projects ?? [];
	assert.equal(projects.length, 3, "one vitest project per suite directory");

	const budgets = new Set<number>();
	for (const script of ["test:unit", "test:integration", "test:ci-contracts"]) {
		const command = manifest.scripts[script];
		assert.ok(command, `missing script: ${script}`);
		const selected = /--project[= ](\S+)/u.exec(command as string);
		assert.ok(selected, `${script} must select exactly one vitest project`);
		const project = projects.find((entry) => entry.test?.name === selected[1]);
		assert.ok(project, `${script} selects an unknown vitest project: ${selected[1]}`);
		const value = project.test?.testTimeout;
		assert.ok(typeof value === "number", `project ${selected[1]} declares no testTimeout`);
		assert.ok(value >= 30_000, `${script} timeout ${value} is below the 30000 ms floor`);
		assert.ok(value <= 120_000, `${script} timeout ${value} would outlive the Windows job budget`);
		budgets.add(value);
	}
	assert.equal(budgets.size, 1, `suite timeouts diverged: ${[...budgets].join(", ")}`);

	// bunfig.toml must not grow a per-test budget again: Bun ignores it, so a
	// value there would look authoritative and enforce nothing.
	assert.doesNotMatch(await readText(join(root, "bunfig.toml")), /^\s*timeout\s*=/mu);
	// No script may reintroduce a second declaration beside the config one.
	for (const command of Object.values(manifest.scripts)) {
		assert.doesNotMatch(command, /--timeout[= ]\d+/u, `the budget lives in vitest.config.ts only: ${command}`);
	}
	assert.match(await readText(join(root, ".github/workflows/test.yml")), /run-flaky-test-suite\.ts/u);
});

/**
 * Run 33833721342 reached `npm ci` with an exact-key cache hit, then emitted
 * nothing for the full six-minute static-checks job cap. npm's former default
 * allowed one HTTP request to wait 300 seconds before either of its retries,
 * so the install policy could not recover before the job that owned it died.
 *
 * Bound one request conservatively as every attempt consuming fetch-timeout
 * plus every retry consuming the maximum backoff. The measured job caps no
 * longer reserve three times that allowance. Keep it below the smallest cap
 * among jobs that install with npm; the npm-free result gate is irrelevant.
 * This is not a completion guarantee: setup and other work share the cap, and
 * the enclosing job deadline can interrupt a request or its retries.
 */
test("npm registry request retries are bounded below npm-installing CI job caps", async () => {
	const npmConfig = new Map(
		(await readText(join(root, ".npmrc")))
			.split("\n")
			.map((line) => /^(?<key>[a-z][a-z-]*)=(?<value>\S+)$/u.exec(line)?.groups)
			.filter((entry): entry is { key: string; value: string } => entry !== undefined)
			.map(({ key, value }) => [key, value]),
	);
	const integerConfig = (name: string): number => {
		const value = npmConfig.get(name);
		assert.ok(value, `.npmrc must declare ${name}`);
		assert.match(value, /^\d+$/u, `${name} must be an integer, received ${value}`);
		return Number(value);
	};
	const fetchTimeoutMs = integerConfig("fetch-timeout");
	const fetchRetries = integerConfig("fetch-retries");
	const retryMinTimeoutMs = integerConfig("fetch-retry-mintimeout");
	const retryMaxTimeoutMs = integerConfig("fetch-retry-maxtimeout");
	assert.ok(fetchRetries >= 1, "a transient registry stall must receive at least one retry");
	assert.ok(retryMinTimeoutMs > 0, "registry retries need a positive backoff");
	assert.ok(retryMinTimeoutMs <= retryMaxTimeoutMs, "minimum retry backoff must not exceed its maximum");

	const workflow = parseYaml(await readText(testPath)) as Workflow;
	const jobBudgetsMinutes = Object.values(workflow.jobs ?? {}).flatMap((job) => {
		if (!job.steps?.some((step) => /\bnpm ci\b/u.test(step.run ?? ""))) return [];
		const directBudget = job["timeout-minutes"];
		const direct = typeof directBudget === "number" ? [directBudget] : [];
		const matrix = (job.strategy?.matrix?.include ?? []).flatMap((entry) => {
			const budget = entry.timeout_minutes;
			return typeof budget === "number" ? [budget] : [];
		});
		return [...direct, ...matrix];
	});
	assert.ok(jobBudgetsMinutes.length > 0, "test.yml must declare npm-installing job timeout budgets");
	const smallestJobBudgetMs = Math.min(...jobBudgetsMinutes) * 60_000;
	const stalledRequestBudgetMs = fetchTimeoutMs * (fetchRetries + 1) + retryMaxTimeoutMs * fetchRetries;
	assert.ok(
		stalledRequestBudgetMs < smallestJobBudgetMs,
		`one stalled npm request can consume ${stalledRequestBudgetMs}ms, not below the smallest npm-installing CI job cap (${smallestJobBudgetMs}ms)`,
	);
});

/**
 * Run 33833721342 let the packed-artifact test's npm child consume the same
 * 240-second budget as the whole test. The child timed out, and the 243795 ms
 * test duration then exceeded the suite's 70% headroom gate as a second,
 * guaranteed failure. The fixture lives outside the repository too, so npm
 * does not discover the committed project .npmrc by walking up from its cwd.
 */
test("packed-artifact children cannot consume the whole test budget", async () => {
	const source = await readText(join(root, "test/integration/packed-workflow-sdk-types.test.ts"));
	const namedBudget = (name: string): number => {
		const declaration = new RegExp(`^const ${name} = ([\\d_]+);$`, "mu").exec(source);
		assert.ok(declaration, `packed-artifact test must declare ${name}`);
		return Number((declaration[1] as string).replaceAll("_", ""));
	};
	const subprocessBudgetMs = namedBudget("PACKED_ARTIFACT_SUBPROCESS_TIMEOUT_MS");
	const testBudgetMs = namedBudget("PACKED_ARTIFACT_TYPECHECK_TEST_TIMEOUT_MS");
	assert.ok(
		subprocessBudgetMs < testBudgetMs,
		`packed-artifact subprocess budget ${subprocessBudgetMs}ms must be strictly smaller than its ${testBudgetMs}ms test budget`,
	);
	assert.match(source, /timeout: PACKED_ARTIFACT_SUBPROCESS_TIMEOUT_MS/u);
	assert.match(source, /^\tPACKED_ARTIFACT_TYPECHECK_TEST_TIMEOUT_MS,$/mu);
	assert.match(
		source,
		/`--userconfig=\$\{npmConfigPath\}`/u,
		"the temp-dir install must explicitly use the repo .npmrc",
	);
});

test("global setups provide artifacts and native bindings to every project", async () => {
	const config = (await import("../../vitest.config.js")) as {
		default: {
			test?: {
				projects?: { test?: { name?: string; globalSetup?: string[] } }[];
			};
		};
	};
	const projects = config.default.test?.projects ?? [];
	const artifactSetup = "./test/global-setup-workflow-artifacts.ts";
	const nativeSetup = "./test/global-setup-natives.ts";
	for (const name of ["unit", "integration", "ci"]) {
		const project = projects.find((entry) => entry.test?.name === name);
		assert.ok(project, `missing vitest project: ${name}`);
		assert.deepEqual(
			project.test?.globalSetup,
			[artifactSetup, nativeSetup],
			`${name} must keep the artifact and native global setups`,
		);
	}
});

/**
 * No package script may write a workspace selector after `npm run <script>`.
 *
 * Bun rewrites the literal `npm run` prefix inside a package script to
 * `bun run`, and `bun run` has no `--workspace`/`--workspaces`: it forwards the
 * flag to the script as a positional argument. `npm run typecheck
 * --workspace=@bastani/atomic` therefore re-entered the *root* `typecheck`
 * under Bun, appending one more copy of the flag on every pass, and recursed
 * until it was killed -- so `bun run check` and `bun run typecheck` were
 * unusable while `npm run check` passed.
 *
 * Writing the selector before the `run` verb (`npm --workspace=X run Y`) does
 * not match Bun's prefix rewrite, so both runtimes reach npm's real workspace
 * resolution. This asserts the ordering, which is the part Bun keys on.
 */
test("workspace selectors precede the run verb so Bun cannot rewrite them", async () => {
	const manifests = [
		"package.json",
		...(await readdir(join(root, "packages"))).map((p) => `packages/${p}/package.json`),
	];
	for (const relative of manifests) {
		const path = join(root, relative);
		if (!existsSync(path)) continue;
		const manifest = (await readJson(path)) as { scripts?: Record<string, string> };
		for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
			assert.doesNotMatch(
				command,
				/\bnpm run\s+\S+\s+--workspaces?\b/u,
				`${relative} script "${name}" puts a workspace selector after the run verb, which Bun turns into a positional argument: ${command}`,
			);
		}
	}
});

test("root build emits the packed Atomic package after its prerequisites", async () => {
	const manifest = (await readJson(join(root, "package.json"))) as { scripts: Record<string, string> };
	assert.equal(
		manifest.scripts.build,
		"npm --workspace=@bastani/pi-ai run build && node scripts/alias-pi-ai.mjs && npm --workspace=@bastani/atomic-natives run build && npm --workspace=@bastani/atomic run build",
	);
});

test("typecheck aliases the local pi-ai build before compiling dependents", async () => {
	const manifest = (await readJson(join(root, "package.json"))) as { scripts: Record<string, string> };
	assert.equal(
		manifest.scripts.typecheck,
		"npm --workspace=@bastani/pi-ai run build && node scripts/alias-pi-ai.mjs && tsc --noEmit && npm --workspace=@bastani/atomic run typecheck",
	);
});

/**
 * SQLite selectors must keep working on both runtimes, and their tests must
 * keep asserting on both.
 *
 * `src/core/tools/resource-selectors.ts` used to require `bun:sqlite`, which
 * exists only under Bun. When the suite moved to Node, one SQLite test silently
 * became `it.skip` and eleven more kept their names, kept passing, and executed
 * no assertions behind `if (!sqlite) return`. Neither shows up in a pass/fail
 * count or a test-name diff, so the guard is structural: the loader must use
 * `node:sqlite`, which Node >= 22.13 and Bun >= 1.4.0 (this repository's
 * floor) both ship — the `bun:sqlite` fallback is deleted and must not come
 * back — and no test may reintroduce a soft guard that turns an unavailable
 * module into a green no-op.
 */
test("SQLite selectors resolve on either runtime and their tests cannot silently empty", async () => {
	const selectors = await readText(join(root, "packages/coding-agent/src/core/tools/resource-selectors.ts"));
	assert.ok(selectors.includes('requireModule("node:sqlite")'), "resource-selectors must load node:sqlite");
	assert.ok(
		!selectors.includes('requireModule("bun:sqlite")'),
		"the bun:sqlite fallback was deleted with the Bun 1.4.0 floor and must not come back",
	);

	// A single project: the runtime split existed only because the loader was
	// Bun-only; it must not come back.
	const config = (await import("../../packages/coding-agent/vitest.config.js")) as {
		default: { test?: { projects?: { test?: { name?: string; include?: string[]; exclude?: string[] } }[] } };
	};
	const projects = (config.default.test?.projects ?? []).map((entry) => entry.test?.name ?? "");
	assert.deepEqual(projects, ["agent"]);

	// No SQLite test may be excluded from collection, and none may carry a soft
	// guard that skips or returns early when a module is missing.
	const testDir = join(root, "packages/coding-agent/test");
	const excluded = new Set((config.default.test?.projects ?? [])[0]?.test?.exclude ?? []);
	for (const entry of await readdir(testDir, { recursive: true })) {
		if (!entry.endsWith(".test.ts")) continue;
		const relative = `test/${entry.replaceAll("\\", "/")}`;
		const source = await readText(join(testDir, entry));
		if (!/sqlite/iu.test(source)) continue;
		assert.ok(!excluded.has(relative), `${relative} is excluded from collection`);
		assert.doesNotMatch(source, /if\s*\(!\s*(?:mod|sqlite|sqliteMod)\s*\)\s*return/u, relative);
		assert.doesNotMatch(source, /\?\s*it\s*:\s*it\.skip/u, relative);
	}

	const manifest = (await readJson(join(root, "packages/coding-agent/package.json"))) as {
		scripts: Record<string, string>;
	};
	assert.equal(manifest.scripts.test, "vitest --run");
	assert.ok(manifest.scripts["test:bun"] === undefined, "the Bun-hosted half must not come back");
	assert.doesNotMatch(await readText(join(root, ".github/workflows/test.yml")), /test:bun/u);
});

test("active CI workflows contain no removed Cursor builtin smoke checks", async () => {
	for (const path of [join(root, ".github/workflows/test.yml"), publishPath]) {
		assert.doesNotMatch(await readText(path), /builtin\/cursor/iu, path);
	}
});

test("binary staging and every release smoke verify the exact builtin directory set", async () => {
	const checker = /scripts\/assert-builtin-set\.ts/u;
	const testWorkflow = await readText(join(root, ".github/workflows/test.yml"));
	const publishWorkflow = await readText(publishPath);
	const buildScript = await readText(join(root, "scripts/build-binaries.sh"));

	// Both smoke steps now live in the release-archive job. Anchor on the job so
	// the assertion does not depend on which step happens to follow them.
	const archiveSteps = jobSteps(jobBlock(testWorkflow, "release-archive", "static-checks"));
	for (const platform of ["Linux", "Windows"]) {
		assert.match(namedStep(archiveSteps, `Smoke test ${platform} release archive`), checker);
	}
	assert.equal(testWorkflow.split("scripts/assert-builtin-set.ts").length - 1, 2);
	assert.match(jobBlock(publishWorkflow, "linux-binary-smoke", "windows-binary-smoke"), checker);
	assert.match(jobBlock(publishWorkflow, "windows-binary-smoke", "build"), checker);
	assert.match(jobBlock(publishWorkflow, "build", "stage-github-release"), checker);
	assert.equal(publishWorkflow.split("scripts/assert-builtin-set.ts").length - 1, 3);
	assert.match(buildScript, /assert-builtin-set\.ts "binaries\/\$platform\/builtin"/u);
});

test("publish workflow has direct tag and recovery triggers", async () => {
	const workflow = await readText(publishPath);
	assert.match(workflow, /push:\s*\n\s*tags:/);
	assert.match(workflow, /"\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*"/);
	assert.match(
		workflow,
		/workflow_dispatch:\s*\n\s*inputs:\s*\n\s*tag:[\s\S]*required: true[\s\S]*source_ref:[\s\S]*required: false/,
	);
	assert.match(
		workflow,
		/SOURCE_REF: \$\{\{ github\.event\.inputs\.source_ref \|\| github\.event\.inputs\.tag \|\| github\.ref_name \}\}/,
	);
	assert.doesNotMatch(workflow, /workflow_run:|create:|repository_dispatch:/);
});

test("publish workflow uses one lightweight integrity gate", async () => {
	const workflow = await readText(publishPath);
	const integrity = jobBlock(workflow, "integrity", "native-artifacts");
	assert.equal([...workflow.matchAll(/^ {2}integrity:$/gmu)].length, 1);
	assert.match(integrity, /ref: \$\{\{ env\.RELEASE_TAG \}\}/);
	assert.match(integrity, /packages\/coding-agent\/package\.json/);
	assert.match(integrity, /Package version \$version does not match tag \$RELEASE_TAG/);
	assert.match(integrity, /subject.*git show -s --format=%s/);
	assert.match(integrity, /Release \$RELEASE_TAG/);
	assert.doesNotMatch(
		integrity,
		/Release-base-|merge-base|workflow_ref|workflow_sha|git archive|bump-version|generate-coding-agent-shrinkwrap/iu,
	);
});

test("publish graph stages a draft before npm and undrafts last", async () => {
	const workflow = await readText(publishPath);
	for (const job of [
		"integrity",
		"native-artifacts",
		"linux-binary-smoke",
		"windows-binary-smoke",
		"alpine-binary-smoke",
		"build",
		"stage-github-release",
		"publish-npm",
		"publish-github-release",
		"cleanup-draft-github-release",
	]) {
		assert.match(workflow, new RegExp(`^  ${job}:$`, "mu"));
	}
	assert.match(
		jobBlock(workflow, "build", "stage-github-release"),
		/needs: \[integrity, native-artifacts, linux-binary-smoke, windows-binary-smoke, alpine-binary-smoke\]/,
	);
	const stage = jobBlock(workflow, "stage-github-release", "publish-npm");
	assert.match(stage, /needs: \[integrity, build\]/);
	assert.match(stage, /already published.*Refusing to mutate[\s\S]*--verify-tag --draft/s);
	assert.match(
		jobBlock(workflow, "publish-npm", "publish-github-release"),
		/needs: \[integrity, stage-github-release\]/,
	);
	assert.match(
		jobBlock(workflow, "publish-github-release", "cleanup-draft-github-release"),
		/needs: \[stage-github-release, publish-npm\][\s\S]*--draft=false/,
	);
	assert.match(
		jobBlock(workflow, "cleanup-draft-github-release"),
		/always\(\).*needs\.stage-github-release\.result != 'skipped'.*needs\.publish-npm\.result != 'success'/,
	);
});

test("publish permissions, timeouts, runners, and OIDC are least privilege", async () => {
	const workflow = await readText(publishPath);
	assert.match(workflow.slice(0, workflow.indexOf("jobs:")), /permissions:\s*\n\s*contents: read/);
	const npm = jobBlock(workflow, "publish-npm", "publish-github-release");
	assert.match(npm, /environment: npm-publish/);
	assert.match(npm, /permissions:\s*\n\s*contents: read\s*\n\s*id-token: write/);
	assert.doesNotMatch(npm, /contents: write/);
	assert.match(npm, /npm publish .*--provenance.*--tag "\$NPM_TAG"/);
	assert.match(npm, /npm view .*@\$VERSION.*already exists; skipping/s);
	for (const writeJob of [
		jobBlock(workflow, "stage-github-release", "publish-npm"),
		jobBlock(workflow, "publish-github-release", "cleanup-draft-github-release"),
		jobBlock(workflow, "cleanup-draft-github-release"),
	]) {
		assert.match(writeJob, /contents: write/);
		assert.match(writeJob, /GH_REPO: \$\{\{ github\.repository \}\}/);
		assert.doesNotMatch(writeJob, /id-token: write|npm publish/);
	}
	assert.equal([...workflow.matchAll(/^ {4}timeout-minutes:/gmu)].length, 10);
	assert.match(workflow, /blacksmith-4vcpu-ubuntu-2404-arm/);
	assert.match(workflow, /macos-26-intel/);
	assert.match(workflow, /blacksmith-6vcpu-macos-26/);
	assert.match(workflow, /blacksmith-4vcpu-windows-2025/);
});

test("native release matrix pins all shipped targets and the Linux glibc floor", async () => {
	const workflow = await readText(publishPath);
	const native = jobBlock(workflow, "native-artifacts", "linux-binary-smoke");
	for (const target of [
		"x86_64-unknown-linux-gnu",
		"aarch64-unknown-linux-gnu",
		"x86_64-apple-darwin",
		"x86_64-unknown-linux-musl",
		"aarch64-unknown-linux-musl",
		"aarch64-apple-darwin",
		"x86_64-pc-windows-msvc",
		"aarch64-pc-windows-msvc",
	])
		assert.match(native, new RegExp(target));
	assert.match(workflow.slice(0, workflow.indexOf("jobs:")), /GLIBC_FLOOR: "2\.17"/);
	assert.match(
		native,
		/\[\[ "\$BARE_TARGET" != \*-unknown-linux-gnu \]\] \|\| build_target="\$\{BARE_TARGET\}\.\$\{GLIBC_FLOOR\}"/u,
	);
	assert.doesNotMatch(native, /linux-musl[^\n]*GLIBC_FLOOR/u);
	assert.match(native, /toolchain: 1\.97\.0/);
	assert.match(workflow.slice(0, workflow.indexOf("jobs:")), /RUSTUP_TOOLCHAIN: "1\.97\.0"/);
	assert.match(native, /NATIVE_TARGET: \$\{\{ matrix\.platform == 'darwin' && matrix\.target \|\| '' \}\}/);
	assert.match(native, /CROSS_TARGET: \$\{\{ matrix\.platform != 'darwin'/);
	assert.match(native, /cargo-zigbuild/);
	assert.match(native, /RUSTFLAGS=-C target-cpu=x86-64-v2/);
	assert.match(native, /fail-fast: false/);
	assert.match(native, /name: atomic-natives-\$\{\{ matrix\.slug \}\}/u);
	assert.match(native, /macos-26-intel/);
	assert.match(native, /blacksmith-6vcpu-macos-26/);
	assert.doesNotMatch(native, /run-id:|github-token:|artifact_lookup/iu);
	// The job may cache third-party toolchain acquisitions and nothing else.
	// Caching Cargo build output would make a provenance-signed artifact depend
	// on restored build state.
	assert.doesNotMatch(native, /rust-cache|sccache|CARGO_TARGET_DIR/iu);
	assert.deepEqual(
		[...native.matchAll(/^\s+path: (\S+)$/gmu)].map(([, value]) => value),
		["~/.cache/cargo-xwin", "packages/natives/native/*.node"],
	);
});

interface MuslSmokeProbe {
	archive: string;
	argsPath: string;
	bodyPath: string;
	postgresBodyPath: string;
	root: string;
}

function createMuslSmokeProbe(): MuslSmokeProbe {
	const probeRoot = makeTempDirectory("atomic-musl-contract-");
	const payloadRoot = join(probeRoot, "payload");
	const atomicRoot = join(payloadRoot, "atomic");
	for (const directory of [
		join(atomicRoot, "builtin", "workflows"),
		join(atomicRoot, "node_modules", "@bastani", "atomic-natives", "postgres-runtime", "bin"),
		join(atomicRoot, "lib"),
	]) {
		makeDirectorySync(directory, { recursive: true });
	}
	for (const file of [
		join(atomicRoot, "atomic"),
		join(atomicRoot, "app.js"),
		join(atomicRoot, "package.json"),
		join(atomicRoot, "builtin", "workflows", "package.json"),
		join(atomicRoot, "node_modules", "@bastani", "atomic-natives", "package.json"),
		join(atomicRoot, "node_modules", "@bastani", "atomic-natives", "postgres-runtime", "bin", "initdb"),
		join(atomicRoot, "node_modules", "@bastani", "atomic-natives", "postgres-runtime", "bin", "pg_ctl"),
		join(atomicRoot, "node_modules", "@bastani", "atomic-natives", "postgres-runtime", "POSTGRESQL-LICENSE"),
		join(atomicRoot, "node_modules", "@bastani", "atomic-natives", "postgres-runtime", "ZONKY-APACHE-2.0-LICENSE"),
		join(atomicRoot, "node_modules", "@bastani", "atomic-natives", "postgres-runtime", "runtime-provenance.json"),
		join(atomicRoot, "lib", "libgcc_s.so.1"),
		join(atomicRoot, "lib", "libstdc++.so.6"),
	]) {
		writeTextSync(file, "fixture");
	}

	const archive = join(probeRoot, "archive.tar.gz");
	const archiveResult = spawnSyncCollect(["tar", "-czf", archive, "-C", payloadRoot, "atomic"]);
	assert.equal(archiveResult.exitCode, 0, archiveResult.stderr.toString());

	const stubDirectory = join(probeRoot, "stub");
	makeDirectorySync(stubDirectory, { recursive: true });
	const argsPath = join(probeRoot, "docker-args.txt");
	const bodyPath = join(probeRoot, "smoke-body.sh");
	const postgresBodyPath = join(probeRoot, "postgres-smoke-body.sh");
	const stubPath = join(stubDirectory, "docker");
	writeTextSync(
		stubPath,
		`#!/bin/sh
: "\${ATOMIC_MUSL_DOCKER_ARGS:?}"
: "\${ATOMIC_MUSL_DOCKER_BODY:?}"
: "\${ATOMIC_MUSL_POSTGRES_BODY:?}"
mount=
last=
for arg do
    last=$arg
    case "$arg" in
        *:/smoke:ro) mount=\${arg%:/smoke:ro} ;;
    esac
done
[ -n "$mount" ]
if [ "$last" = /smoke/smoke.sh ]; then
    printf '%s\n' "$@" > "$ATOMIC_MUSL_DOCKER_ARGS"
    cat "$mount/smoke.sh" > "$ATOMIC_MUSL_DOCKER_BODY"
else
    cat "$mount/postgres-smoke.sh" > "$ATOMIC_MUSL_POSTGRES_BODY"
fi
`,
	);
	chmodSync(stubPath, 0o755);
	return { archive, argsPath, bodyPath, postgresBodyPath, root: probeRoot };
}

function removeMuslSmokeProbe(probe: MuslSmokeProbe): void {
	removeTempDirectory(probe.root);
}

function matrixUsesOnlyBlacksmithLinuxRunners(runsOn: string, block: string): boolean {
	if (runsOn !== "$" + "{{ matrix.runner }}") return false;
	const inlineRunners = [...block.matchAll(/\brunner:\s*([^\s,}\n]+)/gu)]
		.map(([, runner]) => runner as string)
		.filter((runner) => runner !== "-");
	const listBody = /\brunner:\s*\n(?<entries>(?:[ \t]*-[ \t]*[^\n#]+(?:\n|$))+)/u.exec(block)?.groups?.entries;
	const listRunners =
		listBody === undefined
			? []
			: [...listBody.matchAll(/^[ \t]*-[ \t]*([^\s#]+)/gmu)].map(([, runner]) => runner as string);
	const runners = [...inlineRunners, ...listRunners];
	return runners.length > 0 && runners.every((runner) => /^blacksmith-\dvcpu-ubuntu(?:-|$)/u.test(runner));
}

test("musl smoke forwards a complete staged shell script through stub docker", () => {
	const probe = createMuslSmokeProbe();
	try {
		const result = spawnSyncCollect(
			[
				"bash",
				join(root, "scripts/test-musl-release-archive.sh"),
				relative(probe.root, probe.archive),
				"linux-x64-musl",
			],
			{
				cwd: probe.root,
				env: {
					...process.env,
					PATH: `${join(probe.root, "stub")}${delimiter}${process.env.PATH ?? ""}`,
					ATOMIC_MUSL_DOCKER_ARGS: probe.argsPath,
					ATOMIC_MUSL_DOCKER_BODY: probe.bodyPath,
					ATOMIC_MUSL_POSTGRES_BODY: probe.postgresBodyPath,
				},
			},
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const args = readTextSync(probe.argsPath).toString("utf8").trimEnd().split("\n");
		assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--platform", "linux/amd64"]);
		assert.equal(args.at(-2), "/bin/sh");
		assert.equal(args.at(-1), "/smoke/smoke.sh");
		const smoke = readTextSync(probe.bodyPath).toString("utf8");
		assert.match(smoke, /output=\$\(printf '' \| "\$atomic" --no-session 2>&1\)/u);
		assert.match(smoke, /if echo "\$output" \| grep -q 'Failed to load extension'; then exit 1; fi/u);
		assert.match(smoke, /No models available\|No model selected\|No API key found/u);
		const postgresSmoke = readTextSync(probe.postgresBodyPath).toString("utf8");
		assert.match(postgresSmoke, /bin\/initdb/u);
		assert.match(postgresSmoke, /bin\/pg_ctl/u);
		assert.match(postgresSmoke, /nc -w 3 127\.0\.0\.1 55439/u);
		assert.match(postgresSmoke, /embedded PostgreSQL initdb\/start\/connect\/shutdown succeeded/u);
	} finally {
		removeMuslSmokeProbe(probe);
	}
});

test("Alpine smoke covers both musl archives on stock Alpine without runtime package installation", async () => {
	const [workflow, smoke] = await Promise.all([
		readText(publishPath),
		readText(join(root, "scripts/test-musl-release-archive.sh")),
	]);
	const alpine = jobBlock(workflow, "alpine-binary-smoke", "build");
	assert.match(alpine, /needs: \[integrity, native-artifacts\]/u);
	assert.match(alpine, /atomic-natives-\$\{\{ matrix\.slug \}\}/u);
	assert.match(alpine, /linux-x64-musl[\s\S]*linux-arm64-musl/u);
	assert.match(alpine, /blacksmith-4vcpu-ubuntu-2404[\s\S]*blacksmith-4vcpu-ubuntu-2404-arm/u);
	assert.match(alpine, /test-musl-release-archive\.sh/u);
	assert.doesNotMatch(alpine, /apk add/u);
	assert.match(smoke, /alpine:3\.22/u);
	assert.match(smoke, /docker run --rm --platform/u);
	assert.match(smoke, /atomic --version|"\$atomic" --version/u);
	assert.match(smoke, /<<'SMOKE'/u);
	assert.match(smoke, /\/bin\/sh \/smoke\/smoke\.sh/u);
	assert.match(smoke, /app\.js[\s\S]*builtin[\s\S]*node_modules/u);
	assert.doesNotMatch(smoke, /apk add/u);
	const nativeLoad = namedStep(jobSteps(alpine), "Load the musl native binding under musl libc");
	assert.match(nativeLoad, /^name: Load the musl native binding under musl libc$/mu);
	assert.match(nativeLoad, /node:22-alpine/u);
	assert.match(nativeLoad, /require\("\/smoke\/atomic\/node_modules\/@bastani\/atomic-natives"\)/u);
	assert.match(nativeLoad, /\["glob", "grep"\]/u);
	assert.match(nativeLoad, /typeof binding\[name\] !== "function"/u);
});

test("release packaging stages PostgreSQL in all eight native leaves and validates packed payloads", async () => {
	const workflow = await readText(publishPath);
	const build = jobBlock(workflow, "build", "stage-github-release");
	for (const command of [
		"linux-x64 packages/natives/npm/linux-x64-gnu",
		"linux-arm64 packages/natives/npm/linux-arm64-gnu",
		"darwin-x64 packages/natives/npm/darwin-x64",
		"darwin-arm64 packages/natives/npm/darwin-arm64",
		"windows-x64 packages/natives/npm/win32-x64-msvc",
		"linux-x64-musl packages/natives/npm/linux-x64-musl",
		"linux-arm64-musl packages/natives/npm/linux-arm64-musl",
		"windows-arm64 packages/natives/npm/win32-arm64-msvc",
	]) {
		assert.match(build, new RegExp(`node scripts/stage-postgres-runtime\\.mjs ${command}`, "u"));
	}
	assert.match(build, /@bastani\/atomic-natives-\*/u);
	assert.match(build, /package\/postgres-runtime\/POSTGRESQL-LICENSE/u);
	assert.match(build, /stage-postgres-runtime\.mjs.*--validate/u);
});

test("musl archive build bundles pinned C++ runtimes and patches payload-local search paths", async () => {
	const buildScript = await readText(join(root, "scripts/build-binaries.sh"));
	assert.match(buildScript, /ALPINE_MUSL_RUNTIME_VERSION="14\.2\.0-r6"/u);
	assert.match(buildScript, /libgcc_s\.so\.1/u);
	assert.match(buildScript, /libstdc\+\+\.so\.6/u);
	assert.match(buildScript, /sha256sum -c/u);
	assert.match(buildScript, /patchelf --print-needed/u);
	assert.match(buildScript, /patchelf --set-rpath/u);
	assert.match(buildScript, /\$ORIGIN/u);
});

test("release build retains Atomic native, smoke, shrinkwrap, metadata, and asset contracts", async () => {
	const workflow = await readText(publishPath);
	assert.match(workflow, /"win32-arm64-msvc"/);
	assert.match(workflow, /atomic-windows-arm64\.zip/);
	assert.match(workflow, /npm run check:shrinkwrap/);
	assert.match(workflow, /Build Linux x64 archive[\s\S]*--platform linux-x64/);
	assert.match(workflow, /Build Windows x64 archive[\s\S]*--platform windows-x64/);
	// Bun 1.4.0 Windows bytecode launchers crash unless compiled on a Windows
	// host, so the Windows runner builds both shipped archives and the Linux
	// payload build must not compile Windows targets itself.
	assert.match(workflow, /Build Windows arm64 archive[\s\S]*--platform windows-arm64/);
	assert.match(workflow, /Build release archives\n\s+run: \.\/scripts\/build-binaries\.sh [^\n]*--skip-windows/);
	assert.match(workflow, /name: atomic-windows-archives/);
	assert.match(
		jobBlock(workflow, "build", "stage-github-release"),
		/Stage Windows-built release archives[\s\S]*name: atomic-windows-archives[\s\S]*path: packages\/coding-agent\/binaries/,
	);
	assert.match(workflow, /Failed to load extension/);
	assert.match(workflow, /native optionalDependencies must be the eight exact-version platform packages/u);
	assert.match(workflow, /test .* = 11/u);
	assert.match(workflow, /Build Linux musl archive[\s\S]*--platform "\$\{\{ matrix\.platform \}\}"/u);
	assert.match(workflow, /Install musl archive tooling[\s\S]*patchelf/u);
	assert.doesNotMatch(
		workflow,
		/Release-base-ref|Release-base-sha|RELEASE_BASE_REFS|deterministic release tree|create-event binding/iu,
	);
});

test("obsolete release workflow files and publisher-only verifiers are absent", () => {
	for (const path of [
		".github/workflows/publish" + "-tag-created.yml",
		".github/workflows/publish" + "-release.yml",
		"scripts/verify" + "-publish-context.ts",
		"scripts/verify" + "-release-integrity.ts",
	])
		assert.equal(existsSync(join(root, path)), false, path);
});

test("developer release setup documents only the direct publish workflow", async () => {
	const setup = await readText(join(root, "DEV_SETUP.md"));
	assert.match(setup, /tag push starts `\.github\/workflows\/publish\.yml` directly/u);
	assert.match(setup, /trusted publishers with workflow filename `publish\.yml` and environment `npm-publish`/u);
	for (const forbidden of [
		"publish" + "-tag-created.yml",
		"publish" + "-release.yml",
		"RELEASE" + "_BASE_REFS",
		"NPM" + "_TOKEN",
		"NODE" + "_AUTH_TOKEN",
	])
		assert.equal(setup.includes(forbidden), false, forbidden);
});
test("release-base metadata remains available to the versionless cut flow", () => {
	const sha = "0123456789abcdef0123456789abcdef01234567";
	assert.equal(canonicalReleaseBaseRef("main"), "refs/heads/main");
	assert.equal(validateCanonicalReleaseBaseRef("refs/heads/release/workstream-1"), "refs/heads/release/workstream-1");
	for (const newline of ["\n", "\r\n"]) {
		const message = `Release 1.2.3${newline}${newline}Release-base-ref: refs/heads/main${newline}Release-base-sha: ${sha}${newline}`;
		assert.deepEqual(parseReleaseBaseTrailers(message), { baseRef: "refs/heads/main", baseSha: sha });
	}
});

test("cut-release still creates the detached version-stamped tag", async () => {
	const script = await readText(join(root, "scripts/cut-release.ts"));
	assert.match(script, /canonicalReleaseBaseRef\(baseBranch\)/);
	assert.match(script, /Release-base-ref: \$\{baseRef\}\\nRelease-base-sha: \$\{baseSha\}/);
	// Fully-qualified on both sides. A bare `push origin ${version}` resolves
	// against every ref namespace, so a same-named branch would push heads and
	// tags in one command and start two publishers on one npm version.
	assert.match(script, /push origin \$\{`refs\/tags\/\$\{version\}:refs\/tags\/\$\{version\}`\}/u);
	assert.doesNotMatch(script, /push origin \$\{version\}/u);
	assert.doesNotMatch(script, /Bun\.sleep|setTimeout/);
});

/**
 * Run 30517879019 (`Publish 0.9.11-alpha.8`) spent 13m27s inside one stalled
 * Zig mirror, was cancelled by the blanket 15-minute job cap 8s after its
 * artifact upload had already succeeded, and the cancelled `needs` dependency
 * then skipped the payload build, the draft, npm, and the release. A job cap
 * cannot detect that; only a bound on the acquisition step itself can.
 */
test("native-artifacts bounds every dependency acquisition step", async () => {
	const native = jobBlock(await readText(publishPath), "native-artifacts", "linux-binary-smoke");
	const steps = jobSteps(native);
	const budget = (needle: string): number => {
		const matches = steps.filter((step) => step.includes(needle));
		assert.equal(matches.length, 1, `expected exactly one step containing: ${needle}`);
		const bound = /^\s*timeout-minutes: (\d+)$/mu.exec(matches[0] as string);
		assert.ok(bound, `unbounded acquisition step: ${needle}`);
		return Number(bound[1]);
	};
	assert.equal(budget("tool: cargo-zigbuild@"), 3);
	assert.equal(budget("tool: cargo-xwin@"), 3);
	assert.equal(budget("apt-get install"), 5);
	assert.equal(budget("cargo-xwin xwin cache xwin"), 8);

	// The rustup fetch that killed both 0.9.16-alpha.5 publish runs overran this
	// same 4-minute cap. The curl inside the action already retries, so a second
	// attempt on a fresh step clock is the only thing that helps — and it has to
	// stay bounded, or the retry reintroduces the stall the cap exists to stop.
	const rustSteps = steps.filter((step) => step.includes("uses: dtolnay/rust-toolchain@"));
	assert.equal(rustSteps.length, 2, "the Rust toolchain acquisition must keep exactly one bounded retry");
	const [rust, rustRetry] = rustSteps as [string, string];
	assert.match(
		rust,
		/id: rust\n\s+uses: dtolnay\/rust-toolchain@\w{40} # v1\n\s+continue-on-error: true\n\s+timeout-minutes: 4\n/u,
	);
	assert.match(
		rustRetry,
		/if: steps\.rust\.outcome == 'failure'\n\s+uses: dtolnay\/rust-toolchain@\w{40} # v1\n\s+timeout-minutes: 4\n/u,
	);

	const zigSteps = steps.filter((step) => step.includes("mlugg/setup-zig@"));
	assert.equal(zigSteps.length, 2, "the Zig acquisition must keep exactly one bounded retry");
	const [zig, retry] = zigSteps as [string, string];
	assert.match(
		zig,
		/id: zig\n\s+if: matrix\.platform == 'linux'\n\s+continue-on-error: true\n\s+timeout-minutes: 2\n/u,
	);
	assert.match(retry, /if: matrix\.platform == 'linux' && steps\.zig\.outcome == 'failure'\n\s+timeout-minutes: 2\n/u);
	for (const step of zigSteps) {
		// The tool cache is copied into an ephemeral VM, and the global Zig cache
		// has never been read back on a release tag. Disabling both also keeps a
		// killed attempt's post step inert so the retry adds no failure mode.
		assert.match(step, /use-tool-cache: false/u);
		assert.match(step, /use-cache: false/u);
	}

	for (const step of steps) {
		if (!/uses: (dtolnay|mlugg|taiki-e)\//u.test(step)) continue;
		assert.match(step, /timeout-minutes: \d+/u, `unbounded acquisition step:\n${step}`);
	}
});

/**
 * `useblacksmith/checkout` consumes a Blacksmith sticky disk. Sticky disks are
 * ext4 block devices, so they exist only on Blacksmith Linux runners; the
 * Windows leg warns and falls back, and the macOS ARM leg blocked 78s on a
 * gRPC connect timeout in 8 of 8 releases before falling back.
 */
test("sticky-disk checkout stays on Blacksmith Linux runners", async () => {
	for (const path of [publishPath, testPath, warmPath]) {
		const workflow = await readText(path);
		for (const [name, block] of jobBlocks(workflow)) {
			const runsOn = /^\s+runs-on: (.+)$/mu.exec(block)?.[1].trim() ?? "";
			for (const step of jobSteps(block)) {
				if (!step.includes("useblacksmith/")) continue;
				const guarded = /if: runner\.os == 'Linux'/u.test(step);
				const matrixLinuxRunner = matrixUsesOnlyBlacksmithLinuxRunners(runsOn, block);
				assert.ok(
					guarded || /^blacksmith-\dvcpu-ubuntu/u.test(runsOn) || matrixLinuxRunner,
					`${path}: job ${name} requests a sticky disk on ${runsOn || "a matrix runner"}`,
				);
			}
		}
	}
	assert.equal(
		matrixUsesOnlyBlacksmithLinuxRunners(
			"$" + "{{ matrix.runner }}",
			"strategy:\n  matrix:\n    include:\n      - { runner: blacksmith-4vcpu-ubuntu-2404 }\n      - { runner: blacksmith-4vcpu-ubuntu-2404-arm }",
		),
		true,
		"an all-Blacksmith inline matrix must satisfy the sticky-disk Linux runner contract",
	);
	assert.equal(
		matrixUsesOnlyBlacksmithLinuxRunners(
			"$" + "{{ matrix.runner }}",
			"strategy:\n  matrix:\n    runner:\n      - blacksmith-4vcpu-ubuntu-2404\n      - blacksmith-4vcpu-ubuntu-2404-arm",
		),
		true,
		"an all-Blacksmith list matrix must satisfy the sticky-disk Linux runner contract",
	);
	assert.equal(
		matrixUsesOnlyBlacksmithLinuxRunners(
			"$" + "{{ matrix.runner }}",
			"strategy:\n  matrix:\n    include:\n      - { runner: blacksmith-4vcpu-ubuntu-2404 }\n      - { runner: windows-latest }",
		),
		false,
		"a mixed matrix must not satisfy the sticky-disk Linux runner contract",
	);
	const publish = await readText(publishPath);
	const testWorkflow = await readText(testPath);
	assert.doesNotMatch(jobBlock(publish, "windows-binary-smoke", "alpine-binary-smoke"), /useblacksmith/u);
	// Every cross-platform job in test.yml now checks out for itself, so each one
	// must keep the Linux/non-Linux checkout pair.
	const crossPlatformJobs = ["unit-tests", "integration-tests", "agent-suite", "release-archive"] as const;
	const testJobs = new Map(jobBlocks(testWorkflow));
	for (const block of [
		jobBlock(publish, "native-artifacts", "linux-binary-smoke"),
		...crossPlatformJobs.map((job) => testJobs.get(job) as string),
	]) {
		assert.match(block, /uses: useblacksmith\/checkout@[0-9a-f]{40}[^\n]*\n\s+if: runner\.os == 'Linux'/u);
		assert.match(block, /uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+if: runner\.os != 'Linux'/u);
	}
	// The Linux-only static-checks job needs no guard, and the result gate checks
	// out nothing at all.
	assert.doesNotMatch(testJobs.get("test") as string, /checkout/u);
});

test("every third-party action is pinned to a full commit SHA with a version comment", async () => {
	for (const path of [publishPath, testPath, warmPath]) {
		const workflow = await readText(path);
		const uses = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gmu)];
		assert.ok(uses.length > 0, `${path} declares no actions`);
		for (const [, action, trailer] of uses) {
			assert.match(action as string, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u, `${path}: ${action} is not SHA-pinned`);
			assert.match(trailer as string, /^ # v?[\w.-]+$/u, `${path}: ${action} needs a version comment`);
		}
	}
});

test("the shipped build toolchain and Bun do not float", async () => {
	const publish = await readText(publishPath);
	const warm = await readText(warmPath);
	for (const workflow of [publish, warm]) {
		for (const [, tool] of workflow.matchAll(/^\s+tool: (\S+)$/gmu)) {
			assert.match(tool as string, /^cargo-(zigbuild|xwin)@\d+\.\d+\.\d+$/u, `floating build tool: ${tool}`);
		}
	}
	const bunVersions = new Set(
		[...`${publish}\n${await readText(testPath)}`.matchAll(/bun-version: (\S+)/gu)].map(
			([, value]) => value as string,
		),
	);
	assert.deepEqual([...bunVersions], ["1.4.0"], "test.yml and publish.yml must exercise one pinned Bun");
});

test("each native leg declares its own measured job and compile budget", async () => {
	const native = jobBlock(await readText(publishPath), "native-artifacts", "linux-binary-smoke");
	assert.match(native, /^ {4}timeout-minutes: \$\{\{ matrix\.timeout_minutes \}\}$/mu);
	assert.match(
		native,
		/- name: Build native binding\n\s+id: native_build\n\s+continue-on-error: true\n\s+timeout-minutes: \$\{\{ matrix\.build_timeout_minutes \}\}/u,
	);
	assert.match(
		native,
		/- name: Retry native binding\n\s+if: steps\.native_build\.outcome == 'failure'\n\s+timeout-minutes: \$\{\{ matrix\.build_timeout_minutes \}\}/u,
	);
	const buildSteps = jobSteps(native).filter((step) => /(?:Build|Retry) native binding/u.test(step));
	assert.deepEqual(
		buildSteps.map((step) => /^name: .+$/mu.exec(step)?.[0]),
		["name: Build native binding", "name: Retry native binding"],
	);
	assert.equal(
		[...native.matchAll(/timeout-minutes: \$\{\{ matrix\.build_timeout_minutes \}\}/gu)].length,
		2,
		"both native compile attempts need their own bounded timeout",
	);
	assert.match(buildSteps[0] as string, /continue-on-error: true/u);
	assert.doesNotMatch(buildSteps[1] as string, /continue-on-error/u);
	const legMatches = [
		...native.matchAll(/platform: (\w+), arch: (\w+),[^}]*timeout_minutes: (\d+), build_timeout_minutes: (\d+)/gu),
	];
	const legs = legMatches.map(([, platform, arch, job, build]) => `${platform} ${arch} ${job}/${build}`);
	assert.deepEqual(legs, [
		"linux x64 16/5",
		"linux arm64 17/5",
		"linux x64 17/5",
		"linux arm64 18/5",
		"darwin x64 19/8",
		"darwin arm64 12/5",
		"win32 x64 20/5",
		"win32 arm64 20/5",
	]);
	// A cap sized on a green run's setup cancels the job mid-retry, which is the
	// failure the retry exists to survive. Every leg must still contain the bounded
	// recovery paths it owns: both zig attempts (linux), the CRT populate bound
	// (win32), two compile attempts, and the artifact upload.
	const RESERVED_BOUND_MINUTES: Record<string, number> = { linux: 2 + 2, win32: 8, darwin: 0 };
	const UPLOAD_RESERVE_MINUTES = 1;
	for (const [, platform, arch, job, build] of legMatches) {
		const floor = (RESERVED_BOUND_MINUTES[platform as string] ?? 0) + 2 * Number(build) + UPLOAD_RESERVE_MINUTES;
		assert.ok(
			Number(job) >= floor,
			`${platform} ${arch} job cap ${job} cannot contain its bounded recovery path (needs >= ${floor})`,
		);
	}
	// No leg may fall back to the former blanket cap.
	assert.doesNotMatch(native, /timeout-minutes: 15/u);
});

test("the toolchain warm workflow stays read-only, gated, and key-compatible", async () => {
	const warm = await readText(warmPath);
	const publish = await readText(publishPath);
	assert.match(warm, /permissions:\s*\n\s*contents: read/u);
	assert.doesNotMatch(warm, /contents: write|id-token: write|npm publish|gh release|upload-artifact/u);
	// Gated: whether a refs/tags/* run reads a refs/heads/main cache entry on
	// Blacksmith's colocated cache is documented but unverified here, so the
	// daily schedule lands only after the docs/ci.md experiment observes a hit.
	assert.match(warm, /^on:\n {2}workflow_dispatch:\n/mu);
	assert.doesNotMatch(warm, /\n\s+schedule:/u);
	const key = /key: (xwin-v\d+-\$\{\{ matrix\.arch \}\}-\d+)/u;
	assert.equal(key.exec(warm)?.[1], key.exec(publish)?.[1], "warm and release CRT cache keys must match");
	const zigVersion = /uses: mlugg\/setup-zig@[^\n]*\n\s+with:\n\s+version: (\S+)/u;
	assert.equal(zigVersion.exec(warm)?.[1], zigVersion.exec(publish)?.[1], "warm and release Zig versions must match");
	assert.match(await readText(join(root, "docs/ci.md")), /xwin-v1/u);
});

type MatrixEntry = Record<string, string | number | boolean>;

interface WorkflowMatrix {
	include?: MatrixEntry[];
	[key: string]: string[] | MatrixEntry[] | undefined;
}

interface WorkflowJob {
	"runs-on"?: string | string[];
	"timeout-minutes"?: number | string;
	strategy?: { matrix?: WorkflowMatrix };
	steps?: { run?: string }[];
}

interface Workflow {
	jobs?: Record<string, WorkflowJob>;
}

/**
 * Every runner a job can select.
 *
 * `runs-on: ${{ matrix.<key> }}` is resolved through the job's own matrix. Reading
 * the literal alone would let `matrix: { os: [ubuntu-24.04] }` pick an unapproved
 * GitHub-hosted runner that no contract here ever sees.
 */
function jobRunners(label: string, job: NonNullable<Workflow["jobs"]>[string]): string[] {
	const runsOn = job["runs-on"] ?? [];
	return (typeof runsOn === "string" ? [runsOn] : runsOn).flatMap((value) => {
		const key = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/u.exec(value)?.[1];
		if (key === undefined) {
			// An expression this cannot resolve must not pass as a literal runner name.
			assert.doesNotMatch(value, /\$\{\{/u, `${label}: unresolvable runs-on ${value}`);
			return [value];
		}
		const matrix = job.strategy?.matrix ?? {};
		const values = [...(matrix[key] ?? []), ...(matrix.include ?? []).map((entry) => entry[key])].filter(
			(entry): entry is string => typeof entry === "string",
		);
		assert.ok(values.length > 0, `${label}: matrix.${key} names no runner`);
		return values;
	});
}

test("Blacksmith runners are used everywhere they are supported", async () => {
	const publish = await readText(publishPath);
	// Enumerate the directory rather than a fixed list: a workflow added later
	// must not be able to introduce an unapproved GitHub-hosted runner unnoticed.
	const workflowDir = join(root, ".github/workflows");
	const workflowFiles = (await readdir(workflowDir))
		.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
		.sort();
	assert.ok(workflowFiles.length >= 3, "expected the workflows directory to be enumerable");
	const hosted: string[] = [];
	for (const file of workflowFiles) {
		const workflow = parseYaml(await readText(join(workflowDir, file))) as Workflow;
		for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
			hosted.push(...jobRunners(`${file} ${name}`, job).filter((runner) => !runner.startsWith("blacksmith-")));
		}
	}
	// Only two jobs may stay GitHub-hosted, and each for a reason that a future
	// "move everything to Blacksmith" pass must not quietly undo:
	//   macos-26-intel - Blacksmith macOS is Apple Silicon only, so this is the
	//     only runner that can produce the darwin x64 native binding.
	//   ubuntu-latest  - npm trusted publishing rejects self-hosted runners, and
	//     Blacksmith registers through GitHub's org-level registration API.
	assert.deepEqual(hosted.sort(), ["macos-26-intel", "ubuntu-latest"]);
	assert.match(publish, /# Blacksmith macOS is Apple Silicon only[^\n]*\n\s+- \{ runner: macos-26-intel/u);
	assert.match(publish, /npm trusted publishing rejects self-hosted runners[\s\S]{0,160}?runs-on: ubuntu-latest/u);
	// ubuntu-latest is only ever acceptable on the OIDC publish job.
	assert.equal(jobBlock(publish, "publish-npm", "publish-github-release").includes("runs-on: ubuntu-latest"), true);
});

/**
 * Nothing local gates a push any more, so CI has to run every suite.
 *
 * The hooks used to run test:unit, test:integration and test:ci-contracts at
 * `pre-push`, which cost ~110 s on every push. Scoping that to the changed
 * surface was measured and rejected: `vitest related` took 42 s cold, 21 s warm
 * and 95 s on a third attempt to run *zero* tests on this repository. The cost is
 * vite transform and setup across three projects, not test execution, so a
 * targeted hook cannot be made cheap. `node_modules/.vite` caching helps but
 * cannot reach a floor worth paying per push.
 *
 * Two bugs — a Windows-only line-ending bug in a changelog check, and an
 * integration fixture broken by a change in the same branch — once reached CI
 * because the hooks stopped at test:unit. With no push gate at all, CI is now the
 * only thing between that class of bug and main, so this asserts the suites are
 * actually wired into the workflow rather than merely declared in package.json.
 */
test("CI runs every test suite, because no hook gates a push", async () => {
	const prek = await readText(join(root, "prek.toml"));
	assert.doesNotMatch(
		prek,
		/pre-push/u,
		"prek.toml reinstates a push gate; `vitest related` was measured too slow to make one worth paying for",
	);

	const manifest = await readJson<{ scripts: Record<string, string> }>(join(root, "package.json"));
	const workflow = await readText(testPath);
	for (const script of ["test:unit", "test:integration", "test:ci-contracts"]) {
		assert.ok(manifest.scripts[script], `missing script: ${script}`);
		assert.match(
			workflow,
			new RegExp(String.raw`npm run ${script}`, "u"),
			`.github/workflows/test.yml never runs \`npm run ${script}\`; with no push gate, a suite CI skips is a suite nothing runs`,
		);
	}
});

test("existing hardware jobs execute PostgreSQL SQL persistence gates without changing the platform matrix", async () => {
	const workflow = await readText(publishPath);
	for (const job of ["native-artifacts", "linux-binary-smoke", "windows-binary-smoke"]) {
		assert.match(jobBlock(workflow, job), /smoke-postgres-runtime\.mjs/u);
	}
	const alpine = await readText(join(root, "scripts/test-musl-release-archive.sh"));
	assert.match(alpine, /initdb.*-U postgres/u);
	assert.match(alpine, /CREATE TABLE atomic_durability_probe/u);
	assert.match(alpine, /INSERT INTO atomic_durability_probe/u);
	assert.match(alpine, /SELECT value FROM atomic_durability_probe/u);
	assert.match(alpine, /persisted-row/u);
});
