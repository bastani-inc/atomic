import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { DIRECTORY_AS_FILE_ERRNO } from "../../../test/helpers/worktree-snapshot.js";
import { shellCommandPrefixFor } from "../src/core/agent-session-blueprint-environment.ts";
import { bashPath, sessionEnvironmentPrefix, sessionEnvrcPath } from "../src/core/resume/blueprint/envrc.ts";
import {
	type BlueprintLedger,
	blueprintDigest,
	readLedger,
	rootKey,
	updateLedger,
	workspaceKey,
} from "../src/core/resume/blueprint/ledger.ts";
import {
	type ActionFetcher,
	BLUEPRINT_FULL_BUILD_MAX_AGE_MS,
	type BlueprintBuildConfig,
	type BlueprintBuildOutcome,
	type BlueprintLayer,
	type BlueprintRepository,
	blueprintNotices,
	describeBlueprints,
	hostPlatform,
	isBlueprintBuildFailedError,
	isBlueprintInvalidError,
	isBlueprintStepFailedError,
	isBlueprintStepTimedOutError,
	needsRebuild,
	renderBlueprintContext,
	runBlueprintBuild,
	SETUP_COMMAND_ALIAS,
} from "../src/core/resume/index.ts";

let sandbox: string;
let clock: number;

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "blueprint-build-")));
	clock = Date.parse("2026-11-09T00:00:00Z");
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

const path = (...segments: string[]) => join(sandbox, ...segments);

function write(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function repository(name: string, files: Record<string, string> = {}): BlueprintRepository {
	const root = path("repos", name);
	mkdirSync(root, { recursive: true });
	for (const [relative, content] of Object.entries(files)) write(join(root, relative), content);
	return { root, identity: `https://example.test/${name}.git` };
}

function blueprint(root: string, content: string, directory = ""): void {
	write(join(root, directory, ".atomic", "blueprint.yaml"), content);
}

const markers = () => path("markers.txt");

function config(overrides: Partial<BlueprintBuildConfig> = {}): BlueprintBuildConfig {
	mkdirSync(path("home"), { recursive: true });
	return {
		agentDir: path("agent"),
		storeDir: path("store"),
		trusted: () => true,
		platform: "linux",
		homeDir: path("home"),
		now: () => clock,
		environment: { PATH: process.env.PATH ?? "", HOME: path("home"), MARKERS: markers() },
		...overrides,
	};
}

function ran(): string[] {
	return existsSync(markers()) ? readFileSync(markers(), "utf8").trim().split("\n").filter(Boolean) : [];
}

const mark = (label: string) => `echo "${label} $(pwd -P)" >> "$MARKERS"`;

function failureStep(outcome: BlueprintBuildOutcome) {
	const [failure] = outcome.failures;
	assert.ok(failure !== undefined, "expected a failure");
	return failure;
}

describe("blueprint build: order and working directories (#4588)", () => {
	test("runs global initialize and maintenance, then each repository's initialize and maintenance, then global post-build (#4588)", async () => {
		const first = repository("first");
		const second = repository("second");
		write(
			path("agent", "blueprint.yaml"),
			`initialize: ${mark("global-initialize")}\nmaintenance: ${mark("global-maintenance")}\npost-build: ${mark("post-build")}\n`,
		);
		blueprint(first.root, `initialize: ${mark("first-initialize")}\nmaintenance: ${mark("first-maintenance")}\n`);
		blueprint(second.root, `initialize: ${mark("second-initialize")}\nmaintenance: ${mark("second-maintenance")}\n`);
		const outcome = await runBlueprintBuild([first, second], config());
		assert.equal(outcome.status, "success");
		assert.equal(outcome.kind, "full");
		assert.deepEqual(
			ran().map((line) => line.split(" ")[0]),
			[
				"global-initialize",
				"global-maintenance",
				"first-initialize",
				"first-maintenance",
				"second-initialize",
				"second-maintenance",
				"post-build",
			],
		);
	});

	test("the root blueprint runs before its workspaces, and each runs in its own directory (#4588)", async () => {
		const repo = repository("mono", { "services/api/.keep": "", "web/.keep": "" });
		write(path("agent", "blueprint.yaml"), `maintenance: ${mark("global")}\npost-build: ${mark("post")}\n`);
		blueprint(
			repo.root,
			`includes:\n  - services/api\n  - web\ninitialize: ${mark("root-init")}\nmaintenance: ${mark("root-maint")}\n`,
		);
		blueprint(repo.root, `initialize: ${mark("api-init")}\nmaintenance: ${mark("api-maint")}\n`, "services/api");
		blueprint(repo.root, `maintenance: ${mark("web-maint")}\n`, "web");
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "success");
		assert.deepEqual(ran(), [
			`global ${path("home")}`,
			`root-init ${repo.root}`,
			`root-maint ${repo.root}`,
			`api-init ${join(repo.root, "services", "api")}`,
			`api-maint ${join(repo.root, "services", "api")}`,
			`web-maint ${join(repo.root, "web")}`,
			`post ${path("home")}`,
		]);
		assert.deepEqual(
			outcome.layers.map((layer) => [layer.scope, layer.directory]),
			[
				["global", null],
				["repository", "."],
				["workspace", "services/api"],
				["workspace", "web"],
			],
		);
	});

	test("a missing included file removes that workspace and builds the rest (#4588)", async () => {
		const repo = repository("mono", { "api/.keep": "" });
		blueprint(repo.root, `includes: [api]\nmaintenance: ${mark("root")}\n`);
		const first = await runBlueprintBuild([repo], config());
		assert.equal(first.status, "success");
		assert.deepEqual(first.removed, []);
		assert.deepEqual(ran(), [`root ${repo.root}`]);
	});

	test("a full-path include of a .devin or otherwise named blueprint file runs none of its steps (#4588)", async () => {
		const repo = repository("devin-path");
		write(join(repo.root, "pkg", ".devin", "blueprint.yaml"), `maintenance: ${mark("devin")}\n`);
		write(join(repo.root, "other", "blueprint.yaml"), `maintenance: ${mark("other")}\n`);
		blueprint(
			repo.root,
			`includes: [pkg/.devin/blueprint.yaml, other/blueprint.yaml]\nmaintenance: ${mark("root")}\n`,
		);
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "success");
		assert.deepEqual(ran(), [`root ${repo.root}`]);
		assert.deepEqual(blueprintNotices(outcome, false), []);
	});

	test("an included directory that does not exist removes that workspace silently and builds the rest (#4588)", async () => {
		const repo = repository("mono");
		blueprint(repo.root, `includes: [missing]\nmaintenance: ${mark("root")}\n`);
		const first = await runBlueprintBuild([repo], config());
		assert.equal(first.status, "success");
		assert.deepEqual(first.failures, []);
		assert.deepEqual(
			first.layers.map((layer) => layer.directory),
			["."],
		);
		assert.deepEqual(blueprintNotices(first, false), []);
		assert.deepEqual(ran(), [`root ${repo.root}`]);
		const second = await runBlueprintBuild([repo], config());
		assert.equal(second.status, "success");
		assert.equal((await readLedger(path("store"))).roots[rootKey(repo.root)]?.state, "success");
	});

	test("an included workspace may be created by the root blueprint's initialize (#4588)", async () => {
		const repo = repository("mono");
		blueprint(
			repo.root,
			`includes: [generated]\ninitialize: |\n  mkdir -p generated/.atomic\n  printf 'maintenance: echo generated >> "$MARKERS"\\n' > generated/.atomic/blueprint.yaml\n`,
		);
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "success");
		assert.deepEqual(ran(), ["generated"]);
	});

	test("no blueprint anywhere builds nothing and reports status none (#4588)", async () => {
		const repo = repository("plain");
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "none");
		assert.equal(outcome.kind, undefined);
		assert.deepEqual(outcome.layers, []);
		assert.deepEqual(outcome.failures, []);
		assert.equal(existsSync(path("store")), false);
	});

	test("a document for another platform runs nothing and is not surfaced (#4588)", async () => {
		const repo = repository("other");
		blueprint(
			repo.root,
			`runs-on: macos\nmaintenance: ${mark("mac")}\nknowledge:\n  - name: lint\n    contents: mac lint\n`,
		);
		const outcome = await runBlueprintBuild([repo], config({ platform: "linux" }));
		assert.deepEqual(ran(), []);
		assert.equal(outcome.status, "success");
		assert.ok(outcome.layers.every((layer) => layer.document === undefined));
	});

	test("the document that targets this platform is the one that runs (#4588)", async () => {
		const repo = repository("multi");
		blueprint(repo.root, `maintenance: ${mark("linux")}\n---\nruns-on: macos\nmaintenance: ${mark("mac")}\n`);
		await runBlueprintBuild([repo], config({ platform: "macos" }));
		assert.deepEqual(ran(), [`mac ${repo.root}`]);
	});
});

