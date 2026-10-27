import assert from "node:assert/strict";
import { delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	canonicalReleaseBaseRef,
	parseReleaseBaseTrailers,
	validateCanonicalReleaseBaseRef,
} from "../../scripts/release-base.js";
import {
	chmodSync,
	fileExistsSync,
	makeDirectorySync,
	makeTempDirectory,
	readDirectorySync,
	readJson,
	readTextSync,
	removeTempDirectory,
	spawnSyncCollect,
	writeTextSync,
} from "../helpers/runtime.js";
import { readText } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
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
	assert.equal(projects.length, 4, "one vitest project per suite directory, plus the integration load gate");

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
});

test("workflows workspace test scripts delegate to the root Vitest suites", async () => {
	const manifest = await readJson<{ scripts: Record<string, string> }>(join(root, "packages/workflows/package.json"));
	// npm test visits workspace test scripts after running the root suites.
	// Delegate to the same root entry points as CI, never back to root `test`.
	for (const [entry, target] of Object.entries({
		test: "test:unit",
		"test:unit": "test:unit",
		"test:integration": "test:integration",
		"test:all": "test:all",
	})) {
		assert.equal(manifest.scripts[entry], `npm --prefix ../.. run ${target} --`, `${entry} bypasses root test setup`);
	}
});

test("npm registry retries declare integer timeouts and ordered backoffs", async () => {
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
	integerConfig("fetch-timeout");
	const fetchRetries = integerConfig("fetch-retries");
	const retryMinTimeoutMs = integerConfig("fetch-retry-mintimeout");
	const retryMaxTimeoutMs = integerConfig("fetch-retry-maxtimeout");
	assert.ok(fetchRetries >= 1, "a transient registry stall must receive at least one retry");
	assert.ok(retryMinTimeoutMs > 0, "registry retries need a positive backoff");
	assert.ok(retryMinTimeoutMs <= retryMaxTimeoutMs, "minimum retry backoff must not exceed its maximum");
});