describe("blueprint build: environment and $ENVRC (#4588)", () => {
	test("variables a step writes to $ENVRC reach later steps, step env does not leak and wins over $ENVRC (#4588)", async () => {
		const repo = repository("env");
		blueprint(
			repo.root,
			[
				"initialize:",
				"  - run: |",
				'      echo "SHARED=from-envrc" >> "$ENVRC"',
				'      echo "export PATH=\\"$PWD/tools:\\$PATH\\"" >> "$ENVRC"',
				'  - run: \'echo "1 $SHARED $ONLY_STEP" >> "$MARKERS"\'',
				"    env:",
				"      ONLY_STEP: scoped",
				'  - run: \'echo "2 $SHARED $ONLY_STEP" >> "$MARKERS"\'',
				'  - run: \'echo "3 $SHARED" >> "$MARKERS"\'',
				"    env:",
				"      SHARED: step-wins",
				"maintenance:",
				'  - run: \'echo "4 $SHARED $(echo "$PATH" | cut -d: -f1)" >> "$MARKERS"\'',
				"",
			].join("\n"),
		);
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "success");
		assert.deepEqual(ran(), [
			"1 from-envrc scoped",
			"2 from-envrc ",
			"3 step-wins",
			`4 from-envrc ${repo.root}/tools`,
		]);
	});

	test("$ENVRC reaches the session through the restored worktree's environment prefix (#4588)", async () => {
		const repo = repository("session");
		blueprint(
			repo.root,
			`initialize: |\n  echo "API_URL=http://localhost:9" >> "$ENVRC"\n  echo "export EXTRA='two words'" >> "$ENVRC"\n`,
		);
		await runBlueprintBuild([repo], config());
		const prefix = sessionEnvironmentPrefix(path("store"), [repo.root]);
		assert.ok(prefix !== undefined);
		const shown = spawnSync("bash", ["-c", `${prefix}\nenv | grep -E '^(API_URL|EXTRA)=' | sort`], {
			encoding: "utf8",
		});
		assert.equal(shown.stdout, "API_URL=http://localhost:9\nEXTRA=two words\n");
		assert.equal(sessionEnvironmentPrefix(path("store"), [path("repos", "unrelated")]), undefined);
	});

	test("a session's shell prefix joins the user's prefix and the blueprint environment of its restored worktrees (#4588)", async () => {
		const repo = repository("prefix");
		blueprint(repo.root, 'initialize: echo "FROM_BLUEPRINT=yes" >> "$ENVRC"\n');
		await runBlueprintBuild([repo], config({ storeDir: path("agent", "worktree-snapshots") }));
		const session = {
			_storageAgentDir: path("agent"),
			sessionManager: {
				getWorktreeRootMappings: () => [{ from: `${repo.root}-recorded`, to: repo.root }],
				getCwd: () => repo.root,
			},
		};
		const prefix = shellCommandPrefixFor(session as never, "USER_PREFIX=1");
		assert.ok(prefix?.startsWith("USER_PREFIX=1\n"));
		assert.equal(shellCommandPrefixFor(session as never, undefined)?.startsWith("set -a"), true);
		const shown = spawnSync("bash", ["-c", `${prefix}\necho "$USER_PREFIX $FROM_BLUEPRINT"`], {
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "" },
		});
		assert.equal(shown.stdout, "1 yes\n");
		const bare = { ...session, sessionManager: { getWorktreeRootMappings: () => [], getCwd: () => repo.root } };
		assert.equal(shellCommandPrefixFor(bare as never, undefined), undefined);
		assert.equal(shellCommandPrefixFor({ ...session, _storageAgentDir: undefined } as never, "x"), "x");
	});

	test("$ENVRC is reset at the start of every build (#4588)", async () => {
		const repo = repository("reset");
		blueprint(
			repo.root,
			`initialize: echo "LEFTOVER=1" >> "$ENVRC"\nmaintenance: 'echo "[${"$"}{LEFTOVER:-unset}]" >> "$MARKERS"'\n`,
		);
		await runBlueprintBuild([repo], config());
		blueprint(repo.root, `maintenance: 'echo "[${"$"}{LEFTOVER:-unset}]" >> "$MARKERS"'\n`);
		await runBlueprintBuild([repo], config());
		assert.deepEqual(ran(), ["[1]", "[unset]"]);
		assert.equal(sessionEnvironmentPrefix(path("store"), [repo.root]), undefined);
	});

	test("the build's temporary $ENVRC file does not outlive it (#4588)", async () => {
		const repo = repository("cleanup");
		blueprint(repo.root, "maintenance: echo ok\n");
		await runBlueprintBuild([repo], config());
		const leftovers = existsSync(path("store", "blueprint-builds"))
			? readdirSync(path("store", "blueprint-builds")).filter((name) => name.endsWith(".envrc"))
			: [];
		assert.deepEqual(leftovers, []);
	});

	test("a multi-line script stops at its first failing command (#4588)", async () => {
		const repo = repository("errexit");
		blueprint(repo.root, `maintenance: |\n  ${mark("before")}\n  false\n  ${mark("after")}\n`);
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "partial");
		assert.deepEqual(ran(), [`before ${repo.root}`]);
	});
});

describe("blueprint build: differential builds (#4588)", () => {
	const counted = (name: string) =>
		`initialize: echo "${name}-init" >> "$MARKERS"\nmaintenance: echo "${name}-maint" >> "$MARKERS"\n`;

	test("an unchanged workspace is inherited: initialize is skipped and maintenance still runs (#4588)", async () => {
		const repo = repository("diff");
		blueprint(repo.root, counted("root"));
		const first = await runBlueprintBuild([repo], config());
		assert.equal(first.kind, "full");
		const restoredAgain = repository("diff");
		const second = await runBlueprintBuild([restoredAgain], config());
		assert.equal(second.kind, "differential");
		assert.deepEqual(ran(), ["root-init", "root-maint", "root-maint"]);
		assert.deepEqual(
			second.layers.map((layer) => layer.state),
			[{ kind: "built", action: "inherit" }],
		);
	});

	test("a changed blueprint rebuilds, and the digest is what decides (#4588)", async () => {
		const repo = repository("diff");
		blueprint(repo.root, counted("v1"));
		await runBlueprintBuild([repo], config());
		blueprint(repo.root, counted("v2"));
		const second = await runBlueprintBuild([repo], config());
		assert.equal(second.kind, "differential");
		assert.deepEqual(ran(), ["v1-init", "v1-maint", "v2-init", "v2-maint"]);
		assert.deepEqual(second.layers[0]?.state, { kind: "built", action: "rebuild" });
	});

	test("a new workspace rebuilds while its unchanged siblings are inherited (#4588)", async () => {
		const repo = repository("mono", { "api/.keep": "", "web/.keep": "" });
		blueprint(repo.root, `includes: [api]\n${counted("root")}`);
		blueprint(repo.root, counted("api"), "api");
		await runBlueprintBuild([repo], config());
		blueprint(repo.root, `includes: [api, web]\n${counted("root")}`);
		blueprint(repo.root, counted("web"), "web");
		const second = await runBlueprintBuild([repo], config());
		assert.equal(second.kind, "differential");
		assert.deepEqual(
			second.layers.map((layer) => [
				layer.directory,
				layer.state.kind === "built" ? layer.state.action : layer.state.kind,
			]),
			[
				[".", "rebuild"],
				["api", "inherit"],
				["web", "rebuild"],
			],
		);
	});

	test("a workspace that is gone from the configuration is removed from the ledger (#4588)", async () => {
		const repo = repository("mono", { "api/.keep": "", "web/.keep": "" });
		blueprint(repo.root, `includes: [api, web]\n${counted("root")}`);
		blueprint(repo.root, counted("api"), "api");
		blueprint(repo.root, counted("web"), "web");
		await runBlueprintBuild([repo], config());
		blueprint(repo.root, `includes: [api]\n${counted("root")}`);
		const second = await runBlueprintBuild([repo], config());
		assert.deepEqual(second.removed, ["web"]);
		const ledger = await readLedger(path("store"));
		assert.equal(Object.keys(ledger.workspaces).filter((key) => key.endsWith(":web")).length, 0);
		assert.equal(Object.keys(ledger.workspaces).filter((key) => key.endsWith(":api")).length, 1);
	});

	test("a changed global blueprint runs a full build: every workspace is rebuilt (#4588)", async () => {
		const repo = repository("diff");
		write(path("agent", "blueprint.yaml"), 'initialize: echo "g1-init" >> "$MARKERS"\n');
		blueprint(repo.root, counted("root"));
		await runBlueprintBuild([repo], config());
		write(path("agent", "blueprint.yaml"), 'initialize: echo "g2-init" >> "$MARKERS"\n');
		const second = await runBlueprintBuild([repo], config());
		assert.equal(second.kind, "full");
		assert.deepEqual(ran(), ["g1-init", "root-init", "root-maint", "g2-init", "root-init", "root-maint"]);
	});

	test("a differential build skips global initialize but still runs global maintenance (#4588)", async () => {
		const repo = repository("diff");
		write(path("agent", "blueprint.yaml"), `${counted("global")}`);
		blueprint(repo.root, counted("root"));
		await runBlueprintBuild([repo], config());
		const second = await runBlueprintBuild([repo], config());
		assert.equal(second.kind, "differential");
		assert.deepEqual(ran(), ["global-init", "global-maint", "root-init", "root-maint", "global-maint", "root-maint"]);
	});

	test("a full build older than 7 days runs again in full, and a younger one does not (#4588)", async () => {
		const repo = repository("diff");
		blueprint(repo.root, counted("root"));
		await runBlueprintBuild([repo], config());
		clock += BLUEPRINT_FULL_BUILD_MAX_AGE_MS - 1;
		assert.equal((await runBlueprintBuild([repo], config())).kind, "differential");
		clock += 2;
		assert.equal((await runBlueprintBuild([repo], config())).kind, "full");
		assert.equal((await runBlueprintBuild([repo], config())).kind, "differential");
	});

	test("a differential build keeps the age of the last full build (#4588)", async () => {
		const repo = repository("diff");
		blueprint(repo.root, counted("root"));
		await runBlueprintBuild([repo], config());
		clock += BLUEPRINT_FULL_BUILD_MAX_AGE_MS - 10;
		await runBlueprintBuild([repo], config());
		clock += 20;
		assert.equal((await runBlueprintBuild([repo], config())).kind, "full");
	});

	test("a workspace is the same one across restores of the same repository, not across repositories (#4588)", async () => {
		const first = repository("one");
		blueprint(first.root, counted("one"));
		await runBlueprintBuild([first], config());
		const sameRemote: BlueprintRepository = { root: path("repos", "restored-again"), identity: first.identity };
		blueprint(sameRemote.root, counted("one"));
		const inherited = await runBlueprintBuild([sameRemote], config());
		assert.equal(inherited.layers[0]?.state.kind === "built" && inherited.layers[0].state.action, "inherit");
		const other: BlueprintRepository = { root: path("repos", "other"), identity: "https://example.test/other.git" };
		blueprint(other.root, counted("one"));
		const rebuilt = await runBlueprintBuild([other], config());
		assert.equal(rebuilt.layers[0]?.state.kind === "built" && rebuilt.layers[0].state.action, "rebuild");
	});

	test("the ledger and logs live under the store directory (#4588)", async () => {
		const repo = repository("diff");
		blueprint(repo.root, counted("root"));
		await runBlueprintBuild([repo], config());
		assert.ok(existsSync(path("store", "blueprint-builds", "ledger.json")));
		assert.ok(readdirSync(path("store", "blueprint-logs")).length >= 2);
	});
});