test("global setups isolate Herdr and provider credentials, then prepare artifacts and natives", async () => {
	const config = (await import("../../vitest.config.js")) as {
		default: {
			test?: {
				projects?: { test?: { name?: string; globalSetup?: string[] } }[];
			};
		};
	};
	const projects = config.default.test?.projects ?? [];
	const herdrSetup = "./test/global-setup-herdr-isolation.ts";
	const providerCredentialSetup = "./test/global-setup-provider-credential-isolation.ts";
	const artifactSetup = "./test/global-setup-workflow-artifacts.ts";
	const nativeSetup = "./test/global-setup-natives.ts";
	for (const name of ["unit", "integration", "ci"]) {
		const project = projects.find((entry) => entry.test?.name === name);
		assert.ok(project, `missing vitest project: ${name}`);
		assert.deepEqual(
			project.test?.globalSetup,
			[herdrSetup, providerCredentialSetup, artifactSetup, nativeSetup],
			`${name} must isolate inherited Herdr and provider credentials before preparing artifacts and natives`,
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
		...readDirectorySync(join(root, "packages")).map((p) => `packages/${p}/package.json`),
	];
	for (const relative of manifests) {
		const path = join(root, relative);
		if (!fileExistsSync(path)) continue;
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
		"npm --workspace=@bastani/pi-ai run build && npm --workspace=@bastani/pi-ai run typecheck && node scripts/alias-pi-ai.mjs && node scripts/bun-typecheck.mjs && npm --workspace=@bastani/atomic run typecheck",
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
 * `node:sqlite`, which Node >= 22.13 and Bun >= 1.4.2 (this repository's
 * floor) both ship — the `bun:sqlite` fallback was deleted at the earlier
 * 1.4.0 floor and must not come back — and no test may reintroduce a soft
 * guard that turns an unavailable module into a green no-op.
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
	for (const entry of readDirectorySync(testDir, { recursive: true, encoding: "utf8" })) {
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
});

test("binary staging verifies the exact builtin directory set", async () => {
	const buildScript = await readText(join(root, "scripts/build-binaries.sh"));

	assert.match(buildScript, /assert-builtin-set\.ts "binaries\/\$platform\/builtin"/u);
});

interface MuslSmokeProbe {
	archive: string;
	argsPath: string;
	bodyPath: string;
	root: string;
}

function createMuslSmokeProbe(): MuslSmokeProbe {
	const probeRoot = makeTempDirectory("atomic-musl-contract-");
	const payloadRoot = join(probeRoot, "payload");
	const atomicRoot = join(payloadRoot, "atomic");
	for (const directory of [
		join(atomicRoot, "builtin", "workflows"),
		join(atomicRoot, "node_modules", "@bastani", "atomic-natives"),
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
		join(atomicRoot, "lib", "libgcc_s.so.1"),
		join(atomicRoot, "lib", "libstdc++.so.6"),
	]) {
		writeTextSync(file, "fixture");
	}

	const archive = join(probeRoot, "archive.tar.gz");
	// GNU tar reads drive-qualified archive names as host:path; keep -f relative.
	const archiveResult = spawnSyncCollect(["tar", "-czf", "archive.tar.gz", "-C", payloadRoot, "atomic"], {
		cwd: probeRoot,
	});
	assert.equal(archiveResult.exitCode, 0, archiveResult.stderr.toString());

	const stubDirectory = join(probeRoot, "stub");
	makeDirectorySync(stubDirectory, { recursive: true });
	const argsPath = join(probeRoot, "docker-args.txt");
	const bodyPath = join(probeRoot, "smoke-body.sh");
	const stubPath = join(stubDirectory, "docker");
	writeTextSync(
		stubPath,
		`#!/bin/sh
: "\${ATOMIC_MUSL_DOCKER_ARGS:?}"
: "\${ATOMIC_MUSL_DOCKER_BODY:?}"
mount=
last=
for arg do
    last=$arg
    case "$arg" in
        *:/smoke:ro) mount=\${arg%:/smoke:ro} ;;
    esac
done
[ -n "$mount" ]
printf '%s\n' "$@" > "$ATOMIC_MUSL_DOCKER_ARGS"
cat "$mount/smoke.sh" > "$ATOMIC_MUSL_DOCKER_BODY"
`,
	);
	chmodSync(stubPath, 0o755);
	return { archive, argsPath, bodyPath, root: probeRoot };
}

function removeMuslSmokeProbe(probe: MuslSmokeProbe): void {
	removeTempDirectory(probe.root);
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
	} finally {
		removeMuslSmokeProbe(probe);
	}
});

test("musl smoke uses stock Alpine without runtime package installation", async () => {
	const smoke = await readText(join(root, "scripts/test-musl-release-archive.sh"));
	assert.match(smoke, /alpine:3\.22/u);
	assert.match(smoke, /docker run --rm --platform/u);
	assert.match(smoke, /atomic --version|"\$atomic" --version/u);
	assert.match(smoke, /<<'SMOKE'/u);
	assert.match(smoke, /\/bin\/sh \/smoke\/smoke\.sh/u);
	assert.match(smoke, /app\.js[\s\S]*builtin[\s\S]*node_modules/u);
	assert.doesNotMatch(smoke, /apk add/u);
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

test("obsolete publisher-only verifiers are absent", () => {
	for (const path of ["scripts/verify" + "-publish-context.ts", "scripts/verify" + "-release-integrity.ts"])
		assert.equal(fileExistsSync(join(root, path)), false, path);
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

test("suite entry points remain available without a pre-push hook", async () => {
	const prek = await readText(join(root, "prek.toml"));
	assert.doesNotMatch(
		prek,
		/pre-push/u,
		"prek.toml reinstates a push gate; `vitest related` was measured too slow to make one worth paying for",
	);

	const manifest = await readJson<{ scripts: Record<string, string> }>(join(root, "package.json"));
	for (const script of ["test:unit", "test:integration", "test:ci-contracts"]) {
		assert.ok(manifest.scripts[script], `missing script: ${script}`);
	}
});