describe("blueprint build: failures never block and are reported (#4588)", () => {
	test("a failing initialize step resumes as Partial, skips that workspace's maintenance, builds the others, writes a log and forces a Rebuild next time (#4588)", async () => {
		const broken = repository("broken");
		const healthy = repository("healthy", { "pkg/.keep": "" });
		blueprint(
			broken.root,
			`initialize:\n  - name: install toolchain\n    run: |\n      echo "compiler missing" >&2\n      exit 7\n  - name: never reached\n    run: ${mark("second-init")}\nmaintenance: ${mark("broken-maint")}\n`,
		);
		blueprint(
			healthy.root,
			`includes: [pkg]\ninitialize: ${mark("healthy-init")}\nmaintenance: ${mark("healthy-maint")}\n`,
		);
		blueprint(healthy.root, `maintenance: ${mark("pkg-maint")}\n`, "pkg");

		const outcome = await runBlueprintBuild([broken, healthy], config());

		assert.equal(outcome.status, "partial");
		assert.deepEqual(ran(), [
			`healthy-init ${healthy.root}`,
			`healthy-maint ${healthy.root}`,
			`pkg-maint ${join(healthy.root, "pkg")}`,
		]);
		const failure = failureStep(outcome);
		assert.ok(isBlueprintStepFailedError(failure.error));
		assert.equal(failure.error.exitStatus, 7);
		assert.equal(failure.error.signal, null);
		assert.equal(failure.error.section, "initialize");
		assert.equal(failure.error.step, "install toolchain");
		assert.equal(failure.error.index, 0);
		assert.equal(failure.error.scope, "repository");
		assert.equal(failure.error.blueprint, join(broken.root, ".atomic", "blueprint.yaml"));
		assert.equal(failure.root, broken.root);
		assert.match(failure.outputTail, /compiler missing/);
		assert.ok(failure.logPath !== null && existsSync(failure.logPath));
		assert.equal(failure.error.logPath, failure.logPath);
		const log = readFileSync(failure.logPath, "utf8");
		assert.match(log, /# step: install toolchain \(1\/2\)/);
		assert.match(log, /exit 7/);
		assert.match(log, /compiler missing/);
		assert.match(log, /# exit status 7/);
		assert.deepEqual(
			outcome.layers.map((layer) => [layer.root === broken.root, layer.state.kind]),
			[
				[true, "failed"],
				[false, "built"],
				[false, "built"],
			],
		);

		blueprint(broken.root, "initialize: echo fixed\nmaintenance: echo fixed-maint\n");
		const next = await runBlueprintBuild([broken, healthy], config());
		assert.equal(next.status, "success");
		assert.equal(next.layers[0]?.state.kind === "built" && next.layers[0].state.action, "rebuild");
		assert.equal(next.layers[1]?.state.kind === "built" && next.layers[1].state.action, "inherit");
	});

	test("a workspace that failed last time is rebuilt even though its blueprint is unchanged (#4588)", async () => {
		const repo = repository("flaky");
		blueprint(
			repo.root,
			`initialize: |\n  echo "init" >> "$MARKERS"\n  test -f "$MARKERS.ok"\nmaintenance: echo maint >> "$MARKERS"\n`,
		);
		const first = await runBlueprintBuild([repo], config());
		assert.equal(first.status, "partial");
		writeFileSync(`${markers()}.ok`, "");
		const second = await runBlueprintBuild([repo], config());
		assert.equal(second.status, "success");
		assert.deepEqual(ran(), ["init", "init", "maint"]);
		assert.equal(second.layers[0]?.state.kind === "built" && second.layers[0].state.action, "rebuild");
		const third = await runBlueprintBuild([repo], config());
		assert.equal(third.layers[0]?.state.kind === "built" && third.layers[0].state.action, "inherit");
	});

	test("a failing maintenance step stops the rest of that blueprint and leaves its initialize done (#4588)", async () => {
		const repo = repository("maint");
		blueprint(
			repo.root,
			`initialize: ${mark("init")}\nmaintenance:\n  - ${mark("maint-1")}\n  - name: broken install\n    run: exit 3\n  - ${mark("maint-3")}\n`,
		);
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "partial");
		assert.deepEqual(ran(), [`init ${repo.root}`, `maint-1 ${repo.root}`]);
		const failure = failureStep(outcome);
		assert.ok(isBlueprintStepFailedError(failure.error));
		assert.equal(failure.error.section, "maintenance");
		assert.equal(failure.error.index, 1);
		assert.equal(failure.error.step, "broken install");
		assert.equal(outcome.layers[0]?.state.kind === "failed" && outcome.layers[0].state.section, "maintenance");
	});

	test("a step without a name is reported by its section and position (#4588)", async () => {
		const repo = repository("anonymous");
		blueprint(repo.root, "maintenance:\n  - echo one\n  - exit 2\n");
		const failure = failureStep(await runBlueprintBuild([repo], config()));
		assert.ok(isBlueprintStepFailedError(failure.error));
		assert.equal(failure.error.step, "maintenance step 2");
	});

	test("a step stopped by a signal is a typed failure with the signal (#4588)", async () => {
		const repo = repository("signal");
		blueprint(repo.root, "maintenance: kill -TERM $$\n");
		const failure = failureStep(await runBlueprintBuild([repo], config()));
		assert.ok(isBlueprintStepFailedError(failure.error));
		assert.equal(failure.error.signal, "SIGTERM");
		assert.equal(failure.error.exitStatus, null);
	});

	test("a step that cannot be started is a typed failure that keeps its cause (#4588)", async () => {
		const repo = repository("nostart");
		write(path("agent", "blueprint.yaml"), "maintenance: echo hi\n");
		const outcome = await runBlueprintBuild([repo], config({ homeDir: path("does-not-exist") }));
		assert.equal(outcome.status, "failed");
		const failure = failureStep(outcome);
		assert.ok(isBlueprintStepFailedError(failure.error));
		assert.equal(failure.error.exitStatus, null);
		assert.equal(failure.error.signal, null);
		assert.ok(failure.error.cause instanceof Error);
		assert.ok(failure.logPath !== null);
		assert.match(readFileSync(failure.logPath, "utf8"), /could not be started/);
	});

	test("a step that exceeds its timeout is stopped and reported as timed out (#4588)", async () => {
		const repo = repository("slow");
		blueprint(
			repo.root,
			`maintenance:\n  - name: hang\n    run: |\n      ${mark("started")}\n      sleep 30\n      ${mark("finished")}\n`,
		);
		const outcome = await runBlueprintBuild([repo], config({ stepTimeoutMs: 400 }));
		assert.equal(outcome.status, "partial");
		const failure = failureStep(outcome);
		assert.ok(isBlueprintStepTimedOutError(failure.error));
		assert.equal(failure.error.timeoutMs, 400);
		assert.equal(failure.error.phase, "maintenance");
		assert.equal(failure.error.step, "hang");
		assert.ok(failure.error.elapsedMs >= 300);
		assert.deepEqual(ran(), [`started ${repo.root}`]);
		assert.ok(failure.logPath !== null);
		assert.match(readFileSync(failure.logPath, "utf8"), /timed out after 400 ms/);
	});

	test("the production step timeout is 3 hours (#4588)", async () => {
		const { BLUEPRINT_STEP_TIMEOUT_MS } = await import("../src/core/resume/index.ts");
		assert.equal(BLUEPRINT_STEP_TIMEOUT_MS, 3 * 60 * 60 * 1000);
	});

	test("a global initialize failure is Failed, stops the build, and the next build is a full one (#4588)", async () => {
		const repo = repository("after-global");
		write(
			path("agent", "blueprint.yaml"),
			`initialize: exit 4\nmaintenance: ${mark("global-maint")}\npost-build: ${mark("post")}\n`,
		);
		blueprint(repo.root, `maintenance: ${mark("repo-maint")}\n`);
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "failed");
		assert.deepEqual(ran(), []);
		const failure = failureStep(outcome);
		assert.equal(failure.scope, "global");
		assert.ok(isBlueprintStepFailedError(failure.error));
		assert.equal(failure.error.exitStatus, 4);
		assert.equal(failure.error.blueprint, path("agent", "blueprint.yaml"));
		const notRun = outcome.layers.filter((layer) => layer.scope !== "global");
		assert.deepEqual(
			notRun.map((layer) => layer.state),
			[{ kind: "not-run", reason: "global-failed" }],
		);

		write(path("agent", "blueprint.yaml"), `maintenance: ${mark("global-maint")}\n`);
		const next = await runBlueprintBuild([repo], config());
		assert.equal(next.status, "success");
		assert.equal(next.kind, "full");
		assert.deepEqual(ran(), [`global-maint ${path("home")}`, `repo-maint ${repo.root}`]);
	});

	test("a global failure leaves restored worktrees marked to build again on the next resume (#4588)", async () => {
		const repo = repository("retry");
		write(path("agent", "blueprint.yaml"), "initialize: exit 1\n");
		blueprint(repo.root, "maintenance: echo ok\n");
		await runBlueprintBuild([repo], config());
		const ledger = await readLedger(path("store"));
		assert.equal(ledger.roots[rootKey(repo.root)]?.state, "failed");
		assert.equal(ledger.global?.status, "failed");
	});

	test("a post-build failure is Failed after every repository was built (#4588)", async () => {
		const repo = repository("post");
		write(path("agent", "blueprint.yaml"), "post-build:\n  - name: verify tools\n    run: exit 5\n");
		blueprint(repo.root, `maintenance: ${mark("repo-maint")}\n`);
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "failed");
		assert.deepEqual(ran(), [`repo-maint ${repo.root}`]);
		const failure = failureStep(outcome);
		assert.ok(isBlueprintStepFailedError(failure.error));
		assert.equal(failure.error.section, "post-build");
		assert.equal(failure.error.step, "verify tools");
		assert.equal(failure.scope, "global");
	});

	test("an invalid repository blueprint is a Partial failure and the other repositories still build (#4588)", async () => {
		const bad = repository("bad");
		const good = repository("good");
		blueprint(bad.root, "maintenance:\n  - uses: github.com/actions/setup-node@v4\n");
		blueprint(good.root, `maintenance: ${mark("good")}\n`);
		const outcome = await runBlueprintBuild([bad, good], config());
		assert.equal(outcome.status, "partial");
		assert.deepEqual(ran(), [`good ${good.root}`]);
		const failure = failureStep(outcome);
		assert.ok(isBlueprintInvalidError(failure.error));
		assert.equal(failure.error.reason, "uses-in-maintenance");
		assert.equal(failure.logPath, null);
	});

	test("an invalid global blueprint is a global failure and the build still returns (#4588)", async () => {
		const repo = repository("g");
		write(path("agent", "blueprint.yaml"), "shell: zsh\n");
		blueprint(repo.root, "maintenance: echo ok\n");
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "failed");
		assert.ok(isBlueprintInvalidError(failureStep(outcome).error));
		assert.equal(failureStep(outcome).scope, "global");
	});

	test("a clone section is reported as a warning once a build ran it (#4588)", async () => {
		const repo = repository("cloned");
		blueprint(repo.root, "clone:\n  depth: 1\nmaintenance: echo ok\n");
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "success");
		assert.deepEqual(
			outcome.warnings.map((warning) => warning.code),
			["clone-ignored"],
		);
	});

	test("an aborted build rejects with the signal's reason and leaves the worktree marked unfinished (#4588)", async () => {
		const repo = repository("abort");
		blueprint(repo.root, `maintenance: |\n  ${mark("started")}\n  sleep 30\n`);
		const controller = new AbortController();
		const reason = new Error("resume cancelled");
		const pending = runBlueprintBuild([repo], config(), controller.signal);
		const deadline = Date.now() + 10_000;
		while (ran().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort(reason);
		await assert.rejects(pending, (error: unknown) => error === reason);
		const ledger = await readLedger(path("store"));
		assert.equal(ledger.roots[rootKey(repo.root)]?.state, "running");
		blueprint(repo.root, 'maintenance: echo again >> "$MARKERS"\n');
		const next = await runBlueprintBuild([repo], config());
		assert.equal(next.layers[0]?.state.kind === "built" && next.layers[0].state.action, "rebuild");
	});

	test("an already aborted signal rejects before anything runs (#4588)", async () => {
		const repo = repository("aborted");
		blueprint(repo.root, `maintenance: ${mark("never")}\n`);
		const controller = new AbortController();
		controller.abort(new Error("stop"));
		await assert.rejects(runBlueprintBuild([repo], config(), controller.signal), /stop/);
		assert.deepEqual(ran(), []);
	});

	test("a crash in the build machinery is reported, not thrown (#4588)", async () => {
		const repo = repository("crash");
		blueprint(repo.root, "maintenance: echo ok\n");
		write(path("store"), "a file where the store directory should be");
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "failed");
		assert.equal(failureStep(outcome).error.code, "blueprint-build-failed");
	});
});

describe("blueprint build: trust and the deprecated alias (#4588)", () => {
	test("an untrusted worktree executes nothing, reports nothing and still describes its blueprints (#4588)", async () => {
		const repo = repository("untrusted");
		write(path("agent", "blueprint.yaml"), `initialize: ${mark("global")}\n`);
		blueprint(
			repo.root,
			`initialize: ${mark("init")}\nmaintenance: ${mark("maint")}\nknowledge:\n  - name: test\n    contents: npm test\n`,
		);
		const outcome = await runBlueprintBuild([repo], config({ trusted: () => false }));
		assert.deepEqual(ran(), []);
		assert.equal(outcome.status, "skipped");
		assert.equal(outcome.kind, undefined);
		assert.deepEqual(outcome.failures, []);
		assert.deepEqual(outcome.warnings, []);
		const repositoryLayer = outcome.layers.find((layer) => layer.scope === "repository");
		assert.deepEqual(repositoryLayer?.state, { kind: "not-run", reason: "untrusted" });
		assert.equal(repositoryLayer?.document?.knowledge[0]?.name, "test");
		assert.equal(existsSync(path("store")), false);
	});

	test("trust is decided per repository: only trusted ones are built (#4588)", async () => {
		const trusted = repository("trusted");
		const untrusted = repository("untrusted");
		blueprint(trusted.root, `maintenance: ${mark("trusted")}\n`);
		blueprint(untrusted.root, `maintenance: ${mark("untrusted")}\n`);
		const outcome = await runBlueprintBuild(
			[trusted, untrusted],
			config({ trusted: (root) => root === trusted.root }),
		);
		assert.deepEqual(ran(), [`trusted ${trusted.root}`]);
		assert.equal(outcome.status, "success");
		assert.deepEqual(
			outcome.layers.map((layer) => [layer.root === trusted.root, layer.state.kind]),
			[
				[true, "built"],
				[false, "not-run"],
			],
		);
	});

	test("resume.setupCommand runs as one global maintenance step in each restored repository root (#4588)", async () => {
		const first = repository("alias-one");
		const second = repository("alias-two");
		write(path("agent", "blueprint.yaml"), `maintenance: ${mark("global-maint")}\n`);
		blueprint(first.root, `maintenance: ${mark("first-maint")}\n`);
		const outcome = await runBlueprintBuild([first, second], config({ setupCommand: mark(SETUP_COMMAND_ALIAS) }));
		assert.equal(outcome.status, "success");
		assert.deepEqual(ran(), [
			`global-maint ${path("home")}`,
			`${SETUP_COMMAND_ALIAS} ${first.root}`,
			`${SETUP_COMMAND_ALIAS} ${second.root}`,
			`first-maint ${first.root}`,
		]);
	});

	test("resume.setupCommand alone, with no blueprint anywhere, still runs (#4588)", async () => {
		const repo = repository("alias-only");
		const outcome = await runBlueprintBuild([repo], config({ setupCommand: mark(SETUP_COMMAND_ALIAS) }));
		assert.equal(outcome.status, "success");
		assert.deepEqual(ran(), [`${SETUP_COMMAND_ALIAS} ${repo.root}`]);
	});

	test("a failing resume.setupCommand is a global failure that names the alias and its log (#4588)", async () => {
		const repo = repository("alias-fail");
		const outcome = await runBlueprintBuild([repo], config({ setupCommand: "echo broken >&2; exit 9" }));
		assert.equal(outcome.status, "failed");
		const failure = failureStep(outcome);
		assert.ok(isBlueprintStepFailedError(failure.error));
		assert.equal(failure.error.blueprint, SETUP_COMMAND_ALIAS);
		assert.equal(failure.error.exitStatus, 9);
		assert.equal(failure.scope, "global");
	});

	test("changing resume.setupCommand changes the global digest and runs a full build (#4588)", async () => {
		const repo = repository("alias-digest");
		blueprint(repo.root, "maintenance: echo ok\n");
		await runBlueprintBuild([repo], config({ setupCommand: "true" }));
		assert.equal((await runBlueprintBuild([repo], config({ setupCommand: "true" }))).kind, "differential");
		assert.equal((await runBlueprintBuild([repo], config({ setupCommand: "echo changed" }))).kind, "full");
	});
});

const stamp = (ms: number) => new Date(ms).toISOString();
const BUILD_ID = /^20261109000000000-[0-9a-f]{8}-/;
const BUILD_ID_LENGTH = "20261109000000000-abcdef12".length;
const keyOf = (root: string) => rootKey(root).slice(0, 8);

function logNames(): string[] {
	return existsSync(path("store", "blueprint-logs")) ? readdirSync(path("store", "blueprint-logs")).sort() : [];
}

function stepIdentity(failure: BlueprintBuildOutcome["failures"][number]) {
	return {
		scope: failure.scope,
		blueprint: failure.blueprint,
		root: failure.root,
		directory: failure.directory,
		logPath: failure.logPath,
		outputTail: failure.outputTail,
	};
}

describe("blueprint build: logs and the build's $ENVRC (#4588)", () => {
	test("logs are named after the build, the layer, the section and the step number (#4588)", async () => {
		const mono = repository("mono", { "my--pkg/core/.keep": "" });
		const plain = repository("plain");
		write(
			path("agent", "blueprint.yaml"),
			`initialize: ${mark("g-init")}\nmaintenance: ${mark("g-maint")}\npost-build: ${mark("g-post")}\n`,
		);
		blueprint(
			mono.root,
			`includes: [my--pkg/core]\ninitialize: ${mark("root-init")}\nmaintenance: ${mark("root-maint")}\n`,
		);
		blueprint(mono.root, `maintenance: ${mark("ws-maint")}\n`, "my--pkg/core");
		const outcome = await runBlueprintBuild([mono, plain], config({ setupCommand: mark("alias") }));
		assert.equal(outcome.status, "success");
		const names = logNames();
		assert.ok(names.every((name) => BUILD_ID.test(name)));
		assert.equal(new Set(names.map((name) => name.slice(0, BUILD_ID_LENGTH))).size, 1);
		const monoKey = keyOf(mono.root);
		assert.deepEqual(
			names.map((name) => name.replace(BUILD_ID, "")),
			[
				"global-initialize-1.log",
				"global-maintenance-1.log",
				"global-post-build-1.log",
				`${monoKey}-_-initialize-1.log`,
				`${monoKey}-_-maintenance-1.log`,
				`${monoKey}-alias-maintenance-1.log`,
				`${monoKey}-my_pkg_core-maintenance-1.log`,
				`${keyOf(plain.root)}-alias-maintenance-1.log`,
			].sort(),
		);
	});

	test("the build's $ENVRC is a private file in the store named after the build and is gone afterwards (#4588)", async () => {
		const repo = repository("envrc");
		const steps = ['echo "path=$ENVRC" >> "$MARKERS"'];
		if (process.platform !== "win32") {
			steps.push('[ -n "$(find "$ENVRC" -maxdepth 0 -perm 600)" ] && echo private >> "$MARKERS"');
		}
		blueprint(repo.root, `maintenance:\n${steps.map((step) => `  - '${step}'`).join("\n")}\n`);
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "success");
		const buildId = logNames()[0]!.slice(0, BUILD_ID_LENGTH);
		const envrc = path("store", "blueprint-builds", `${buildId}.envrc`);
		assert.deepEqual(ran(), [`path=${bashPath(envrc)}`, ...(process.platform === "win32" ? [] : ["private"])]);
		assert.equal(existsSync(envrc), false);
	});
});

describe("blueprint build: what the ledger records (#4588)", () => {
	test("a successful build records the global digest and times, the workspace and the worktree (#4588)", async () => {
		const repo = repository("led");
		write(path("agent", "blueprint.yaml"), "maintenance: echo g\n");
		blueprint(repo.root, "maintenance: echo ok\n");
		await runBlueprintBuild([repo], config());
		const finished = stamp(clock);
		assert.deepEqual(await readLedger(path("store")), {
			version: 1,
			global: {
				digest: blueprintDigest(".", "maintenance: echo g\n", ""),
				status: "success",
				builtAt: finished,
				lastFullBuildAt: finished,
			},
			workspaces: {
				[workspaceKey(repo.identity, ".")]: {
					digest: blueprintDigest(".", "maintenance: echo ok\n"),
					status: "success",
					builtAt: finished,
				},
			},
			roots: { [rootKey(repo.root)]: { state: "success", at: finished } },
		});
	});

	test("the global digest covers an absent blueprint and the trimmed alias (#4588)", async () => {
		const repo = repository("digest");
		blueprint(repo.root, "maintenance: echo ok\n");
		await runBlueprintBuild([repo], config());
		assert.equal((await readLedger(path("store"))).global?.digest, blueprintDigest(".", "", ""));
		await runBlueprintBuild([repo], config({ setupCommand: "  echo alias  " }));
		assert.equal((await readLedger(path("store"))).global?.digest, blueprintDigest(".", "", "echo alias"));
	});

	test("a failed workspace records its step and log, an invalid one its blueprint and no log, and both mark the worktree failed (#4588)", async () => {
		const broken = repository("broken");
		const invalid = repository("invalid");
		blueprint(broken.root, "maintenance:\n  - name: install toolchain\n    run: exit 7\n");
		const invalidSource = "maintenance:\n  - uses: github.com/actions/setup-node@v4\n";
		blueprint(invalid.root, invalidSource);
		const outcome = await runBlueprintBuild([broken, invalid], config());
		const [brokenFailure, invalidFailure] = outcome.failures;
		const ledger = await readLedger(path("store"));
		assert.deepEqual(ledger.workspaces[workspaceKey(broken.identity, ".")], {
			digest: blueprintDigest(".", "maintenance:\n  - name: install toolchain\n    run: exit 7\n"),
			status: "failed",
			builtAt: stamp(clock),
			failedStep: "install toolchain",
			logPath: brokenFailure?.logPath,
		});
		assert.deepEqual(ledger.workspaces[workspaceKey(invalid.identity, ".")], {
			digest: blueprintDigest(".", invalidSource),
			status: "failed",
			builtAt: stamp(clock),
			failedStep: join(invalid.root, ".atomic", "blueprint.yaml"),
		});
		assert.equal(invalidFailure?.logPath, null);
		assert.equal(invalidFailure?.outputTail, "");
		assert.deepEqual(
			[ledger.roots[rootKey(broken.root)]?.state, ledger.roots[rootKey(invalid.root)]?.state],
			["failed", "failed"],
		);
	});

	test("a blueprint without a document for this platform is a successful no-document layer (#4588)", async () => {
		const repo = repository("elsewhere");
		const source = `runs-on: macos\nmaintenance: ${mark("mac")}\n`;
		blueprint(repo.root, source);
		const outcome = await runBlueprintBuild([repo], config({ platform: "linux" }));
		assert.deepEqual(outcome.layers[0]?.state, { kind: "no-document" });
		assert.deepEqual((await readLedger(path("store"))).workspaces[workspaceKey(repo.identity, ".")], {
			digest: blueprintDigest(".", source),
			status: "success",
			builtAt: stamp(clock),
		});
	});

	test("builds of different repositories keep each other's workspaces and worktrees (#4588)", async () => {
		const first = repository("first");
		const second = repository("second");
		blueprint(first.root, 'initialize: echo first >> "$MARKERS"\n');
		blueprint(second.root, 'initialize: echo second >> "$MARKERS"\n');
		await runBlueprintBuild([first], config());
		await runBlueprintBuild([second], config());
		const ledger = await readLedger(path("store"));
		assert.deepEqual(
			Object.keys(ledger.workspaces).sort(),
			[workspaceKey(first.identity, "."), workspaceKey(second.identity, ".")].sort(),
		);
		assert.deepEqual(Object.keys(ledger.roots).sort(), [rootKey(first.root), rootKey(second.root)].sort());
		const again = await runBlueprintBuild([first], config());
		assert.deepEqual(again.layers[0]?.state, { kind: "built", action: "inherit" });
		assert.deepEqual(ran(), ["first", "second"]);
	});

	test("a failed full build clears the time of the last full build, and a differential build keeps it (#4588)", async () => {
		const repo = repository("global-time");
		blueprint(repo.root, "maintenance: echo ok\n");
		write(path("agent", "blueprint.yaml"), "maintenance: echo g\n");
		const start = stamp(clock);
		await runBlueprintBuild([repo], config());
		clock += 1000;
		const differential = await runBlueprintBuild([repo], config());
		assert.equal(differential.kind, "differential");
		assert.deepEqual((await readLedger(path("store"))).global, {
			digest: blueprintDigest(".", "maintenance: echo g\n", ""),
			status: "success",
			builtAt: stamp(clock),
			lastFullBuildAt: start,
		});
		write(path("agent", "blueprint.yaml"), "initialize: exit 1\n");
		const failedFull = await runBlueprintBuild([repo], config());
		assert.equal(failedFull.kind, "full");
		assert.equal(failedFull.status, "failed");
		assert.deepEqual((await readLedger(path("store"))).global, {
			digest: blueprintDigest(".", "initialize: exit 1\n", ""),
			status: "failed",
			builtAt: stamp(clock),
		});
	});
});

describe("blueprint build: when a build is full (#4588)", () => {
	test("a build after a failed global build is full even though nothing changed (#4588)", async () => {
		const repo = repository("global-retry");
		blueprint(repo.root, "maintenance: echo ok\n");
		write(path("agent", "blueprint.yaml"), 'maintenance: test -f "$MARKERS.ok"\n');
		writeFileSync(`${markers()}.ok`, "");
		assert.equal((await runBlueprintBuild([repo], config())).kind, "full");
		rmSync(`${markers()}.ok`);
		const failed = await runBlueprintBuild([repo], config());
		assert.equal(failed.kind, "differential");
		assert.equal(failed.status, "failed");
		writeFileSync(`${markers()}.ok`, "");
		const retry = await runBlueprintBuild([repo], config());
		assert.equal(retry.kind, "full");
		assert.equal(retry.status, "success");
	});

	test("a ledger entry without the time of a full build means the next build is full (#4588)", async () => {
		const repo = repository("global-untimed");
		blueprint(repo.root, "maintenance: echo ok\n");
		await runBlueprintBuild([repo], config());
		await updateLedger(path("store"), (ledger) => ({
			...ledger,
			global: { digest: ledger.global!.digest, status: "success", builtAt: ledger.global!.builtAt },
		}));
		assert.equal((await runBlueprintBuild([repo], config())).kind, "full");
	});

	test("a full build is due only when the last one is strictly older than the maximum age (#4588)", async () => {
		const repo = repository("global-age");
		blueprint(repo.root, "maintenance: echo ok\n");
		await runBlueprintBuild([repo], config());
		clock += BLUEPRINT_FULL_BUILD_MAX_AGE_MS;
		assert.equal((await runBlueprintBuild([repo], config())).kind, "differential");
		clock += 1;
		assert.equal((await runBlueprintBuild([repo], config())).kind, "full");
		const limit = config({ fullBuildMaxAgeMs: 1000 });
		clock += 1000;
		assert.equal((await runBlueprintBuild([repo], limit)).kind, "differential");
		clock += 1;
		assert.equal((await runBlueprintBuild([repo], limit)).kind, "full");
	});

	test("the global layer says whether its initialize ran in this build (#4588)", async () => {
		const repo = repository("global-layer");
		write(path("agent", "blueprint.yaml"), "initialize: echo init\nmaintenance: echo maint\n");
		blueprint(repo.root, "maintenance: echo ok\n");
		const full = await runBlueprintBuild([repo], config());
		const differential = await runBlueprintBuild([repo], config());
		for (const [outcome, action] of [
			[full, "rebuild"],
			[differential, "inherit"],
		] as const) {
			const layer = outcome.layers[0];
			assert.equal(layer?.scope, "global");
			assert.equal(layer?.blueprint, path("agent", "blueprint.yaml"));
			assert.equal(layer?.root, null);
			assert.equal(layer?.directory, null);
			assert.deepEqual(layer?.state, { kind: "built", action });
			assert.equal(layer?.document?.initialize[0]?.kind, "run");
		}
	});

	test("a worktree whose last build never finished is built again, with its workspaces, though nothing changed (#4588)", async () => {
		const repo = repository("interrupted", { "api/.keep": "" });
		const counted = (name: string) => `initialize: echo "${name}" >> "$MARKERS"\n`;
		blueprint(repo.root, `includes: [api]\n${counted("root")}`);
		blueprint(repo.root, counted("api"), "api");
		await runBlueprintBuild([repo], config());
		assert.deepEqual(ran(), ["root", "api"]);
		await updateLedger(path("store"), (ledger) => ({
			...ledger,
			roots: { ...ledger.roots, [rootKey(repo.root)]: { state: "running", at: stamp(clock) } },
		}));
		const rebuilt = await runBlueprintBuild([repo], config());
		assert.deepEqual(
			rebuilt.layers.map((layer) => layer.state),
			[
				{ kind: "built", action: "rebuild" },
				{ kind: "built", action: "rebuild" },
			],
		);
		assert.deepEqual(ran(), ["root", "api", "root", "api"]);
		assert.equal((await readLedger(path("store"))).roots[rootKey(repo.root)]?.state, "success");
		assert.equal((await runBlueprintBuild([repo], config())).layers[0]?.state.kind, "built");
		assert.deepEqual(ran(), ["root", "api", "root", "api"]);
	});

	test("concurrent builds on one store all succeed, run each maintenance once and keep every ledger entry (#4588)", async () => {
		const repos = ["one", "two", "three", "four"].map((name) => {
			const repo = repository(`concurrent-${name}`);
			blueprint(repo.root, `maintenance: ${mark(name)}\n`);
			return repo;
		});
		const outcomes = await Promise.all(repos.map((repo) => runBlueprintBuild([repo], config())));
		assert.deepEqual(
			outcomes.map((outcome) => outcome.status),
			["success", "success", "success", "success"],
		);
		assert.equal(ran().length, 4);
		const ledger = await readLedger(path("store"));
		assert.equal(Object.keys(ledger.roots).length, 4);
		assert.equal(Object.keys(ledger.workspaces).length, 4);
		assert.ok(Object.values(ledger.roots).every((entry) => entry.state === "success"));
	});

	test("which worktrees need a rebuild is read from the ledger (#4588)", () => {
		const root = path("repos", "needs");
		const ledgerWith = (state?: "running" | "success" | "failed"): BlueprintLedger => ({
			version: 1,
			workspaces: {},
			roots: state === undefined ? {} : { [rootKey(root)]: { state, at: stamp(clock) } },
		});
		assert.equal(needsRebuild(ledgerWith("failed"), root), true);
		assert.equal(needsRebuild(ledgerWith("running"), root), true);
		assert.equal(needsRebuild(ledgerWith("success"), root), false);
		assert.equal(needsRebuild(ledgerWith(), root), true);
	});
});

describe("blueprint build: global failures and the alias (#4588)", () => {
	test("a failing global initialize is the global layer's failure in its section, with its own log (#4588)", async () => {
		const repo = repository("g-init");
		write(path("agent", "blueprint.yaml"), "initialize: exit 4\n");
		blueprint(repo.root, "maintenance: echo ok\n");
		const outcome = await runBlueprintBuild([repo], config());
		const failure = failureStep(outcome);
		assert.ok(isBlueprintStepFailedError(failure.error));
		assert.equal(failure.blueprint, path("agent", "blueprint.yaml"));
		assert.equal(failure.error.scope, "global");
		assert.equal(failure.error.section, "initialize");
		assert.equal(failure.root, null);
		assert.equal(failure.directory, null);
		assert.ok(failure.logPath?.endsWith("-global-initialize-1.log"));
		assert.deepEqual(outcome.layers[0]?.state, { kind: "failed", failure, section: "initialize" });
	});

	test("a failing global maintenance stops the build before the alias and the repositories (#4588)", async () => {
		const repo = repository("g-maint");
		write(path("agent", "blueprint.yaml"), "maintenance: exit 5\n");
		blueprint(repo.root, `maintenance: ${mark("repo")}\n`);
		const outcome = await runBlueprintBuild([repo], config({ setupCommand: mark(SETUP_COMMAND_ALIAS) }));
		assert.equal(outcome.status, "failed");
		assert.deepEqual(ran(), []);
		const failure = failureStep(outcome);
		assert.ok(isBlueprintStepFailedError(failure.error));
		assert.equal(failure.blueprint, path("agent", "blueprint.yaml"));
		assert.equal(failure.error.section, "maintenance");
		assert.equal(failure.error.scope, "global");
		assert.deepEqual(outcome.layers[0]?.state, { kind: "failed", failure, section: "maintenance" });
		assert.deepEqual(
			logNames().map((name) => name.replace(BUILD_ID, "")),
			["global-maintenance-1.log"],
		);
	});

	test("a failing alias is a global failure named after the alias, in the first repository it fails in (#4588)", async () => {
		const first = repository("alias-first");
		const second = repository("alias-second");
		const outcome = await runBlueprintBuild([first, second], config({ setupCommand: `${mark("alias")}\nexit 9` }));
		assert.equal(outcome.status, "failed");
		assert.deepEqual(ran(), [`alias ${first.root}`]);
		const failure = failureStep(outcome);
		assert.ok(isBlueprintStepFailedError(failure.error));
		assert.equal(failure.blueprint, SETUP_COMMAND_ALIAS);
		assert.equal(failure.error.blueprint, SETUP_COMMAND_ALIAS);
		assert.equal(failure.error.scope, "global");
		assert.equal(failure.error.section, "maintenance");
		assert.equal(failure.error.step, SETUP_COMMAND_ALIAS);
		assert.equal(failure.logPath, failure.error.logPath);
		assert.ok(failure.logPath?.endsWith(`-${keyOf(first.root)}-alias-maintenance-1.log`));
		assert.deepEqual(outcome.layers[0]?.state, { kind: "failed", failure, section: "maintenance" });
		assert.deepEqual(outcome.layers[0]?.document?.maintenance.at(-1), {
			kind: "run",
			name: SETUP_COMMAND_ALIAS,
			run: `${mark("alias")}\nexit 9`,
			env: {},
		});
		const log = readFileSync(failure.logPath!, "utf8");
		assert.match(log, new RegExp(`^# blueprint: ${SETUP_COMMAND_ALIAS.replace(".", "\\.")}$`, "m"));
		assert.match(log, /^# scope: global$/m);
		assert.match(log, /^# section: maintenance$/m);
		assert.match(log, new RegExp(`^# step: ${SETUP_COMMAND_ALIAS.replace(".", "\\.")} \\(1/1\\)$`, "m"));
		assert.ok(log.includes(`# cwd: ${first.root}\n# command:\n${mark("alias")}\nexit 9\n# --- output ---\n`));
	});

	test("an alias without any global blueprint file is a global layer with its own document (#4588)", async () => {
		const repo = repository("alias-doc");
		const outcome = await runBlueprintBuild([repo], config({ setupCommand: "echo alias" }));
		assert.deepEqual(outcome.layers, [
			{
				scope: "global",
				blueprint: path("agent", "blueprint.yaml"),
				root: null,
				directory: null,
				document: {
					platforms: ["linux"],
					shell: "default",
					initialize: [],
					maintenance: [{ kind: "run", name: SETUP_COMMAND_ALIAS, run: "echo alias", env: {} }],
					knowledge: [],
					postBuild: [],
					includes: [],
				},
				state: { kind: "built", action: "rebuild" },
			},
		]);
	});

	test("a whitespace-only setupCommand is no alias at all (#4588)", async () => {
		const repo = repository("alias-blank");
		blueprint(repo.root, `maintenance: ${mark("repo")}\n`);
		const outcome = await runBlueprintBuild([repo], config({ setupCommand: "  \n " }));
		assert.equal(outcome.status, "success");
		assert.deepEqual(
			outcome.layers.map((layer) => layer.scope),
			["repository"],
		);
		assert.deepEqual(ran(), [`repo ${repo.root}`]);
		assert.deepEqual(
			logNames().map((name) => name.replace(BUILD_ID, "")),
			[`${keyOf(repo.root)}-_-maintenance-1.log`],
		);
		const bare = repository("alias-blank-bare");
		assert.equal((await runBlueprintBuild([bare], config({ setupCommand: "  " }))).status, "none");
	});

	test("a failing post-build is the global layer's failure in its section after every repository was built (#4588)", async () => {
		const repo = repository("g-post");
		write(path("agent", "blueprint.yaml"), "post-build: exit 6\n");
		blueprint(repo.root, `maintenance: ${mark("repo")}\n`);
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "failed");
		const failure = failureStep(outcome);
		assert.ok(isBlueprintStepFailedError(failure.error));
		assert.deepEqual(stepIdentity(failure), {
			scope: "global",
			blueprint: path("agent", "blueprint.yaml"),
			root: null,
			directory: null,
			logPath: failure.error.logPath,
			outputTail: failure.outputTail,
		});
		assert.equal(failure.error.scope, "global");
		assert.equal(failure.error.section, "post-build");
		assert.ok(failure.logPath?.endsWith("-global-post-build-1.log"));
		assert.deepEqual(
			outcome.layers.map((layer) => layer.state.kind),
			["failed", "built"],
		);
		assert.deepEqual(outcome.layers[0]?.state, { kind: "failed", failure, section: "post-build" });
		assert.equal((await readLedger(path("store"))).global?.status, "failed");
		assert.equal((await readLedger(path("store"))).roots[rootKey(repo.root)]?.state, "failed");
	});

	test("a global blueprint with only knowledge has no steps to run and is still built (#4588)", async () => {
		const repo = repository("g-knowledge");
		write(path("agent", "blueprint.yaml"), "knowledge:\n  - name: tip\n    contents: be kind\n");
		blueprint(repo.root, `maintenance: ${mark("repo")}\n`);
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "success");
		assert.deepEqual(outcome.layers[0]?.state, { kind: "built", action: "rebuild" });
		assert.deepEqual(
			logNames().map((name) => name.replace(BUILD_ID, "")),
			[`${keyOf(repo.root)}-_-maintenance-1.log`],
		);
	});
});

describe("blueprint build: repositories, workspaces and failures in the outcome (#4588)", () => {
	test("only the repositories with a blueprint get a layer and a ledger entry, but every trusted one is marked built (#4588)", async () => {
		const plain = repository("plain");
		const built = repository("built");
		blueprint(built.root, `maintenance: ${mark("built")}\n`);
		const outcome = await runBlueprintBuild([plain, built], config());
		assert.equal(outcome.status, "success");
		assert.deepEqual(ran(), [`built ${built.root}`]);
		assert.deepEqual(
			outcome.layers.map((layer) => layer.root),
			[built.root],
		);
		const ledger = await readLedger(path("store"));
		assert.deepEqual(Object.keys(ledger.workspaces), [workspaceKey(built.identity, ".")]);
		assert.deepEqual(
			[ledger.roots[rootKey(plain.root)]?.state, ledger.roots[rootKey(built.root)]?.state],
			["success", "success"],
		);
	});

	test("a workspace whose directory disappeared is dropped from the ledger and never forces a rebuild (#4588)", async () => {
		const repo = repository("shrinks", { "api/.keep": "" });
		blueprint(repo.root, "includes: [api]\nmaintenance: echo root\n");
		blueprint(repo.root, "maintenance: echo api\n", "api");
		await runBlueprintBuild([repo], config());
		assert.equal(
			Object.keys((await readLedger(path("store"))).workspaces).includes(workspaceKey(repo.identity, "api")),
			true,
		);
		rmSync(join(repo.root, "api"), { recursive: true });
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "success");
		assert.deepEqual(outcome.removed, ["api"]);
		assert.equal(
			Object.keys((await readLedger(path("store"))).workspaces).includes(workspaceKey(repo.identity, "api")),
			false,
		);
		assert.equal((await readLedger(path("store"))).roots[rootKey(repo.root)]?.state, "success");
	});

	test("an included directory below a regular file removes that workspace as well (#4588)", async () => {
		const repo = repository("below-file", { "plain-file": "not a directory" });
		blueprint(repo.root, "includes: [plain-file/sub]\nmaintenance: echo ok\n");
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "success");
		assert.deepEqual(outcome.failures, []);
	});

	test("an invalid repository blueprint is a failed layer without a section, a log or output (#4588)", async () => {
		const repo = repository("invalid-layer");
		blueprint(repo.root, "maintenance:\n  - uses: github.com/actions/setup-node@v4\n");
		const outcome = await runBlueprintBuild([repo], config());
		const failure = failureStep(outcome);
		assert.deepEqual(stepIdentity(failure), {
			scope: "repository",
			blueprint: join(repo.root, ".atomic", "blueprint.yaml"),
			root: repo.root,
			directory: ".",
			logPath: null,
			outputTail: "",
		});
		assert.deepEqual(outcome.layers[0]?.state, { kind: "failed", failure, section: null });
		assert.equal(outcome.layers[0]?.document, undefined);
	});

	test("an invalid global blueprint is a failed global layer without a section, a log or output (#4588)", async () => {
		const repo = repository("invalid-global");
		write(path("agent", "blueprint.yaml"), "shell: zsh\n");
		blueprint(repo.root, "maintenance: echo ok\n");
		const outcome = await runBlueprintBuild([repo], config());
		const failure = failureStep(outcome);
		assert.deepEqual(stepIdentity(failure), {
			scope: "global",
			blueprint: path("agent", "blueprint.yaml"),
			root: null,
			directory: null,
			logPath: null,
			outputTail: "",
		});
		assert.deepEqual(outcome.layers[0]?.state, { kind: "failed", failure, section: null });
		assert.deepEqual(
			outcome.layers.slice(1).map((layer) => layer.state),
			[{ kind: "not-run", reason: "global-failed" }],
		);
	});

	test("a global failure still describes the workspaces of every repository as not run (#4588)", async () => {
		const repo = repository("global-failed-mono", { "api/.keep": "" });
		write(path("agent", "blueprint.yaml"), "initialize: exit 1\n");
		blueprint(repo.root, "includes: [api]\nmaintenance: echo ok\n");
		blueprint(repo.root, "maintenance: echo api\n", "api");
		const outcome = await runBlueprintBuild([repo], config());
		assert.deepEqual(
			outcome.layers.map((layer) => [layer.scope, layer.directory, layer.state.kind]),
			[
				["global", null, "failed"],
				["repository", ".", "not-run"],
				["workspace", "api", "not-run"],
			],
		);
	});

	test("with only untrusted worktrees the global blueprint is described as not run for that reason (#4588)", async () => {
		const repo = repository("all-untrusted");
		write(path("agent", "blueprint.yaml"), `initialize: ${mark("global")}\n`);
		blueprint(repo.root, `maintenance: ${mark("repo")}\n`);
		const outcome = await runBlueprintBuild([repo], config({ trusted: () => false }));
		assert.equal(outcome.status, "skipped");
		assert.deepEqual(
			outcome.layers.map((layer) => [layer.scope, layer.state]),
			[
				["global", { kind: "not-run", reason: "untrusted" }],
				["repository", { kind: "not-run", reason: "untrusted" }],
			],
		);
		assert.deepEqual(outcome.removed, []);
	});

	test("trusted worktrees without any blueprint leave only the untrusted ones to describe (#4588)", async () => {
		const plain = repository("trusted-plain");
		const locked = repository("locked", {});
		blueprint(locked.root, `maintenance: ${mark("locked")}\n`);
		const outcome = await runBlueprintBuild([plain, locked], config({ trusted: (root) => root === plain.root }));
		assert.equal(outcome.status, "skipped");
		assert.equal(outcome.kind, undefined);
		assert.deepEqual(
			outcome.layers.map((layer) => [layer.root, layer.state]),
			[[locked.root, { kind: "not-run", reason: "untrusted" }]],
		);
		assert.deepEqual([outcome.failures, outcome.warnings, outcome.removed], [[], [], []]);
		assert.equal(existsSync(path("store")), false);
	});
});

describe("blueprint build: reading blueprints and surviving crashes (#4588)", () => {
	test("a global blueprint that cannot be read is a failed global layer that keeps the read error as its cause (#4588)", async () => {
		const repo = repository("unreadable");
		blueprint(repo.root, `maintenance: ${mark("never")}\n`);
		mkdirSync(path("agent", "blueprint.yaml"), { recursive: true });
		const outcome = await runBlueprintBuild([repo], config());
		assert.deepEqual([outcome.status, outcome.kind, outcome.warnings, outcome.removed], ["failed", "full", [], []]);
		assert.deepEqual(
			outcome.layers.map((layer) => [layer.scope, layer.state.kind]),
			[
				["global", "failed"],
				["repository", "not-run"],
			],
		);
		const failure = failureStep(outcome);
		assert.deepEqual(stepIdentity(failure), {
			scope: "global",
			blueprint: path("agent", "blueprint.yaml"),
			root: null,
			directory: null,
			logPath: null,
			outputTail: "",
		});
		assert.ok(isBlueprintBuildFailedError(failure.error));
		assert.equal(failure.error.phase, "read-blueprint");
		assert.equal(failure.error.detail, `${path("agent", "blueprint.yaml")} could not be read`);
		assert.equal((failure.error.cause as NodeJS.ErrnoException).code, DIRECTORY_AS_FILE_ERRNO);
		assert.deepEqual(ran(), []);
	});

	test("a build ledger that cannot be read fails the build with phase ledger and a cause, and runs nothing (#4588)", async () => {
		const repo = repository("ledger-unreadable");
		blueprint(repo.root, `maintenance: ${mark("never")}\n`);
		mkdirSync(path("store", "blueprint-builds", "ledger.json"), { recursive: true });
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "failed");
		const failure = failureStep(outcome);
		assert.ok(isBlueprintBuildFailedError(failure.error));
		assert.equal(failure.error.phase, "ledger");
		assert.equal(failure.error.detail, "the build ledger could not be read");
		assert.ok(failure.error.cause instanceof Error);
		assert.deepEqual(ran(), []);
	});

	test("a build that stopped before it finished still describes every repository for the agent, with the failure (#4588)", async () => {
		const first = repository("crash-first");
		const second = repository("crash-second");
		const locked = repository("crash-locked");
		blueprint(first.root, `maintenance: ${mark("never")}\nknowledge:\n  - name: test\n    contents: first-fact\n`);
		blueprint(second.root, "knowledge:\n  - name: test\n    contents: second-fact\n");
		blueprint(locked.root, "knowledge:\n  - name: test\n    contents: locked-fact\n");
		mkdirSync(path("store", "blueprint-builds", "ledger.json"), { recursive: true });
		const outcome = await runBlueprintBuild(
			[first, second, locked],
			config({ trusted: (root) => root !== locked.root }),
		);
		assert.equal(outcome.status, "failed");
		assert.ok(isBlueprintBuildFailedError(failureStep(outcome).error));
		assert.deepEqual(
			outcome.layers.map((layer) => [layer.scope, layer.root, layer.state.kind]),
			[
				["global", null, "failed"],
				["repository", first.root, "not-run"],
				["repository", second.root, "not-run"],
				["repository", locked.root, "not-run"],
			],
		);
		assert.deepEqual(
			outcome.layers.slice(1).map((layer) => (layer.state.kind === "not-run" ? layer.state.reason : undefined)),
			["build-failed", "build-failed", "untrusted"],
		);
		const context = renderBlueprintContext(outcome.layers) ?? "";
		for (const fact of ["first-fact", "second-fact", "locked-fact"]) assert.ok(context.includes(fact), fact);
		assert.ok(context.includes("Failure: "));
		assert.ok(context.includes("NOT CONFIRMED: the build stopped before it finished"));
		assert.deepEqual(ran(), []);
	});

	test("a crashed build keeps the global blueprint's own document on its failed layer, once, beside every repository (#4588)", async () => {
		const repo = repository("crash-global");
		const locked = repository("crash-global-locked");
		blueprint(repo.root, "knowledge:\n  - name: test\n    contents: repo-fact\n");
		blueprint(locked.root, "knowledge:\n  - name: test\n    contents: locked-fact\n");
		write(path("agent", "blueprint.yaml"), "knowledge:\n  - name: test\n    contents: global-fact\n");
		mkdirSync(path("store", "blueprint-builds", "ledger.json"), { recursive: true });
		const outcome = await runBlueprintBuild([repo, locked], config({ trusted: (root) => root !== locked.root }));
		assert.equal(outcome.status, "failed");
		const globals = outcome.layers.filter((layer) => layer.scope === "global");
		assert.equal(globals.length, 1);
		assert.equal(globals[0]?.state.kind, "failed");
		assert.equal(globals[0]?.blueprint, path("agent", "blueprint.yaml"));
		assert.equal(globals[0]?.document?.knowledge[0]?.contents, "global-fact");
		assert.deepEqual(
			outcome.layers.map((layer) => layer.scope),
			["global", "repository", "repository"],
		);
		const context = renderBlueprintContext(outcome.layers) ?? "";
		assert.equal(context.split("global-fact").length - 1, 1);
		assert.ok(context.includes("repo-fact") && context.includes("locked-fact"));
	});

	test("a build whose blueprints cannot even be described reports the failure on a bare global layer (#4588)", async () => {
		const repo = repository("crash-bare");
		blueprint(repo.root, "maintenance: echo ok\n");
		const outcome = await runBlueprintBuild(
			[repo],
			config({
				trusted: () => {
					throw new Error("trust lookup failed");
				},
			}),
		);
		assert.equal(outcome.status, "failed");
		assert.deepEqual(
			outcome.layers.map((layer) => [layer.scope, layer.document, layer.state.kind]),
			[["global", undefined, "failed"]],
		);
		assert.ok(renderBlueprintContext(outcome.layers)?.includes("Failure: "));
	});

	test("a step log that cannot be created fails only the blueprint whose step hit it and never starts that step (#4588)", async () => {
		const first = repository("log-first");
		const second = repository("log-second");
		blueprint(first.root, `maintenance: ${mark("never-first")}\n`);
		blueprint(second.root, `maintenance: ${mark("never-second")}\n`);
		mkdirSync(path("store"), { recursive: true });
		writeFileSync(path("store", "blueprint-logs"), "a file where the log directory should be");
		const outcome = await runBlueprintBuild([first, second], config());
		assert.equal(outcome.status, "partial");
		assert.equal(outcome.failures.length, 2);
		for (const failure of outcome.failures) {
			assert.ok(isBlueprintStepFailedError(failure.error));
			assert.equal(failure.error.logPath, null);
			assert.equal(failure.error.exitStatus, null);
			assert.ok(failure.error.cause instanceof Error);
			assert.equal(failure.logPath, null);
			assert.equal(failure.outputTail, "");
		}
		assert.deepEqual(ran(), []);
		assert.ok(renderBlueprintContext(outcome.layers) !== undefined);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a build directory that cannot be written fails the build with phase environment and a cause (#4588)",
		async () => {
			const repo = repository("env-unwritable");
			blueprint(repo.root, `maintenance: ${mark("never")}\n`);
			mkdirSync(path("store", "blueprint-builds"), { recursive: true });
			chmodSync(path("store", "blueprint-builds"), 0o500);
			try {
				const outcome = await runBlueprintBuild([repo], config());
				assert.equal(outcome.status, "failed");
				const failure = failureStep(outcome);
				assert.ok(isBlueprintBuildFailedError(failure.error));
				assert.equal(failure.error.phase, "environment");
				assert.equal(failure.error.detail, "the $ENVRC file could not be created");
				assert.ok(failure.error.cause instanceof Error);
				assert.deepEqual(ran(), []);
			} finally {
				chmodSync(path("store", "blueprint-builds"), 0o700);
			}
		},
	);

	test("a step that replaces the build ledger with a directory fails the build with phase ledger, naming what failed (#4588)", async () => {
		const repo = repository("ledger-swapped");
		const ledger = join(path("store"), "blueprint-builds", "ledger.json").replaceAll("\\", "/");
		blueprint(repo.root, `maintenance: rm -f "${ledger}" && mkdir "${ledger}"\n`);
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "failed");
		const failure = failureStep(outcome);
		assert.ok(isBlueprintBuildFailedError(failure.error));
		assert.equal(failure.error.phase, "ledger");
		assert.equal(failure.error.detail, "the build ledger could not be written");
	});

	test("a $ENVRC that cannot be kept for the session fails the build with phase environment, naming what failed (#4588)", async () => {
		const repo = repository("env-unkeepable");
		blueprint(repo.root, 'maintenance: echo "A=1" >> "$ENVRC"\n');
		mkdirSync(path("store"), { recursive: true });
		writeFileSync(path("store", "blueprint-env"), "a file where the directory should be");
		const outcome = await runBlueprintBuild([repo], config());
		const failure = failureStep(outcome);
		assert.ok(isBlueprintBuildFailedError(failure.error));
		assert.equal(failure.error.phase, "environment");
		assert.equal(failure.error.detail, "the $ENVRC of the build could not be kept for the session");
	});

	test("a .atomic that is a file instead of a directory means no blueprint (#4588)", async () => {
		const repo = repository("file-atomic", { ".atomic": "not a directory" });
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "none");
		assert.deepEqual(outcome.layers, []);
	});

	test("a blueprint with too many YAML aliases is invalid for its own repository only (#4588)", async () => {
		const bomb = repository("bomb");
		const good = repository("good");
		const aliases = Array.from({ length: 150 }, () => "*a").join(", ");
		blueprint(bomb.root, `anchor: &a [1, 2, 3]\nrepeated: [${aliases}]\nmaintenance: ${mark("never")}\n`);
		blueprint(good.root, `maintenance: ${mark("good")}\n`);
		const outcome = await runBlueprintBuild([bomb, good], config());
		assert.equal(outcome.status, "partial");
		const failure = failureStep(outcome);
		assert.ok(isBlueprintInvalidError(failure.error));
		assert.equal(failure.error.reason, "yaml-syntax");
		assert.equal(failure.error.subject, "document 1");
		assert.ok(failure.error.cause instanceof Error);
		assert.deepEqual(ran(), [`good ${good.root}`]);
	});

	test("a crash is a failed outcome that keeps the error as its cause and cuts its detail to 200 characters (#4588)", async () => {
		const repo = repository("crash-detail");
		blueprint(repo.root, "maintenance: echo ok\n");
		const outcome = await runBlueprintBuild(
			[repo],
			config({
				trusted: () => {
					throw new Error(`trust lookup failed: ${"x".repeat(300)}`);
				},
			}),
		);
		assert.deepEqual(
			[outcome.status, outcome.kind, outcome.warnings, outcome.removed],
			["failed", undefined, [], []],
		);
		assert.deepEqual(
			outcome.layers.map((layer) => [layer.scope, layer.state.kind]),
			[["global", "failed"]],
		);
		const failure = failureStep(outcome);
		assert.deepEqual(stepIdentity(failure), {
			scope: "global",
			blueprint: path("agent", "blueprint.yaml"),
			root: null,
			directory: null,
			logPath: null,
			outputTail: "",
		});
		assert.ok(isBlueprintBuildFailedError(failure.error));
		assert.equal(failure.error.phase, "unknown");
		assert.ok(failure.error.cause instanceof Error);
		assert.ok(failure.error.cause.message.length > 200);
		assert.equal(failure.error.detail, failure.error.cause.message.slice(0, 200));
	});

	test("a step that deletes $ENVRC crashes the build with that error, not the cleanup's (#4588)", async () => {
		const repo = repository("envrc-gone");
		blueprint(repo.root, 'maintenance: rm -f "$ENVRC"\n');
		const outcome = await runBlueprintBuild([repo], config());
		assert.equal(outcome.status, "failed");
		const failure = failureStep(outcome);
		assert.ok(isBlueprintBuildFailedError(failure.error));
		assert.equal(failure.error.phase, "environment");
		const cause = failure.error.cause as NodeJS.ErrnoException;
		assert.equal(cause.code, "ENOENT");
		assert.equal(cause.syscall, "open");
	});
});

describe("blueprint build: the environment kept for sessions (#4588)", () => {
	test("every trusted worktree gets a copy of the build's $ENVRC and an untrusted one gets none (#4588)", async () => {
		const first = repository("session-first");
		const second = repository("session-second");
		const locked = repository("session-locked");
		blueprint(first.root, 'initialize: echo "SHARED=yes" >> "$ENVRC"\n');
		blueprint(second.root, "maintenance: echo ok\n");
		await runBlueprintBuild([first, second, locked], config({ trusted: (root) => root !== locked.root }));
		for (const root of [first.root, second.root]) {
			assert.equal(readFileSync(sessionEnvrcPath(path("store"), root), "utf8"), "SHARED=yes\n");
		}
		assert.equal(existsSync(sessionEnvrcPath(path("store"), locked.root)), false);
	});

	test("a later build that writes again replaces the copy and one that writes only whitespace removes it (#4588)", async () => {
		const repo = repository("session-rewrite");
		blueprint(repo.root, 'initialize: echo "ROUND=1" >> "$ENVRC"\n');
		assert.equal((await runBlueprintBuild([repo], config())).status, "success");
		const file = sessionEnvrcPath(path("store"), repo.root);
		assert.equal(readFileSync(file, "utf8"), "ROUND=1\n");
		blueprint(repo.root, 'initialize: echo "ROUND=2" >> "$ENVRC"\n');
		assert.equal((await runBlueprintBuild([repo], config())).status, "success");
		assert.equal(readFileSync(file, "utf8"), "ROUND=2\n");
		blueprint(repo.root, 'initialize: echo >> "$ENVRC"\n');
		assert.equal((await runBlueprintBuild([repo], config())).status, "success");
		assert.equal(existsSync(file), false);
		assert.equal(sessionEnvironmentPrefix(path("store"), [repo.root]), undefined);
	});
});

describe("blueprint build: uses steps (#4588)", () => {
	test("a uses step runs its action through fetchAction and what it exports reaches the later steps (#4588)", async () => {
		const repo = repository("uses");
		const calls: string[] = [];
		const fetchAction: ActionFetcher = async ({ owner, repo: name, ref, destination }) => {
			calls.push(`${owner}/${name}@${ref}`);
			write(join(destination, "action.yml"), "name: Tool\nruns:\n  using: node20\n  main: main.js\n");
			write(
				join(destination, "main.js"),
				[
					'const fs = require("node:fs");',
					'fs.appendFileSync(process.env.GITHUB_ENV, "FROM_ACTION=exported\\n");',
					'fs.appendFileSync(process.env.MARKERS, "action ran\\n");',
				].join("\n"),
			);
		};
		blueprint(
			repo.root,
			[
				"initialize:",
				"  - uses: github.com/acme/tool@v1",
				'  - run: \'echo "seen $FROM_ACTION" >> "$MARKERS"\'',
				'maintenance: \'echo "maint $FROM_ACTION" >> "$MARKERS"\'',
				"",
			].join("\n"),
		);
		const outcome = await runBlueprintBuild([repo], config({ fetchAction }));
		assert.equal(outcome.status, "success");
		assert.deepEqual(calls, ["acme/tool@v1"]);
		assert.deepEqual(ran(), ["action ran", "seen exported", "maint exported"]);
	});
});

describe("describing blueprints without running them (#4588)", () => {
	function names(layers: readonly BlueprintLayer[]) {
		return layers.map((layer) => [layer.scope, layer.directory, layer.root === null ? null : layer.root]);
	}

	test("the global blueprint, the repository and its workspaces are described in order, none of them run (#4588)", async () => {
		const repo = repository("described", { "api/.keep": "", "web/.keep": "" });
		write(path("agent", "blueprint.yaml"), `maintenance: ${mark("global")}\n`);
		blueprint(repo.root, `includes: [api, web, gone]\nmaintenance: ${mark("root")}\n`);
		blueprint(repo.root, `maintenance: ${mark("api")}\n`, "api");
		blueprint(repo.root, `maintenance: ${mark("web")}\n`, "web");
		const layers = await describeBlueprints([repo], config(), "in-place");
		assert.deepEqual(names(layers), [
			["global", null, null],
			["repository", ".", repo.root],
			["workspace", "api", repo.root],
			["workspace", "web", repo.root],
		]);
		assert.deepEqual(
			layers.map((layer) => layer.blueprint),
			[
				path("agent", "blueprint.yaml"),
				join(repo.root, ".atomic", "blueprint.yaml"),
				join(repo.root, "api", ".atomic", "blueprint.yaml"),
				join(repo.root, "web", ".atomic", "blueprint.yaml"),
			],
		);
		assert.deepEqual(
			layers.map((layer) => layer.state),
			Array.from({ length: 4 }, () => ({ kind: "not-run", reason: "in-place" })),
		);
		assert.ok(layers.every((layer) => layer.document !== undefined));
		assert.deepEqual(ran(), []);
	});

	test("every reason is carried in the layers' state, and the global blueprint can be left out (#4588)", async () => {
		const repo = repository("reasons");
		write(path("agent", "blueprint.yaml"), "maintenance: echo global\n");
		blueprint(repo.root, "maintenance: echo repo\n");
		for (const reason of ["untrusted", "in-place", "earlier", "skipped"] as const) {
			const layers = await describeBlueprints([repo], config(), reason);
			assert.deepEqual(
				layers.map((layer) => layer.state),
				[
					{ kind: "not-run", reason },
					{ kind: "not-run", reason },
				],
			);
		}
		const withoutGlobal = await describeBlueprints([repo], config(), "earlier", false);
		assert.deepEqual(names(withoutGlobal), [["repository", ".", repo.root]]);
	});

	test("a repository without a blueprint and an included file that does not exist have no layer (#4588)", async () => {
		const repo = repository("sparse", { "api/.keep": "", "web/.keep": "" });
		const plain = repository("sparse-plain");
		blueprint(repo.root, "includes: [api, web]\nmaintenance: echo root\n");
		blueprint(repo.root, "maintenance: echo web\n", "web");
		const layers = await describeBlueprints([plain, repo], config(), "in-place");
		assert.deepEqual(names(layers), [
			["repository", ".", repo.root],
			["workspace", "web", repo.root],
		]);
	});

	test("an invalid blueprint is still a layer, without a document, in the scope it was read as (#4588)", async () => {
		const repo = repository("invalid-described", { "api/.keep": "" });
		write(path("agent", "blueprint.yaml"), "shell: zsh\n");
		blueprint(repo.root, "includes: [api]\nmaintenance: echo root\n");
		blueprint(repo.root, "post-build: echo nope\n", "api");
		const layers = await describeBlueprints([repo], config(), "in-place");
		assert.deepEqual(
			layers.map((layer) => [layer.scope, layer.directory, layer.document === undefined]),
			[
				["global", null, true],
				["repository", ".", false],
				["workspace", "api", true],
			],
		);
	});

	test("the platform decides which document is described, the host's by default (#4588)", async () => {
		const other = hostPlatform() === "macos" ? "linux" : "macos";
		const repo = repository("platforms");
		blueprint(
			repo.root,
			`runs-on: ${other}\nmaintenance: echo other\n---\nruns-on: ${hostPlatform()}\nmaintenance: echo host\n`,
		);
		const documents = async (platform: BlueprintBuildConfig["platform"]) =>
			(await describeBlueprints([repo], config({ platform }), "in-place")).map(
				(layer) => layer.document?.maintenance[0]?.run,
			);
		assert.deepEqual(await documents(other), ["echo other"]);
		assert.deepEqual(await documents(hostPlatform()), ["echo host"]);
		assert.deepEqual(await documents(undefined), ["echo host"]);
		const alias = await describeBlueprints(
			[],
			config({ platform: undefined, setupCommand: "echo alias" }),
			"skipped",
		);
		assert.deepEqual(alias[0]?.document?.platforms, [hostPlatform()]);
	});

	test("a setupCommand is one more global maintenance step, and a blank one is none (#4588)", async () => {
		write(path("agent", "blueprint.yaml"), "maintenance: echo global\n");
		const withAlias = await describeBlueprints([], config({ setupCommand: " echo alias " }), "skipped");
		assert.deepEqual(
			withAlias[0]?.document?.maintenance.map((step) => [step.name, step.run]),
			[
				[undefined, "echo global"],
				[SETUP_COMMAND_ALIAS, "echo alias"],
			],
		);
		const blank = await describeBlueprints([], config({ setupCommand: "   " }), "skipped");
		assert.equal(blank[0]?.document?.maintenance.length, 1);
		rmSync(path("agent", "blueprint.yaml"));
		assert.deepEqual(await describeBlueprints([], config({ setupCommand: "  " }), "skipped"), []);
		assert.equal((await describeBlueprints([], config({ setupCommand: "x" }), "skipped")).length, 1);
	});
});
