import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	closedObject,
	type ExpressionContext,
	ExpressionError,
	type ExpressionValue,
	evaluateCondition,
	evaluateExpression,
	interpolate,
} from "../src/core/resume/blueprint/action-expressions.ts";
import {
	ACTIONS_GITHUB_BASE_URL_ENV,
	type ActionFetcher,
	type ActionFetchRequest,
	ActionReferenceError,
	bashInvocation,
	findOnPath,
	nodeExecutableFor,
	parseActionReference,
	pathVariableName,
	powerShellInvocation,
	runAction,
} from "../src/core/resume/blueprint/actions.ts";
import { bashPath, shellQuote } from "../src/core/resume/blueprint/envrc.ts";
import {
	type BlueprintStepLocation,
	type BlueprintUsesUnsupportedError,
	type BlueprintUsesUnsupportedReason,
	isBlueprintUsesUnsupportedError,
} from "../src/core/resume/blueprint/errors.ts";
import { openStepLog, type ProcessExit, runLoggedProcess } from "../src/core/resume/blueprint/process.ts";
import { isWorkspaceGitError } from "../src/core/workspace/errors.ts";
import { setWorktreeSnapshotGit } from "../src/core/worktree-snapshot/git.ts";
import { createGitEnvironment } from "../src/utils/git-env.ts";
import { getShellConfig, type ShellConfig } from "../src/utils/shell.ts";
import { bunExecutable } from "./cli-test-helpers.ts";

/** Room for a node or bash process to start and finish on a loaded machine. */
const ACTION_TIMEOUT_MS = 60_000;
/** The budget of an action that never finishes: enough for node to start, so its pid file exists when it expires. */
const HANG_TIMEOUT_MS = 4_000;
/** A Bun child loads this module graph and runs two actions: a real child process, not a slow test. */
const BUN_PROBE_TIMEOUT_MS = 120_000;
/** The budget of a step that only has to expire: long enough for bash to have started, short enough not to wait. */
const SHORT_TIMEOUT_MS = 1_500;
/** How long a test waits for a process it started to report that it is running. */
const PROCESS_START_WAIT_MS = 20_000;

const LOCATION: BlueprintStepLocation = {
	blueprint: "/repository/.atomic/blueprint.yaml",
	scope: "repository",
	section: "initialize",
	index: 2,
	step: "Use the action",
};

interface Fixture {
	readonly root: string;
	readonly sources: string;
	readonly cacheDir: string;
	readonly workspace: string;
	readonly results: string;
	readonly envrcPath: string;
	readonly logs: string;
	readonly gitConfig: string;
}

let fixture: Fixture;
let logCount = 0;
let previousBaseUrl: string | undefined;

beforeEach(() => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-blueprint-actions-")));
	fixture = {
		root,
		sources: join(root, "sources"),
		cacheDir: join(root, "cache"),
		workspace: join(root, "workspace"),
		results: join(root, "results.txt"),
		envrcPath: join(root, "envrc"),
		logs: join(root, "logs"),
		gitConfig: join(root, "gitconfig"),
	};
	for (const directory of [fixture.sources, fixture.workspace, fixture.logs])
		mkdirSync(directory, { recursive: true });
	writeFileSync(fixture.envrcPath, "");
	writeFileSync(fixture.gitConfig, "");
	previousBaseUrl = process.env[ACTIONS_GITHUB_BASE_URL_ENV];
	process.env[ACTIONS_GITHUB_BASE_URL_ENV] = pathToFileURL(fixture.sources).href;
});

afterEach(() => {
	if (previousBaseUrl === undefined) delete process.env[ACTIONS_GITHUB_BASE_URL_ENV];
	else process.env[ACTIONS_GITHUB_BASE_URL_ENV] = previousBaseUrl;
	rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 });
});

function expression(source: string): string {
	return `$\{{ ${source} }}`;
}

function yaml(...lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function script(...lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.com",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"tag.gpgsign=false",
			"-c",
			"init.defaultBranch=main",
			...args,
		],
		{
			cwd,
			encoding: "utf8",
			env: createGitEnvironment({ GIT_CONFIG_GLOBAL: fixture.gitConfig, GIT_CONFIG_NOSYSTEM: "1" }),
		},
	).trim();
}

function writeFiles(directory: string, files: Readonly<Record<string, string>>): void {
	for (const [name, content] of Object.entries(files)) {
		const path = join(directory, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
}

interface CommitOptions {
	readonly tag?: string;
	readonly branch?: string;
}

/** Commits `files` to the repository `<owner>/<repo>` under the fixture's sources, creating it on first use. */
function commitRepository(slug: string, files: Readonly<Record<string, string>>, options: CommitOptions = {}): string {
	const directory = join(fixture.sources, `${slug}.git`);
	if (!existsSync(join(directory, ".git"))) {
		mkdirSync(directory, { recursive: true });
		git(directory, "init", "--quiet");
		git(directory, "config", "uploadpack.allowAnySHA1InWant", "true");
	}
	writeFiles(directory, files);
	git(directory, "add", "-A");
	git(directory, "commit", "--quiet", "-m", "fixture");
	if (options.tag !== undefined) git(directory, "tag", options.tag);
	if (options.branch !== undefined) git(directory, "branch", options.branch);
	return git(directory, "rev-parse", "HEAD");
}

function nodeAction(main: string, inputs: readonly string[] = []): Record<string, string> {
	return {
		"action.yml": yaml(
			"name: Fixture",
			...(inputs.length === 0 ? [] : ["inputs:", ...inputs]),
			"runs:",
			"  using: node20",
			"  main: main.js",
		),
		"main.js": main,
	};
}

function commitNodeAction(slug: string, main: string, inputs: readonly string[] = [], tag = "v1"): string {
	return commitRepository(slug, nodeAction(main, inputs), { tag });
}

interface RunOptions {
	readonly inputs?: Readonly<Record<string, string>>;
	readonly env?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly fetchAction?: ActionFetcher;
}

interface StartedRun {
	readonly logPath: string;
	readonly result: Promise<ProcessExit>;
}

function startRun(uses: string, options: RunOptions = {}): StartedRun {
	const logPath = join(fixture.logs, `step-${++logCount}.log`);
	const result = (async () => {
		const log = await openStepLog(logPath);
		try {
			return await runAction({
				step: { uses, inputs: options.inputs ?? {} },
				location: LOCATION,
				cwd: fixture.workspace,
				env: { ...process.env, RESULT_FILE: fixture.results, ...options.env },
				envrcPath: fixture.envrcPath,
				cacheDir: fixture.cacheDir,
				log,
				timeoutMs: options.timeoutMs ?? ACTION_TIMEOUT_MS,
				signal: options.signal,
				fetchAction: options.fetchAction,
			});
		} finally {
			await log.close();
		}
	})();
	return { logPath, result };
}

function readText(path: string): string {
	return readFileSync(path, "utf8");
}

function resultLines(): string[] {
	return existsSync(fixture.results) ? readText(fixture.results).split("\n").filter(Boolean) : [];
}

async function runToSuccess(uses: string, options: RunOptions = {}): Promise<string> {
	const started = startRun(uses, options);
	const exit = await started.result;
	assert.equal(exit.exitStatus, 0, readText(started.logPath));
	assert.equal(exit.signal, null);
	assert.equal(exit.timedOut, false);
	assert.equal(exit.spawnError, undefined);
	return started.logPath;
}

async function rejectionOf(promise: Promise<ProcessExit>): Promise<Error | undefined> {
	return promise.then(
		() => undefined,
		(rejection: Error) => rejection,
	);
}

async function expectUnsupported(
	started: StartedRun,
	uses: string,
	reason: BlueprintUsesUnsupportedReason,
): Promise<BlueprintUsesUnsupportedError> {
	const error = await rejectionOf(started.result);
	assert.ok(
		isBlueprintUsesUnsupportedError(error),
		`expected a blueprint-uses-unsupported error, got ${String(error)}`,
	);
	assert.equal(error.code, "blueprint-uses-unsupported");
	assert.equal(error.reason, reason);
	assert.equal(error.uses, uses);
	assert.equal(error.logPath, started.logPath);
	assert.deepEqual(
		{
			blueprint: error.blueprint,
			scope: error.scope,
			section: error.section,
			index: error.index,
			step: error.step,
		},
		{
			blueprint: LOCATION.blueprint,
			scope: LOCATION.scope,
			section: LOCATION.section,
			index: LOCATION.index,
			step: LOCATION.step,
		},
	);
	return error;
}

async function runBashStep(body: string): Promise<string> {
	const logPath = join(fixture.logs, `bash-${++logCount}.log`);
	const log = await openStepLog(logPath);
	try {
		const { shell, args, commandTransport } = getShellConfig();
		const exit = await runLoggedProcess(
			{
				command: shell,
				args: commandTransport === "stdin" ? args : [...args, body],
				cwd: fixture.workspace,
				env: { ...process.env, ENVRC: bashPath(fixture.envrcPath) },
				...(commandTransport === "stdin" ? { stdin: body } : {}),
			},
			log,
			{ timeoutMs: ACTION_TIMEOUT_MS },
		);
		assert.equal(exit.exitStatus, 0, readText(logPath));
	} finally {
		await log.close();
	}
	return readText(logPath);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + PROCESS_START_WAIT_MS;
	while (!existsSync(path)) {
		assert.ok(Date.now() < deadline, `${path} was never written`);
		await delay(20);
	}
}

const OBSERVE_ENVIRONMENT = script(
	'const fs = require("node:fs");',
	'const keys = Object.keys(process.env).filter((key) => /^(INPUT_|GITHUB_|RUNNER_|STATE_|CUSTOM)/.test(key) || key === "CI");',
	"const seen = Object.fromEntries(keys.map((key) => [key, process.env[key]]));",
	'seen.fileCommandsExisted = ["GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STATE"].every((key) => fs.existsSync(process.env[key]));',
	'fs.appendFileSync(process.env.RESULT_FILE, "main " + JSON.stringify(seen) + "\\n");',
);

describe("parseActionReference", () => {
	test("splits owner, repository, optional subpath and ref (#4588)", () => {
		assert.deepEqual(parseActionReference("github.com/actions/setup-node@v4"), {
			owner: "actions",
			repo: "setup-node",
			subpath: "",
			ref: "v4",
		});
		assert.deepEqual(parseActionReference("github.com/gradle/actions/setup-gradle@v4"), {
			owner: "gradle",
			repo: "actions",
			subpath: "setup-gradle",
			ref: "v4",
		});
		assert.deepEqual(parseActionReference("github.com/acme/tools/a/b/c@feature/x"), {
			owner: "acme",
			repo: "tools",
			subpath: "a/b/c",
			ref: "feature/x",
		});
		const sha = "0123456789abcdef0123456789abcdef01234567";
		assert.equal(parseActionReference(`github.com/acme/tools@${sha}`).ref, sha);
	});

	test("rejects strings that are not github.com/<owner>/<repo>[/<subpath>]@<ref> (#4588)", () => {
		for (const uses of [
			"actions/setup-node@v4",
			"https://github.com/actions/setup-node@v4",
			"github.com/actions/setup-node",
			"github.com/actions@v4",
			"github.com/actions/setup-node@",
			"github.com/-actions/setup-node@v4",
			"github.com/actions/..@v4",
			"github.com/actions/setup-node@--upload-pack=evil",
			"github.com/actions/setup-node@a:b",
			"github.com/actions/setup-node@a b",
		]) {
			assert.throws(() => parseActionReference(uses), ActionReferenceError, uses);
		}
	});
});

describe("action expressions", () => {
	const context: ExpressionContext = {
		failed: false,
		roots: {
			inputs: { name: "World", empty: "", count: "3" },
			env: { FOO: "bar" },
			github: closedObject("github", { repository: "atomic/blueprint", event: {} }),
			runner: closedObject("runner", { os: "Linux" }),
			steps: { build: closedObject("steps.build", { outputs: { path: "/dist" } }) },
		},
	};

	test("evaluates GitHub's operators, contexts and functions (#4588)", () => {
		const cases: ReadonlyArray<readonly [string, ExpressionValue]> = [
			["'a' == 'A'", true],
			["1 == '1'", true],
			["null == ''", true],
			["true == 1", true],
			["'a' != 'b'", true],
			["!inputs.empty", true],
			["inputs.empty || 'fallback'", "fallback"],
			["inputs.name && 'yes' || 'no'", "yes"],
			["(false || true) && !false", true],
			["inputs['name']", "World"],
			["inputs.NAME", "World"],
			["inputs.missing", null],
			["env.FOO", "bar"],
			["github.repository", "atomic/blueprint"],
			["github.event.number", null],
			["runner.os", "Linux"],
			["steps.build.outputs.path", "/dist"],
			["steps.absent.outputs.path", null],
			["contains('Hello World', 'WORLD')", true],
			["contains(fromJSON('[\"a\", \"b\"]'), 'b')", true],
			["startsWith(inputs.name, 'wor')", true],
			["endsWith(inputs.name, 'LD')", true],
			["format('{0}-{1} {{x}}', 'a', 1)", "a-1 {x}"],
			["join(fromJSON('[\"a\", \"b\"]'), '+')", "a+b"],
			['join(fromJSON(\'["a", "b"]\'))', "a,b"],
			['fromJSON(\'{"a": {"b": 3}}\').a.b', 3],
			["toJSON(fromJSON('[1]'))", "[\n  1\n]"],
			["'it''s'", "it's"],
		];
		for (const [source, expected] of cases) {
			assert.deepEqual(evaluateExpression(source, context), expected, source);
		}
	});

	test("rejects what it cannot evaluate instead of evaluating it to empty (#4588)", () => {
		for (const source of [
			"secrets.TOKEN",
			"matrix.os",
			"vars.NAME",
			"unknown.value",
			"github.nothing",
			"runner.name",
			"steps.build.outcome",
			"hashFiles('**/package.json')",
			"1 < 2",
			"inputs.name = 'World'",
			"'unterminated",
			"inputs.",
			"inputs.name inputs.name",
			"format('{1}', 'a')",
			"fromJSON('{')",
			"contains('a')",
			"",
		]) {
			assert.throws(() => evaluateExpression(source, context), ExpressionError, source);
		}
	});

	test("interpolates expression segments, even when a string holds }} (#4588)", () => {
		assert.equal(interpolate(`hi ${expression("inputs.name")}!`, context), "hi World!");
		assert.equal(interpolate(`${expression("'}}'")}${expression("inputs.count")}`, context), "}}3");
		assert.equal(interpolate("no expression", context), "no expression");
		assert.throws(() => interpolate("broken ${{ inputs.name", context), ExpressionError);
		assert.throws(() => interpolate(expression("secrets.TOKEN"), context), ExpressionError);
	});

	test("evaluates conditions with GitHub's implicit success() (#4588)", () => {
		const failed: ExpressionContext = { ...context, failed: true };
		assert.equal(evaluateCondition("inputs.name == 'World'", context), true);
		assert.equal(evaluateCondition(expression("inputs.name == 'World'"), context), true);
		assert.equal(evaluateCondition(expression("inputs.empty"), context), false);
		assert.equal(evaluateCondition("inputs.name == 'World'", failed), false);
		assert.equal(evaluateCondition("success()", failed), false);
		assert.equal(evaluateCondition("always()", failed), true);
		assert.equal(evaluateCondition("failure()", failed), true);
		assert.equal(evaluateCondition("inputs.name == 'World' && failure()", failed), true);
	});
});

describe("Node.js actions", () => {
	test("run pre and main with INPUT_ variables and skip post (#4588)", async () => {
		const marker = join(fixture.root, "post-marker");
		commitRepository(
			"acme/node-tool",
			{
				"action.yml": yaml(
					"name: Node tool",
					"inputs:",
					"  who:",
					"    default: world",
					"  python-version:",
					"    required: true",
					"  with space:",
					"    default: spaced",
					"  token:",
					`    default: ${expression("github.server_url == 'https://github.com' && github.token || 'no-token'")}`,
					"runs:",
					"  using: node20",
					"  pre: pre.js",
					"  main: main.js",
					"  post: post.js",
				),
				"pre.js": script(
					'const fs = require("node:fs");',
					'fs.appendFileSync(process.env.RESULT_FILE, "pre\\n");',
					'fs.appendFileSync(process.env.GITHUB_STATE, "from_pre=state-value\\n");',
				),
				"main.js": OBSERVE_ENVIRONMENT,
				"post.js": 'require("node:fs").writeFileSync(process.env.POST_MARKER, "ran");\n',
			},
			{ tag: "v1" },
		);

		const logPath = await runToSuccess("github.com/acme/node-tool@v1", {
			inputs: { "python-version": "3.12", extra: "1" },
			env: { POST_MARKER: marker },
		});

		const [pre, main] = resultLines();
		assert.equal(pre, "pre");
		const seen = JSON.parse((main ?? "").slice("main ".length)) as Record<string, string | boolean>;
		assert.equal(seen.INPUT_WHO, "world");
		assert.equal(seen["INPUT_PYTHON-VERSION"], "3.12");
		assert.equal(seen.INPUT_WITH_SPACE, "spaced");
		assert.equal(seen.INPUT_EXTRA, "1");
		assert.equal(seen.INPUT_TOKEN, "no-token");
		assert.equal(seen.STATE_from_pre, "state-value");
		assert.equal(existsSync(marker), false);
		const log = readText(logPath);
		assert.ok(log.includes("pre of github.com/acme/node-tool@v1"));
		assert.ok(log.includes("main of github.com/acme/node-tool@v1"));
	});

	test("see the GitHub and runner environment of an action outside a workflow (#4588)", async () => {
		commitNodeAction("acme/env-probe", OBSERVE_ENVIRONMENT);
		const hostGithubEnv = join(fixture.root, "host-github-env");

		await runToSuccess("github.com/acme/env-probe@v1", {
			env: { CUSTOM_STEP_VALUE: "from-step-env", GITHUB_ENV: hostGithubEnv },
		});

		const seen = JSON.parse((resultLines()[0] ?? "").slice("main ".length)) as Record<string, string | boolean>;
		assert.equal(seen.GITHUB_ACTIONS, "true");
		assert.equal(seen.CI, "true");
		assert.equal(seen.GITHUB_WORKSPACE, fixture.workspace);
		assert.equal(seen.GITHUB_ACTION_PATH, join(fixture.cacheDir, "acme", "env-probe", "v1"));
		assert.equal(seen.GITHUB_ACTION_REPOSITORY, "acme/env-probe");
		assert.equal(seen.GITHUB_ACTION_REF, "v1");
		assert.equal(seen.GITHUB_EVENT_NAME, "workflow_dispatch");
		assert.ok(typeof seen.GITHUB_REPOSITORY === "string" && seen.GITHUB_REPOSITORY.includes("/"));
		assert.ok(typeof seen.GITHUB_SHA === "string" && seen.GITHUB_SHA.length > 0);
		assert.match(String(seen.RUNNER_OS), /^(Linux|macOS|Windows)$/);
		assert.notEqual(seen.RUNNER_ARCH, undefined);
		assert.equal(seen.RUNNER_TEMP, join(fixture.cacheDir, "_runner", "temp"));
		assert.equal(seen.RUNNER_TOOL_CACHE, join(fixture.cacheDir, "_runner", "tool"));
		assert.equal(seen.CUSTOM_STEP_VALUE, "from-step-env");
		assert.equal(seen.fileCommandsExisted, true);
		assert.ok(String(seen.GITHUB_ENV).startsWith(join(fixture.cacheDir, "_runner", "temp")));
		assert.equal(existsSync(String(seen.GITHUB_ENV)), false, "the file command files are removed afterwards");
		assert.equal(existsSync(hostGithubEnv), false, "a GITHUB_ENV inherited from the host is never written");
	});

	test("append GITHUB_ENV and GITHUB_PATH to the ENVRC for the next bash step (#4588)", async () => {
		for (const name of ["first", "second"]) {
			const tool = join(fixture.workspace, name, "mytool");
			mkdirSync(dirname(tool), { recursive: true });
			writeFileSync(tool, `#!/bin/sh\necho ${name}\n`);
			chmodSync(tool, 0o755);
		}
		commitNodeAction(
			"acme/env-writer",
			script(
				'const fs = require("node:fs");',
				'fs.appendFileSync(process.env.GITHUB_ENV, "FROM_ACTION=hello world\\n");',
				'fs.appendFileSync(process.env.GITHUB_ENV, "QUOTES=it\'s \\"$HOME\\" `id` \\\\ done\\n");',
				'fs.appendFileSync(process.env.GITHUB_PATH, process.env.FIRST_DIR + "\\n" + process.env.SECOND_DIR + "\\n");',
			),
		);

		await runToSuccess("github.com/acme/env-writer@v1", {
			env: { FIRST_DIR: join(fixture.workspace, "first"), SECOND_DIR: join(fixture.workspace, "second") },
		});

		const output = await runBashStep(
			['set -a; . "$ENVRC"; set +a', 'printf "%s\\n" "$FROM_ACTION"', 'printf "%s\\n" "$QUOTES"', "mytool"].join(
				"\n",
			),
		);
		assert.deepEqual(output.trim().split(/\r?\n/), ["hello world", 'it\'s "$HOME" `id` \\ done', "second"]);
	});

	test("write multi-line GITHUB_ENV values and drop names that are not variable names (#4588)", async () => {
		const marker = join(fixture.root, "injected");
		commitNodeAction(
			"acme/multiline",
			script(
				'const fs = require("node:fs");',
				"fs.appendFileSync(process.env.GITHUB_ENV, [",
				'	"MULTI<<END_OF_VALUE",',
				'	"line one",',
				"	\"line two with 'quote' and $HOME\",",
				'	"END_OF_VALUE",',
				'	"AFTER=after-value",',
				'	"BAD NAME=1",',
				'	"EVIL;touch " + process.env.EVIL_MARKER + "=2",',
				'	"",',
				'].join("\\n"));',
			),
		);

		const logPath = await runToSuccess("github.com/acme/multiline@v1", { env: { EVIL_MARKER: marker } });

		const output = await runBashStep(
			['set -a; . "$ENVRC"; set +a', 'printf "%s\\n" "$MULTI"', 'printf "%s\\n" "$AFTER"'].join("\n"),
		);
		assert.deepEqual(output.trim().split(/\r?\n/), ["line one", "line two with 'quote' and $HOME", "after-value"]);
		assert.equal(existsSync(marker), false, "a malicious variable name must never run as bash");
		assert.ok(!readText(fixture.envrcPath).includes("EVIL"));
		assert.ok(readText(logPath).includes("malformed"));
	});

	test("run pre only when its pre-if holds (#4588)", async () => {
		commitRepository(
			"acme/conditional-pre",
			{
				"action.yml": yaml(
					"name: Conditional pre",
					"inputs:",
					"  with-pre:",
					"    default: 'no'",
					"runs:",
					"  using: node20",
					`  pre-if: ${expression("inputs.with-pre == 'yes'")}`,
					"  pre: pre.js",
					"  main: main.js",
				),
				"pre.js": 'require("node:fs").appendFileSync(process.env.RESULT_FILE, "pre\\n");\n',
				"main.js": 'require("node:fs").appendFileSync(process.env.RESULT_FILE, "main\\n");\n',
			},
			{ tag: "v1" },
		);

		await runToSuccess("github.com/acme/conditional-pre@v1");
		assert.deepEqual(resultLines(), ["main"]);

		await runToSuccess("github.com/acme/conditional-pre@v1", { inputs: { "with-pre": "yes" } });
		assert.deepEqual(resultLines(), ["main", "pre", "main"]);
	});

	test(
		"run under the node on the action's PATH when hosted by Bun, and report node-unavailable without one (#4588)",
		() => {
			commitNodeAction(
				"acme/node-probe",
				'require("node:fs").appendFileSync(process.env.RESULT_FILE, JSON.stringify({ bun: process.versions.bun ?? null }) + "\\n");\n',
			);
			const emptyBin = join(fixture.root, "empty-bin");
			mkdirSync(emptyBin);
			const probe = join(fixture.root, "probe.ts");
			const moduleUrl = (path: string) => pathToFileURL(join(import.meta.dirname, "..", "src", path)).href;
			writeFileSync(
				probe,
				script(
					`import { runAction } from ${JSON.stringify(moduleUrl("core/resume/blueprint/actions.ts"))};`,
					`import { openStepLog } from ${JSON.stringify(moduleUrl("core/resume/blueprint/process.ts"))};`,
					"const [logPath, cacheDir, workspace, envrcPath, results, nodeDirectory, emptyBin] = process.argv.slice(2);",
					"const location = { blueprint: 'blueprint.yaml', scope: 'global', section: 'initialize', index: 0, step: 'probe' };",
					"const log = await openStepLog(logPath);",
					"const outcome = {};",
					"for (const [name, path] of [['withNode', nodeDirectory], ['withoutNode', emptyBin]]) {",
					"	try {",
					"		const exit = await runAction({",
					"			step: { uses: 'github.com/acme/node-probe@v1', inputs: {} },",
					"			location, cwd: workspace, envrcPath, cacheDir, log, timeoutMs: 60000,",
					"			env: { PATH: path, RESULT_FILE: results },",
					"		});",
					"		outcome[name] = { exitStatus: exit.exitStatus };",
					"	} catch (error) {",
					"		outcome[name] = { code: error.code, reason: error.reason };",
					"	}",
					"}",
					"await log.close();",
					"console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', ...outcome }));",
				),
			);
			const logPath = join(fixture.logs, "bun-probe.log");

			const result = spawnSync(
				bunExecutable(),
				[
					probe,
					logPath,
					fixture.cacheDir,
					fixture.workspace,
					fixture.envrcPath,
					fixture.results,
					dirname(process.execPath),
					emptyBin,
				],
				{ env: process.env, encoding: "utf8", timeout: BUN_PROBE_TIMEOUT_MS },
			);

			assert.equal(result.status, 0, `${result.stderr}${existsSync(logPath) ? readText(logPath) : ""}`);
			assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").pop() ?? ""), {
				runtime: "bun",
				withNode: { exitStatus: 0 },
				withoutNode: { code: "blueprint-uses-unsupported", reason: "node-unavailable" },
			});
			assert.deepEqual(resultLines(), ['{"bun":null}']);
		},
		BUN_PROBE_TIMEOUT_MS,
	);
	test("return a failing exit instead of throwing, and a failing pre stops main (#4588)", async () => {
		commitRepository(
			"acme/failing",
			{
				"action.yml": yaml("name: Failing", "runs:", "  using: node20", "  pre: pre.js", "  main: main.js"),
				"pre.js": script('console.error("boom-on-stderr");', "process.exit(3);"),
				"main.js": 'require("node:fs").appendFileSync(process.env.RESULT_FILE, "main\\n");\n',
			},
			{ tag: "v1" },
		);

		const started = startRun("github.com/acme/failing@v1");
		const exit = await started.result;

		assert.equal(exit.exitStatus, 3);
		assert.equal(exit.timedOut, false);
		assert.equal(exit.signal, null);
		assert.equal(exit.spawnError, undefined);
		assert.deepEqual(resultLines(), []);
		assert.ok(readText(started.logPath).includes("boom-on-stderr"));
	});
});

describe("composite actions", () => {
	function commitToolkit(): void {
		commitRepository(
			"acme/tools",
			{
				"action.yml": yaml("name: Root", "runs:", "  using: node20", "  main: root.js"),
				"root.js": "process.exit(7);\n",
				"node-step/action.yml": yaml(
					"name: Node step",
					"inputs:",
					"  text:",
					"    required: true",
					"runs:",
					"  using: node20",
					"  main: main.js",
				),
				"node-step/main.js": script(
					'const fs = require("node:fs");',
					'fs.appendFileSync(process.env.RESULT_FILE, "node-step " + process.env.INPUT_TEXT + "\\n");',
					'fs.appendFileSync(process.env.GITHUB_OUTPUT, "echoed=" + process.env.INPUT_TEXT + "!\\n");',
				),
				"greet/action.yml": yaml(
					"name: Greet",
					"inputs:",
					"  who:",
					"    default: world",
					"  mode:",
					"    default: normal",
					"outputs:",
					"  message:",
					`    value: ${expression("steps.compose.outputs.message")}`,
					"runs:",
					"  using: composite",
					"  steps:",
					"    - id: compose",
					"      shell: bash",
					`      run: echo "message=hello-${expression("inputs.who")}" >> "$GITHUB_OUTPUT"`,
					"    - shell: bash",
					"      env:",
					`        MESSAGE: ${expression("steps.compose.outputs.message")}`,
					'      run: echo "step2 $MESSAGE $GITHUB_ACTION_REPOSITORY $GITHUB_ACTION_REF" >> "$RESULT_FILE"',
					`    - if: ${expression("inputs.mode == 'skip'")}`,
					"      shell: bash",
					'      run: echo "skip-mode-step" >> "$RESULT_FILE"',
					"    - if: inputs.mode != 'skip'",
					"      shell: sh",
					'      run: echo "conditional-step" >> "$RESULT_FILE"',
					"    - id: nested",
					"      uses: acme/tools/node-step@v1",
					"      with:",
					`        text: ${expression("steps.compose.outputs.message")}`,
					"    - shell: bash",
					`      run: echo "nested-output ${expression("steps.nested.outputs.echoed")}" >> "$RESULT_FILE"`,
					"    - shell: bash",
					`      working-directory: ${expression("github.action_path")}`,
					'      run: echo "COMPOSITE_VAR=from-composite" >> "$GITHUB_ENV"',
					"    - shell: bash",
					'      run: echo "later-step $COMPOSITE_VAR" >> "$RESULT_FILE"',
				),
				"wrapper/action.yml": yaml(
					"name: Wrapper",
					"runs:",
					"  using: composite",
					"  steps:",
					"    - id: inner",
					"      uses: github.com/acme/tools/greet@v1",
					"      with:",
					"        who: wrapper",
					"        mode: skip",
					"    - shell: bash",
					`      run: echo "inner-message ${expression("steps.inner.outputs.message")}" >> "$RESULT_FILE"`,
				),
			},
			{ tag: "v1" },
		);
	}

	test("run their steps in order with inputs, outputs, conditions and nested actions (#4588)", async () => {
		commitToolkit();

		await runToSuccess("github.com/acme/tools/greet@v1", { inputs: { who: "devin" } });

		assert.deepEqual(resultLines(), [
			"step2 hello-devin acme/tools v1",
			"conditional-step",
			"node-step hello-devin",
			"nested-output hello-devin!",
			"later-step from-composite",
		]);
		assert.ok(readText(fixture.envrcPath).includes("export COMPOSITE_VAR='from-composite'"));
	});

	test("pass a nested composite's outputs to the action that uses it (#4588)", async () => {
		commitToolkit();

		await runToSuccess("github.com/acme/tools/wrapper@v1");

		assert.deepEqual(resultLines(), [
			"step2 hello-wrapper acme/tools v1",
			"skip-mode-step",
			"node-step hello-wrapper",
			"nested-output hello-wrapper!",
			"later-step from-composite",
			"inner-message hello-wrapper",
		]);
	});

	test("apply what a step writes to GITHUB_ENV and GITHUB_PATH to the steps after it (#4588)", async () => {
		const tool = join(fixture.workspace, "bin", "mytool");
		mkdirSync(dirname(tool), { recursive: true });
		writeFileSync(tool, "#!/bin/sh\necho from-path-tool\n");
		chmodSync(tool, 0o755);
		commitRepository(
			"acme/propagate",
			{
				"action.yml": yaml(
					"name: Propagate",
					"runs:",
					"  using: composite",
					"  steps:",
					"    - shell: bash",
					"      run: |",
					'        echo "STEP_VAR=value-from-step-one" >> "$GITHUB_ENV"',
					`        echo "${expression("github.workspace")}/bin" >> "$GITHUB_PATH"`,
					"    - shell: bash",
					'      run: echo "$STEP_VAR $(mytool)" >> "$RESULT_FILE"',
				),
			},
			{ tag: "v1" },
		);

		await runToSuccess("github.com/acme/propagate@v1");

		assert.deepEqual(resultLines(), ["value-from-step-one from-path-tool"]);
	});

	test("stop at the first failing step except for always() and failure() steps (#4588)", async () => {
		commitRepository(
			"acme/stops",
			{
				"action.yml": yaml(
					"name: Stops",
					"runs:",
					"  using: composite",
					"  steps:",
					"    - shell: bash",
					"      run: exit 3",
					"    - shell: bash",
					'      run: echo "after-failure" >> "$RESULT_FILE"',
					"    - if: always()",
					"      shell: bash",
					'      run: echo "cleanup" >> "$RESULT_FILE"',
					"    - if: failure()",
					"      shell: bash",
					'      run: echo "failure-hook" >> "$RESULT_FILE"',
				),
			},
			{ tag: "v1" },
		);

		const exit = await startRun("github.com/acme/stops@v1").result;

		assert.equal(exit.exitStatus, 3);
		assert.deepEqual(resultLines(), ["cleanup", "failure-hook"]);
	});

	test("continue after a failing step marked continue-on-error (#4588)", async () => {
		commitRepository(
			"acme/tolerant",
			{
				"action.yml": yaml(
					"name: Tolerant",
					"runs:",
					"  using: composite",
					"  steps:",
					"    - shell: bash",
					"      continue-on-error: true",
					"      run: exit 4",
					"    - shell: bash",
					'      run: echo "kept-going" >> "$RESULT_FILE"',
				),
			},
			{ tag: "v1" },
		);

		await runToSuccess("github.com/acme/tolerant@v1");

		assert.deepEqual(resultLines(), ["kept-going"]);
	});

	test("select the action by subpath rather than the repository root (#4588)", async () => {
		commitToolkit();

		const exit = await startRun("github.com/acme/tools@v1").result;

		assert.equal(exit.exitStatus, 7, "the root action.yml is the one that runs without a subpath");
		assert.deepEqual(resultLines(), []);
	});
});

describe("actions that cannot run", () => {
	test("Docker actions fail with docker-action (#4588)", async () => {
		commitRepository(
			"acme/docker-tool",
			{
				"action.yml": yaml("name: Docker", "runs:", "  using: docker", "  image: Dockerfile"),
				Dockerfile: "FROM scratch\n",
			},
			{ tag: "v1" },
		);
		const uses = "github.com/acme/docker-tool@v1";

		await expectUnsupported(startRun(uses), uses, "docker-action");
	});

	test("a Docker action used by a composite action fails with docker-action (#4588)", async () => {
		commitRepository(
			"acme/uses-docker",
			{
				"action.yml": yaml(
					"name: Uses docker",
					"runs:",
					"  using: composite",
					"  steps:",
					"    - uses: docker://alpine:3",
				),
			},
			{ tag: "v1" },
		);
		const uses = "github.com/acme/uses-docker@v1";

		await expectUnsupported(startRun(uses), uses, "docker-action");
	});

	test("an unknown runs.using fails with unknown-action-type (#4588)", async () => {
		commitRepository(
			"acme/python-action",
			{ "action.yml": yaml("name: Python", "runs:", "  using: python3", "  main: main.py") },
			{ tag: "v1" },
		);
		const uses = "github.com/acme/python-action@v1";

		await expectUnsupported(startRun(uses), uses, "unknown-action-type");
	});

	test("a missing repository, ref, subpath or action.yml fails with action-not-found (#4588)", async () => {
		commitRepository("acme/no-metadata", { "README.md": "no action here\n" }, { tag: "v1" });
		commitNodeAction("acme/present", "process.exit(0);\n");

		for (const uses of [
			"github.com/acme/ghost@v1",
			"github.com/acme/present@v404",
			"github.com/acme/present/missing-directory@v1",
			"github.com/acme/no-metadata@v1",
		]) {
			await expectUnsupported(startRun(uses), uses, "action-not-found");
		}
	});

	test("an unreadable or invalid action.yml fails with action-metadata-invalid (#4588)", async () => {
		const broken: Record<string, string> = {
			"acme/not-yaml": "name: [unclosed\nruns: {\n",
			"acme/not-a-mapping": "- just\n- a list\n",
			"acme/no-runs": yaml("name: No runs"),
			"acme/no-main": yaml("name: No main", "runs:", "  using: node20"),
			"acme/no-shell": yaml("name: No shell", "runs:", "  using: composite", "  steps:", "    - run: echo hi"),
			"acme/run-and-uses": yaml(
				"name: Both",
				"runs:",
				"  using: composite",
				"  steps:",
				"    - shell: bash",
				"      run: echo hi",
				"      uses: acme/other@v1",
			),
		};
		for (const [slug, metadata] of Object.entries(broken)) {
			commitRepository(slug, { "action.yml": metadata }, { tag: "v1" });
			const uses = `github.com/${slug}@v1`;
			await expectUnsupported(startRun(uses), uses, "action-metadata-invalid");
		}
	});

	test("paths that leave the action directory fail with action-metadata-invalid before anything runs (#4588)", async () => {
		commitRepository(
			"acme/escape-main",
			{ "action.yml": yaml("name: Escape", "runs:", "  using: node20", "  main: ../../outside.js") },
			{ tag: "v1" },
		);
		commitRepository(
			"acme/escape-directory",
			{
				"action.yml": yaml(
					"name: Escape directory",
					"runs:",
					"  using: composite",
					"  steps:",
					"    - shell: bash",
					"      working-directory: ../../..",
					'      run: echo "ran" >> "$RESULT_FILE"',
				),
			},
			{ tag: "v1" },
		);
		let fetches = 0;
		const fetchAction: ActionFetcher = async () => {
			fetches++;
		};

		for (const uses of ["github.com/acme/escape-main@v1", "github.com/acme/escape-directory@v1"]) {
			await expectUnsupported(startRun(uses), uses, "action-metadata-invalid");
		}
		for (const uses of ["github.com/acme/tools/../escape@v1", "github.com/acme/tools//etc@v1"]) {
			await expectUnsupported(startRun(uses, { fetchAction }), uses, "action-metadata-invalid");
		}
		assert.equal(fetches, 0, "a subpath outside the repository is refused without fetching");
		assert.deepEqual(resultLines(), []);
	});

	test("a required input without a value or default fails with required-input-missing (#4588)", async () => {
		commitNodeAction("acme/needs-input", 'require("node:fs").appendFileSync(process.env.RESULT_FILE, "ran\\n");\n', [
			"  token:",
			"    required: true",
		]);
		const uses = "github.com/acme/needs-input@v1";

		await expectUnsupported(startRun(uses), uses, "required-input-missing");
		assert.deepEqual(resultLines(), []);

		await runToSuccess(uses, { inputs: { token: "provided" } });
		assert.deepEqual(resultLines(), ["ran"]);
	});

	test("composite expressions and shells it cannot evaluate fail with unsupported-expression (#4588)", async () => {
		const unsupported: Record<string, string[]> = {
			"acme/secrets": ["    - shell: bash", `      run: echo "${expression("secrets.TOKEN")}" >> "$RESULT_FILE"`],
			"acme/function": ["    - shell: bash", `      run: echo ${expression("hashFiles('**/package.json')")}`],
			"acme/condition": ["    - if: matrix.os == 'linux'", "      shell: bash", "      run: echo hi"],
			"acme/python-shell": ["    - shell: python", "      run: print('hi')"],
		};
		for (const [slug, steps] of Object.entries(unsupported)) {
			commitRepository(
				slug,
				{ "action.yml": yaml("name: Unsupported", "runs:", "  using: composite", "  steps:", ...steps) },
				{ tag: "v1" },
			);
			const uses = `github.com/${slug}@v1`;
			await expectUnsupported(startRun(uses), uses, "unsupported-expression");
		}
		assert.deepEqual(resultLines(), []);
	});

	test.skipIf(process.platform === "win32")(
		"PowerShell steps fail with unsupported-expression outside Windows (#4588)",
		async () => {
			commitRepository(
				"acme/pwsh",
				{
					"action.yml": yaml(
						"name: Pwsh",
						"runs:",
						"  using: composite",
						"  steps:",
						"    - shell: pwsh",
						"      run: Write-Output hi",
					),
				},
				{ tag: "v1" },
			);
			const uses = "github.com/acme/pwsh@v1";

			await expectUnsupported(startRun(uses), uses, "unsupported-expression");
		},
	);

	test("composite actions nested deeper than 10 levels fail with unsupported-expression (#4588)", async () => {
		commitRepository(
			"acme/loop",
			{
				"action.yml": yaml("name: Loop", "runs:", "  using: composite", "  steps:", "    - uses: acme/loop@v1"),
			},
			{ tag: "v1" },
		);
		const uses = "github.com/acme/loop@v1";

		await expectUnsupported(startRun(uses), uses, "unsupported-expression");
	});

	test("a failed fetch fails with action-fetch-failed, keeps its cause and leaves no cache entry (#4588)", async () => {
		const cause = new Error("the network is down");
		const fetchAction: ActionFetcher = async () => {
			throw cause;
		};
		const uses = "github.com/acme/offline@v1";

		const error = await expectUnsupported(startRun(uses, { fetchAction }), uses, "action-fetch-failed");

		assert.equal(error.cause, cause);
		assert.deepEqual(readdirSync(join(fixture.cacheDir, "acme", "offline")), []);
	});
});

describe("the action cache", () => {
	function copyingFetcher(calls: string[]): ActionFetcher {
		return async ({ owner, repo, ref, destination }) => {
			calls.push(`${owner}/${repo}@${ref}`);
			cpSync(join(fixture.sources, owner, `${repo}.git`), destination, {
				recursive: true,
				filter: (source) => basename(source) !== ".git",
			});
		};
	}

	test("fetches a ref once and reuses the cached checkout (#4588)", async () => {
		commitNodeAction("acme/cached", 'require("node:fs").appendFileSync(process.env.RESULT_FILE, "ran\\n");\n');
		const calls: string[] = [];
		const fetchAction = copyingFetcher(calls);

		await runToSuccess("github.com/acme/cached@v1", { fetchAction });
		await runToSuccess("github.com/acme/cached@v1", { fetchAction });
		assert.deepEqual(calls, ["acme/cached@v1"]);
		assert.deepEqual(resultLines(), ["ran", "ran"]);

		await runToSuccess("github.com/acme/cached@v2", { fetchAction });
		assert.deepEqual(calls, ["acme/cached@v1", "acme/cached@v2"]);
	});

	test("keeps one complete entry when two runs fetch the same ref at once (#4588)", async () => {
		commitNodeAction("acme/raced", 'require("node:fs").appendFileSync(process.env.RESULT_FILE, "ran\\n");\n');
		const calls: string[] = [];
		const copy = copyingFetcher(calls);
		let release!: () => void;
		const bothFetching = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		const fetchAction: ActionFetcher = async (request) => {
			await copy(request);
			if (calls.length === 2) release();
			await bothFetching;
		};

		await Promise.all([
			runToSuccess("github.com/acme/raced@v1", { fetchAction }),
			runToSuccess("github.com/acme/raced@v1", { fetchAction }),
		]);

		assert.equal(calls.length, 2);
		assert.deepEqual(readdirSync(join(fixture.cacheDir, "acme", "raced")), ["v1"]);
		assert.ok(existsSync(join(fixture.cacheDir, "acme", "raced", "v1", "action.yml")));
	});

	test("fetch a tag, a branch with a slash and a commit with git and cache each under a safe name (#4588)", async () => {
		const label = (value: string) => `require("node:fs").appendFileSync(process.env.RESULT_FILE, "${value}\\n");\n`;
		commitRepository("acme/versions", nodeAction(label("first")), { tag: "v1" });
		commitRepository("acme/versions", nodeAction(label("second")), { branch: "feature/x" });
		const sha = commitRepository("acme/versions", nodeAction(label("third")));

		for (const ref of ["v1", "feature/x", sha]) await runToSuccess(`github.com/acme/versions@${ref}`);

		assert.deepEqual(resultLines(), ["first", "second", "third"]);
		assert.deepEqual(
			readdirSync(join(fixture.cacheDir, "acme", "versions")).sort(),
			["feature%2Fx", sha, "v1"].sort(),
		);
		for (const entry of readdirSync(join(fixture.cacheDir, "acme", "versions"))) {
			assert.equal(existsSync(join(fixture.cacheDir, "acme", "versions", entry, ".git")), false);
		}
	});
});

describe("how an action ends", () => {
	const hang = script(
		'require("node:fs").writeFileSync(process.env.PID_FILE, String(process.pid));',
		"setInterval(() => {}, 1000);",
	);

	test("a hanging action returns timedOut and its process is gone (#4588)", async () => {
		commitNodeAction("acme/hang", hang);
		const pidFile = join(fixture.root, "hang.pid");

		const exit = await startRun("github.com/acme/hang@v1", { env: { PID_FILE: pidFile }, timeoutMs: HANG_TIMEOUT_MS })
			.result;

		assert.equal(exit.timedOut, true);
		assert.notEqual(exit.exitStatus, 0);
		assert.ok(existsSync(pidFile), "the action started before its budget ran out");
		assert.equal(isAlive(Number(readText(pidFile))), false);
	});

	test("aborting rejects with the signal's reason and stops the process (#4588)", async () => {
		commitNodeAction("acme/abortable", hang);
		const pidFile = join(fixture.root, "abort.pid");
		const reason = new Error("cancelled by the test");
		const controller = new AbortController();

		const started = startRun("github.com/acme/abortable@v1", {
			env: { PID_FILE: pidFile },
			signal: controller.signal,
		});
		await waitForFile(pidFile);
		controller.abort(reason);

		assert.equal(await rejectionOf(started.result), reason);
		assert.equal(isAlive(Number(readText(pidFile))), false);
	});

	test("an already aborted signal rejects before anything is fetched (#4588)", async () => {
		const reason = new Error("cancelled before start");
		let fetches = 0;
		const fetchAction: ActionFetcher = async () => {
			fetches++;
		};

		const rejection = await rejectionOf(
			startRun("github.com/acme/never@v1", { signal: AbortSignal.abort(reason), fetchAction }).result,
		);

		assert.equal(rejection, reason);
		assert.equal(fetches, 0);
	});
});

type Repositories = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** Puts the files of `repositories["<owner>/<repo>"]` into the checkout, without git or a network. */
function planted(repositories: Repositories, calls: string[] = []): ActionFetcher {
	return async ({ owner, repo, ref, destination }) => {
		calls.push(`${owner}/${repo}@${ref}`);
		const files = repositories[`${owner}/${repo}`];
		if (files === undefined) throw new Error(`no repository ${owner}/${repo} was planted`);
		writeFiles(destination, files);
	};
}

function compositeMetadata(steps: readonly string[], ...extra: readonly string[]): string {
	return yaml(
		"name: Fixture",
		...extra,
		"runs:",
		"  using: composite",
		...(steps.length === 0 ? ["  steps: []"] : ["  steps:", ...steps]),
	);
}

function note(text: string): string {
	return `echo "${text}" >> "$RESULT_FILE"`;
}

async function failureOf(
	slug: string,
	files: Readonly<Record<string, string>>,
	reason: BlueprintUsesUnsupportedReason,
	options: RunOptions = {},
	repositories: Repositories = {},
): Promise<BlueprintUsesUnsupportedError> {
	const uses = `github.com/${slug}@v1`;
	const fetchAction = planted({ ...repositories, [slug]: files });
	return expectUnsupported(startRun(uses, { fetchAction, ...options }), uses, reason);
}

describe("parseActionReference messages", () => {
	test("names at most 120 characters of what is not an action reference (#4588)", () => {
		const reference = `github.com/${"x".repeat(200)}`;

		assert.throws(
			() => parseActionReference(reference),
			(error: Error) =>
				error instanceof ActionReferenceError &&
				error.name === "ActionReferenceError" &&
				error.message ===
					`"${reference.slice(0, 120)}" is not an action reference: expected github.com/<owner>/<repo>[/<subpath>]@<ref>`,
		);
		assert.throws(
			() => parseActionReference("nope"),
			(error: Error) =>
				error.message === '"nope" is not an action reference: expected github.com/<owner>/<repo>[/<subpath>]@<ref>',
		);
	});

	test("rejects . and .. as a repository name (#4588)", () => {
		for (const uses of ["github.com/acme/.@v1", "github.com/acme/..@v1", "github.com/acme@v1", "github.com/@v1"]) {
			assert.throws(() => parseActionReference(uses), ActionReferenceError, uses);
		}
		assert.equal(parseActionReference("github.com/acme/.tools@v1").repo, ".tools");
	});
});

describe("action.yml validation", () => {
	const node = ["runs:", "  using: node20", "  main: main.js"];

	test("names the field that is wrong, as a typed error with the file name (#4588)", async () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			["name: [unclosed\nruns: {\n", "action.yml is not valid YAML"],
			["- just\n- a list\n", "action.yml: it is not a mapping"],
			[yaml("name: x"), "action.yml: runs is required"],
			[yaml("runs: text"), "action.yml: runs is required"],
			[yaml("runs:", "  main: main.js"), "action.yml: runs.using is required"],
			[yaml("runs:", "  using: [a]"), "action.yml: runs.using must be a string"],
			[yaml("runs:", "  using: node20"), "action.yml: runs.main is required"],
			[yaml("runs:", "  using: node20", "  main: [a]"), "action.yml: runs.main must be a string"],
			[yaml(...node, "  pre: [a]"), "action.yml: runs.pre must be a string"],
			[yaml(...node, "  pre-if: [a]"), "action.yml: runs.pre-if must be a string"],
			[yaml("inputs: [a]", ...node), "action.yml: inputs must be a mapping"],
			[yaml("inputs: text", ...node), "action.yml: inputs must be a mapping"],
			[yaml("inputs:", "  x:", "    default: [a]", ...node), "action.yml: inputs.x.default must be a string"],
			[yaml("runs:", "  using: composite"), "action.yml: runs.steps is required"],
			[yaml("runs:", "  using: composite", "  steps: text"), "action.yml: runs.steps is required"],
			[compositeMetadata(["    - text"]), "action.yml: runs.steps[0] must be a mapping"],
			[
				compositeMetadata(["    - shell: bash", "      run: a", "    - text"]),
				"action.yml: runs.steps[1] must be a mapping",
			],
			[compositeMetadata(["    - run: echo hi"]), "action.yml: runs.steps[0] needs a shell for its run"],
			[
				compositeMetadata(["    - shell: bash", "      run: x", "      uses: acme/other@v1"]),
				"action.yml: runs.steps[0] cannot have both run and uses",
			],
			[compositeMetadata(["    - name: nothing"]), "action.yml: runs.steps[0] needs run or uses"],
			[compositeMetadata(["    - id: [a]", "      run: x"]), "action.yml: runs.steps[0].id must be a string"],
			[compositeMetadata(["    - name: [a]", "      run: x"]), "action.yml: runs.steps[0].name must be a string"],
			[compositeMetadata(["    - if: [a]", "      run: x"]), "action.yml: runs.steps[0].if must be a string"],
			[
				compositeMetadata(["    - working-directory: [a]", "      run: x"]),
				"action.yml: runs.steps[0].working-directory must be a string",
			],
			[
				compositeMetadata(["    - continue-on-error: [a]", "      run: x"]),
				"action.yml: runs.steps[0].continue-on-error must be a string",
			],
			[compositeMetadata(["    - shell: bash", "      run: [a]"]), "action.yml: runs.steps[0].run must be a string"],
			[compositeMetadata(["    - uses: [a]"]), "action.yml: runs.steps[0].uses must be a string"],
			[compositeMetadata(["    - shell: [a]", "      run: x"]), "action.yml: runs.steps[0].shell must be a string"],
			[
				compositeMetadata(["    - shell: bash", "      run: x", "      env: [a]"]),
				"action.yml: runs.steps[0].env must be a mapping",
			],
			[
				compositeMetadata(["    - shell: bash", "      run: x", "      env:", "        A: [b]"]),
				"action.yml: runs.steps[0].env.A must be a string",
			],
			[
				compositeMetadata(["    - uses: acme/other@v1", "      with: [a]"]),
				"action.yml: runs.steps[0].with must be a mapping",
			],
			[
				compositeMetadata(["    - uses: acme/other@v1", "      with:", "        k: [a]"]),
				"action.yml: runs.steps[0].with.k must be a string",
			],
			[
				compositeMetadata(["    - shell: bash", "      run: x"], "outputs: [a]"),
				"action.yml: outputs must be a mapping",
			],
			[
				compositeMetadata(["    - shell: bash", "      run: x"], "outputs:", "  o:", "    value: [a]"),
				"action.yml: outputs.o.value must be a string",
			],
		];

		for (const [index, [metadata, detail]] of cases.entries()) {
			const error = await failureOf(`acme/invalid-${index}`, { "action.yml": metadata }, "action-metadata-invalid");
			assert.equal(error.detail, detail, metadata);
		}
	});

	test("reads action.yaml when there is no action.yml and prefers action.yml (#4588)", async () => {
		const marker = (text: string) => compositeMetadata(["    - shell: bash", `      run: ${note(text)}`]);
		const repositories: Repositories = {
			"acme/yaml-only": { "action.yaml": marker("from-yaml") },
			"acme/both": { "action.yml": marker("from-yml"), "action.yaml": marker("from-yaml") },
		};

		await runToSuccess("github.com/acme/yaml-only@v1", { fetchAction: planted(repositories) });
		await runToSuccess("github.com/acme/both@v1", { fetchAction: planted(repositories) });

		assert.deepEqual(resultLines(), ["from-yaml", "from-yml"]);
	});

	test("reports an action.yml that cannot be read, not one that is missing (#4588)", async () => {
		const error = await failureOf(
			"acme/unreadable",
			{ "action.yml/inside": "a directory" },
			"action-metadata-invalid",
		);

		assert.equal(error.detail, "action.yml cannot be read");
		assert.equal((error.cause as NodeJS.ErrnoException).code, "EISDIR");
	});

	test("treats a path through a file as a missing action.yml (#4588)", async () => {
		const uses = "github.com/acme/through-file/file.txt/inner@v1";
		const fetchAction = planted({ "acme/through-file": { "file.txt": "not a directory" } });

		const error = await expectUnsupported(startRun(uses, { fetchAction }), uses, "action-not-found");

		assert.equal(error.detail, "the repository has no action.yml at that path");
	});

	test("accepts empty values where a mapping is optional (#4588)", async () => {
		const repositories: Repositories = {
			"acme/inner": {
				"action.yml": compositeMetadata(
					["    - shell: bash", "      run: 'true'"],
					"inputs:",
					"  bare:",
					"outputs:",
					"  bare:",
					"  empty:",
					"    value:",
				),
			},
			"acme/nulls": {
				"action.yml": compositeMetadata(
					[
						"    - id: inner",
						"      name:",
						"      uses: acme/inner@v1",
						"      with:",
						"    - shell: bash",
						"      env:",
						"        EMPTY:",
						`        BARE: "[${expression("steps.inner.outputs.bare")}][${expression("steps.inner.outputs.empty")}]"`,
						`      run: echo "empty=[$\{EMPTY-unset}] bare=$BARE" >> "$RESULT_FILE"`,
					],
					"inputs:",
					"outputs:",
				),
			},
		};

		await runToSuccess("github.com/acme/nulls@v1", { fetchAction: planted(repositories) });

		assert.deepEqual(resultLines(), ["empty=[] bare=[][]"]);
	});
});

describe("action inputs", () => {
	test("require an input flagged required only when no value or default exists (#4588)", async () => {
		const cases: ReadonlyArray<readonly [string, boolean]> = [
			["true", true],
			['"True"', true],
			['"TRUE"', true],
			["false", false],
			['"false"', false],
			['"yes"', false],
			["1", false],
			["null", false],
		];
		for (const [index, [required, missing]] of cases.entries()) {
			const slug = `acme/required-${index}`;
			const files = { "action.yml": compositeMetadata([], "inputs:", "  x:", `    required: ${required}`) };
			const uses = `github.com/${slug}@v1`;
			const started = startRun(uses, { fetchAction: planted({ [slug]: files }) });

			if (missing)
				assert.equal(
					(await expectUnsupported(started, uses, "required-input-missing")).detail,
					'input "x" is required',
				);
			else assert.equal((await started.result).exitStatus, 0, `required: ${required}`);
		}
	});

	test("resolve to the declared name's case, to defaults evaluated as on a passing step, and to empty (#4588)", async () => {
		commitRepository(
			"acme/inputs",
			nodeAction(OBSERVE_ENVIRONMENT, [
				"  optional:",
				"  Mixed-Case:",
				"    default: from-default",
				"  Default-Passing:",
				`    default: ${expression("success()")}`,
				"  Default-Failing:",
				`    default: ${expression("failure()")}`,
				"  Stringy:",
				"    required: 'false'",
				"  Numeric:",
				"    default: 42",
				"  Flag:",
				"    default: true",
			]),
			{ tag: "v1" },
		);

		await runToSuccess("github.com/acme/inputs@v1", { inputs: { "mixed-case": "given", Extra: "kept" } });

		const seen = JSON.parse((resultLines()[0] ?? "").slice("main ".length)) as Record<string, string>;
		assert.equal(seen.INPUT_OPTIONAL, "");
		assert.equal(seen["INPUT_MIXED-CASE"], "given");
		assert.equal(seen["INPUT_DEFAULT-PASSING"], "true");
		assert.equal(seen["INPUT_DEFAULT-FAILING"], "false");
		assert.equal(seen.INPUT_STRINGY, "");
		assert.equal(seen.INPUT_NUMERIC, "42");
		assert.equal(seen.INPUT_FLAG, "true");
		assert.equal(seen.INPUT_EXTRA, "kept");
	});
});

describe("nested actions that fail", () => {
	const needsInput = (name: string) => ({
		"action.yml": compositeMetadata([], "inputs:", `  ${name}:`, "    required: true"),
	});
	const using = (reference: string) => ({
		"action.yml": compositeMetadata([`    - uses: ${reference}`]),
	});

	test("name the nested action in the detail, never the step's own action (#4588)", async () => {
		const repositories: Repositories = {
			"acme/tools": { "sub/action.yml": needsInput("needed")["action.yml"] },
			"acme/leaf": needsInput("needed"),
		};

		const sub = await failureOf(
			"acme/outer-sub",
			using("acme/tools/sub@v1"),
			"required-input-missing",
			{},
			repositories,
		);
		const leaf = await failureOf(
			"acme/outer-leaf",
			using("github.com/acme/leaf@v1"),
			"required-input-missing",
			{},
			repositories,
		);
		const own = await failureOf("acme/own", needsInput("needed"), "required-input-missing");

		assert.equal(sub.detail, 'github.com/acme/tools/sub@v1: input "needed" is required');
		assert.equal(leaf.detail, 'github.com/acme/leaf@v1: input "needed" is required');
		assert.equal(own.detail, 'input "needed" is required');
		assert.equal(sub.uses, "github.com/acme/outer-sub@v1");
	});

	test("keep at most 300 characters of the detail (#4588)", async () => {
		const longName = "n".repeat(300);
		const repositories: Repositories = { "acme/long": needsInput(longName) };

		const error = await failureOf(
			"acme/outer-long",
			using("acme/long@v1"),
			"required-input-missing",
			{},
			repositories,
		);

		assert.equal(error.detail.length, 300);
		assert.ok(error.detail.startsWith('github.com/acme/long@v1: input "nnnn'));
	});

	test("allow 10 levels of nesting and refuse the 11th (#4588)", async () => {
		const chain = (prefix: string, length: number): Repositories =>
			Object.fromEntries(
				Array.from({ length }, (_, level) => [
					`acme/${prefix}${level}`,
					level === length - 1 ? { "action.yml": compositeMetadata([]) } : using(`acme/${prefix}${level + 1}@v1`),
				]),
			);

		await runToSuccess("github.com/acme/ok0@v1", { fetchAction: planted(chain("ok", 11)) });
		const tooDeep = chain("deep", 12);
		const error = await failureOf("acme/deep0", tooDeep["acme/deep0"] ?? {}, "unsupported-expression", {}, tooDeep);

		assert.equal(error.detail, "github.com/acme/deep11@v1: actions are nested more than 10 deep");
	});

	test("explain why a nested reference is refused (#4588)", async () => {
		const cases: ReadonlyArray<readonly [string, BlueprintUsesUnsupportedReason, string]> = [
			["docker://alpine:3", "docker-action", "Docker actions are not supported"],
			["./local-action", "action-not-found", "local action paths are not supported"],
			["../parent-action", "action-not-found", "local action paths are not supported"],
			[".hidden", "action-not-found", "local action paths are not supported"],
			["/absolute/action", "action-not-found", "local action paths are not supported"],
			["acme", "action-not-found", '"acme" is not an action reference'],
			[
				`acme/${"y".repeat(100)}`,
				"action-not-found",
				`"${`acme/${"y".repeat(100)}`.slice(0, 80)}" is not an action reference`,
			],
		];
		for (const [index, [reference, reason, detail]] of cases.entries()) {
			const error = await failureOf(`acme/refuse-${index}`, using(reference), reason);
			assert.equal(error.detail, detail, reference);
		}
	});

	test("explain why an action of another kind cannot run (#4588)", async () => {
		const docker = await failureOf(
			"acme/docker-kind",
			{ "action.yml": yaml("runs:", "  using: DOCKER", "  image: x") },
			"docker-action",
		);
		const unknown = await failureOf(
			"acme/unknown-kind",
			{ "action.yml": yaml("runs:", `  using: ${"p".repeat(60)}`) },
			"unknown-action-type",
		);

		assert.equal(docker.detail, "Docker actions are not supported");
		assert.equal(unknown.detail, `runs.using "${"p".repeat(40)}" is not supported`);
	});

	test("explain why a path or a shell is refused (#4588)", async () => {
		const mainPath = (main: string) => ({ "action.yml": yaml("runs:", "  using: node20", `  main: ${main}`) });
		const stepAt = (...fields: string[]) => ({
			"action.yml": compositeMetadata(["    - shell: bash", ...fields, `      run: ${note("never")}`]),
		});
		for (const [index, main] of [
			"../outside.js",
			"..",
			"/etc/hosts",
			"'\\evil.js'",
			"'C:\\evil.js'",
			"'C:/evil.js'",
		].entries()) {
			const error = await failureOf(`acme/main-${index}`, mainPath(main), "action-metadata-invalid");
			assert.equal(error.detail, "runs.main leaves the action directory", main);
		}
		const pre = await failureOf(
			"acme/pre-path",
			{ "action.yml": yaml("runs:", "  using: node20", "  pre: ../pre.js", "  main: main.js") },
			"action-metadata-invalid",
		);
		const outside = await failureOf(
			"acme/directory-up",
			stepAt("      working-directory: .."),
			"action-metadata-invalid",
		);
		const shell = await failureOf(
			"acme/shell-kind",
			{ "action.yml": compositeMetadata([`    - shell: ${"z".repeat(60)}`, "      run: x"]) },
			"unsupported-expression",
		);

		assert.equal(pre.detail, "runs.pre leaves the action directory");
		assert.equal(outside.detail, "working-directory leaves the workspace and the action");
		assert.equal(shell.detail, `the shell "${"z".repeat(40)}" is not supported`);
		assert.deepEqual(resultLines(), []);
	});
});

describe("the GitHub context of an action", () => {
	const STUBBED = [
		"GITHUB_REPOSITORY",
		"GITHUB_REPOSITORY_OWNER",
		"GITHUB_SHA",
		"GITHUB_REF",
		"GITHUB_REF_NAME",
		"GITHUB_REF_TYPE",
		"GITHUB_EVENT_NAME",
		"GITHUB_RUN_ID",
		"GITHUB_RUN_NUMBER",
		"GITHUB_RUN_ATTEMPT",
		"GITHUB_ACTOR",
		"GITHUB_JOB",
		"GITHUB_WORKFLOW",
		"GITHUB_SERVER_URL",
		"GITHUB_API_URL",
		"GITHUB_GRAPHQL_URL",
	];
	const unset = Object.fromEntries(STUBBED.map((name) => [name, undefined]));
	const probes: ReadonlyArray<readonly [string, string]> = [
		["repository", "github.repository"],
		["owner", "github.repository_owner"],
		["sha", "github.sha"],
		["ref", "github.ref"],
		["ref_name", "github.ref_name"],
		["ref_type", "github.ref_type"],
		["event_name", "github.event_name"],
		["run_id", "github.run_id"],
		["run_number", "github.run_number"],
		["run_attempt", "github.run_attempt"],
		["actor", "github.actor"],
		["job", "github.job"],
		["workflow", "github.workflow"],
		["server_url", "github.server_url"],
		["api_url", "github.api_url"],
		["graphql_url", "github.graphql_url"],
		["token", "github.token"],
		["event", "github.event"],
		["workspace", "github.workspace"],
		["action_path", "github.action_path"],
		["action_repository", "github.action_repository"],
		["action_ref", "github.action_ref"],
		["runner_os", "runner.os"],
		["runner_arch", "runner.arch"],
		["runner_temp", "runner.temp"],
		["runner_tool_cache", "runner.tool_cache"],
		["env_ci", "env.CI"],
		["env_actions", "env.GITHUB_ACTIONS"],
		["env_host", "env.HOST_VALUE"],
		["env_workspace", "env.GITHUB_WORKSPACE"],
	];
	const printProbes = (reference: readonly (readonly [string, string])[]) =>
		compositeMetadata([
			"    - shell: bash",
			"      run: |",
			...reference.map(([name, source]) => `        echo "${name}=[${expression(source)}]" >> "$RESULT_FILE"`),
		]);

	test("holds the stand-ins of a workflow run unless the step's environment names the value (#4588)", async () => {
		const fetchAction = planted({ "acme/context": { "action.yml": printProbes(probes) } });

		await runToSuccess("github.com/acme/context@v1", {
			fetchAction,
			env: {
				...unset,
				GITHUB_REPOSITORY: "host/repo",
				GITHUB_ACTOR: "host-actor",
				CI: "0",
				GITHUB_WORKSPACE: "/elsewhere",
				RUNNER_TEMP: "/elsewhere/temp",
				HOST_VALUE: "from-host",
			},
		});

		const runnerOs = { linux: "Linux", darwin: "macOS", win32: "Windows" }[process.platform as string] ?? "Linux";
		const runnerArch =
			{ x64: "X64", arm64: "ARM64", ia32: "X86", arm: "ARM" }[process.arch as string] ?? process.arch;
		assert.deepEqual(resultLines(), [
			"repository=[host/repo]",
			"owner=[atomic]",
			"sha=[0000000000000000000000000000000000000000]",
			"ref=[refs/heads/main]",
			"ref_name=[main]",
			"ref_type=[branch]",
			"event_name=[workflow_dispatch]",
			"run_id=[1]",
			"run_number=[1]",
			"run_attempt=[1]",
			"actor=[host-actor]",
			"job=[blueprint]",
			"workflow=[blueprint]",
			"server_url=[https://github.com]",
			"api_url=[https://api.github.com]",
			"graphql_url=[https://api.github.com/graphql]",
			"token=[]",
			"event=[Object]",
			`workspace=[${fixture.workspace}]`,
			`action_path=[${join(fixture.cacheDir, "acme", "context", "v1")}]`,
			"action_repository=[acme/context]",
			"action_ref=[v1]",
			`runner_os=[${runnerOs}]`,
			`runner_arch=[${runnerArch}]`,
			`runner_temp=[${join(fixture.cacheDir, "_runner", "temp")}]`,
			`runner_tool_cache=[${join(fixture.cacheDir, "_runner", "tool")}]`,
			"env_ci=[true]",
			"env_actions=[true]",
			"env_host=[from-host]",
			`env_workspace=[${fixture.workspace}]`,
		]);
	});

	test("does not know the properties and contexts a workflow would add (#4588)", async () => {
		const unknown: ReadonlyArray<readonly [string, string]> = [
			["github.nothing", "unsupported property github.nothing"],
			["runner.name", "unsupported property runner.name"],
			["secrets.TOKEN", "unsupported context secrets"],
		];
		for (const [index, [source, problem]] of unknown.entries()) {
			const metadata = compositeMetadata(["    - shell: bash", `      run: echo ${expression(source)}`]);
			const error = await failureOf(`acme/unknown-${index}`, { "action.yml": metadata }, "unsupported-expression");
			assert.equal(error.detail, `${problem} in "${source}"`);
			assert.ok(error.cause instanceof ExpressionError);
		}
	});

	test("is the step's own environment inside an action a composite step uses (#4588)", async () => {
		const repositories: Repositories = {
			"acme/inner-context": {
				"action.yml": compositeMetadata([
					"    - shell: bash",
					"      run: |",
					`        echo "actor=[${expression("github.actor")}] env=[${expression("env.GITHUB_ACTOR")}] process=[$GITHUB_ACTOR]" >> "$RESULT_FILE"`,
					'        echo "action=[$GITHUB_ACTION_REPOSITORY@$GITHUB_ACTION_REF] path=[$GITHUB_ACTION_PATH]" >> "$RESULT_FILE"',
				]),
			},
			"acme/outer-context": {
				"action.yml": compositeMetadata([
					"    - uses: acme/inner-context@v1",
					"      env:",
					"        GITHUB_ACTOR: nested-actor",
				]),
			},
		};

		await runToSuccess("github.com/acme/outer-context@v1", {
			fetchAction: planted(repositories),
			env: { GITHUB_ACTOR: "host-actor" },
		});

		assert.deepEqual(resultLines(), [
			"actor=[nested-actor] env=[nested-actor] process=[nested-actor]",
			`action=[acme/inner-context@v1] path=[${join(fixture.cacheDir, "acme", "inner-context", "v1")}]`,
		]);
	});

	test("never reaches a step as a GITHUB_ENV the host defined, whatever its case (#4588)", async () => {
		const files = nodeAction(OBSERVE_ENVIRONMENT);
		const fetchAction = planted({ "acme/host-env": files });

		await runToSuccess("github.com/acme/host-env@v1", {
			fetchAction,
			env: {
				GITHUB_ENV: join(fixture.root, "host-env"),
				CI: "0",
				GITHUB_ACTIONS: "false",
				GITHUB_WORKSPACE: "/elsewhere",
			},
		});

		const seen = JSON.parse((resultLines()[0] ?? "").slice("main ".length)) as Record<string, string | boolean>;
		assert.equal(seen.CI, "true");
		assert.equal(seen.GITHUB_ACTIONS, "true");
		assert.equal(seen.GITHUB_WORKSPACE, fixture.workspace);
		assert.notEqual(seen.GITHUB_ENV, join(fixture.root, "host-env"));
	});
});

describe("how a composite action runs its steps", () => {
	test("titles each step in the log and keeps only steps with an id in the steps context (#4588)", async () => {
		const repositories: Repositories = {
			"acme/leaf": { "action.yml": compositeMetadata([]) },
			"acme/titles": {
				"action.yml": compositeMetadata([
					"    - name: Named step",
					"      shell: bash",
					`      run: ${note("one")}`,
					"    - id: ident",
					"      shell: bash",
					'      run: echo "k=v" >> "$GITHUB_OUTPUT"',
					"    - if: false",
					"      id: skipped",
					"      shell: bash",
					`      run: ${note("never")}`,
					"    - if: false",
					"      shell: bash",
					`      run: ${note("never")}`,
					"    - uses: acme/leaf@v1",
					"    - shell: bash",
					"      env:",
					`        STEPS: ${expression("toJSON(steps)")}`,
					`      run: printf '%s' "$STEPS" | tr -d '\\n ' >> "$RESULT_FILE"`,
				]),
			},
		};

		const logPath = await runToSuccess("github.com/acme/titles@v1", { fetchAction: planted(repositories) });

		assert.deepEqual(resultLines(), ["one", '{"ident":{"outputs":{"k":"v"}},"skipped":{"outputs":{}}}']);
		const log = readText(logPath);
		const label = "github.com/acme/titles@v1";
		for (const expected of [
			"=== Fetching github.com/acme/titles@v1 ===",
			"=== Fetching github.com/acme/leaf@v1 ===",
			`=== Step 1 of 6: Named step (${label}) ===\n$ ${note("one")}\n`,
			`=== Step 2 of 6: ident (${label}) ===\n`,
			`=== Step 3 of 6: skipped (${label}): skipped ===\n`,
			`=== Step 4 of 6: run (${label}): skipped ===\n`,
			`=== Step 5 of 6: uses (${label}) ===\nuses acme/leaf@v1\n`,
			`=== Step 6 of 6: run (${label}) ===\n`,
		]) {
			assert.ok(log.includes(expected), `${expected}\n--- in ---\n${log}`);
		}
		assert.ok(!log.includes("never"));
	});

	test("rejects reading what the steps context does not hold of a step (#4588)", async () => {
		const readsConclusion = (id: string, step: readonly string[]) =>
			compositeMetadata([
				`    - id: ${id}`,
				...step,
				"    - shell: bash",
				`      run: echo ${expression(`steps.${id}.conclusion`)}`,
			]);
		const skipped = await failureOf(
			"acme/read-skipped",
			{ "action.yml": readsConclusion("gone", ["      if: false", "      shell: bash", "      run: x"]) },
			"unsupported-expression",
		);
		const ran = await failureOf(
			"acme/read-ran",
			{ "action.yml": readsConclusion("done", ["      shell: bash", "      run: 'true'"]) },
			"unsupported-expression",
		);

		assert.equal(skipped.detail, 'unsupported property steps.gone.conclusion in "steps.gone.conclusion"');
		assert.equal(ran.detail, 'unsupported property steps.done.conclusion in "steps.done.conclusion"');
	});

	test("run each step in the working directory it names, else in the workspace (#4588)", async () => {
		mkdirSync(join(fixture.workspace, "sub"));
		mkdirSync(join(fixture.workspace, "other"));
		const printDirectory = 'basename "$PWD" >> "$RESULT_FILE"';
		const metadata = compositeMetadata([
			"    - shell: bash",
			`      run: ${printDirectory}`,
			"    - shell: bash",
			"      working-directory: sub",
			`      run: ${printDirectory}`,
			"    - shell: bash",
			`      working-directory: ${expression("github.workspace")}/other`,
			`      run: ${printDirectory}`,
		]);

		await runToSuccess("github.com/acme/directories@v1", {
			fetchAction: planted({ "acme/directories": { "action.yml": metadata } }),
		});

		assert.deepEqual(resultLines(), ["workspace", "sub", "other"]);
	});

	test("trim an evaluated shell name and accept any case of continue-on-error: true (#4588)", async () => {
		const metadata = compositeMetadata(
			[
				`    - shell: ${expression("inputs.shell")}`,
				`      continue-on-error: ${expression("inputs.tolerant")}`,
				"      run: exit 4",
				"    - shell: bash",
				`      run: ${note("kept-going")}`,
			],
			"inputs:",
			"  shell:",
			"  tolerant:",
		);

		const logPath = await runToSuccess("github.com/acme/tolerant-input@v1", {
			fetchAction: planted({ "acme/tolerant-input": { "action.yml": metadata } }),
			inputs: { shell: "  bash  ", tolerant: " True " },
		});

		assert.deepEqual(resultLines(), ["kept-going"]);
		assert.ok(
			readText(logPath).includes(
				"=== Step 1 of 2: run (github.com/acme/tolerant-input@v1): failed, continuing because of continue-on-error ===",
			),
		);
	});

	test("stop at a failing step unless continue-on-error says exactly true (#4588)", async () => {
		const cases: ReadonlyArray<readonly [string, boolean]> = [
			["true", true],
			["'TRUE'", true],
			["false", false],
			["yes", false],
			["'0'", false],
		];
		for (const [index, [value, tolerated]] of cases.entries()) {
			const slug = `acme/coe-${index}`;
			const metadata = compositeMetadata([
				"    - shell: bash",
				`      continue-on-error: ${value}`,
				"      run: exit 4",
				"    - shell: bash",
				`      run: ${note(`after-${index}`)}`,
			]);

			const exit = await startRun(`github.com/${slug}@v1`, {
				fetchAction: planted({ [slug]: { "action.yml": metadata } }),
			}).result;

			assert.equal(exit.exitStatus, tolerated ? 0 : 4, `continue-on-error: ${value}`);
		}
		assert.deepEqual(resultLines(), ["after-0", "after-1"]);
	});

	test("does not forgive a step that ran out of time, even with continue-on-error (#4588)", async () => {
		const metadata = compositeMetadata([
			"    - shell: bash",
			"      continue-on-error: true",
			"      run: sleep 60",
			"    - shell: bash",
			`      run: ${note("never")}`,
		]);

		const exit = await startRun("github.com/acme/slow@v1", {
			fetchAction: planted({ "acme/slow": { "action.yml": metadata } }),
			timeoutMs: SHORT_TIMEOUT_MS,
		}).result;

		assert.equal(exit.timedOut, true);
		assert.deepEqual(resultLines(), []);
	});

	test("evaluates outputs after the steps as of a passing run (#4588)", async () => {
		const repositories: Repositories = {
			"acme/producer": {
				"action.yml": compositeMetadata(
					["    - id: make", "      shell: bash", '      run: echo "v=val" >> "$GITHUB_OUTPUT"'],
					"outputs:",
					"  passing:",
					`    value: ${expression("success()")}`,
					"  joined:",
					`    value: ${expression("steps.make.outputs.v")}-end`,
				),
			},
			"acme/consumer": {
				"action.yml": compositeMetadata([
					"    - id: produced",
					"      uses: acme/producer@v1",
					"    - shell: bash",
					"      env:",
					`        PASSING: ${expression("steps.produced.outputs.passing")}`,
					`        JOINED: ${expression("steps.produced.outputs.joined")}`,
					'      run: echo "[$PASSING][$JOINED]" >> "$RESULT_FILE"',
				]),
			},
		};

		await runToSuccess("github.com/acme/consumer@v1", { fetchAction: planted(repositories) });

		assert.deepEqual(resultLines(), ["[true][val-end]"]);
	});
});

describe("the file commands of a step", () => {
	const FILE_COMMANDS = ["GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STATE", "GITHUB_STEP_SUMMARY"];
	const WATCHED = ["A", "B", "C", "E", "F", "OUT_A", "OUT_B", "PATH"];

	function filesAction(): Repositories {
		return {
			"acme/files": {
				"action.yml": compositeMetadata([
					"    - id: write",
					"      shell: bash",
					"      run: |",
					`        printf '%s' "$ENV_CONTENT" >> "$GITHUB_ENV"`,
					`        printf '%s' "$OUTPUT_CONTENT" >> "$GITHUB_OUTPUT"`,
					`        printf '%s' "$STATE_CONTENT" >> "$GITHUB_STATE"`,
					`        printf '%s' "$PATH_CONTENT" >> "$GITHUB_PATH"`,
					"    - shell: bash",
					"      env:",
					`        OUT_A: ${expression("steps.write.outputs.a")}`,
					`        OUT_B: ${expression("steps.write.outputs.b")}`,
					"      run: |",
					`        for name in ${WATCHED.join(" ")}; do`,
					`          printf '%s=[%s]\\n' "$name" "$(printf '%s' "\${!name-unset}" | tr '\\n\\r' '|~')" >> "$RESULT_FILE"`,
					"        done",
				]),
			},
		};
	}

	interface Written {
		readonly env?: string;
		readonly output?: string;
		readonly state?: string;
		readonly path?: string;
	}

	async function writeCommands(
		written: Written,
	): Promise<{ values: Record<string, string>; log: string; envrc: string }> {
		rmSync(fixture.results, { force: true });
		writeFileSync(fixture.envrcPath, "");
		const logPath = await runToSuccess("github.com/acme/files@v1", {
			fetchAction: planted(filesAction()),
			env: {
				ENV_CONTENT: written.env ?? "",
				OUTPUT_CONTENT: written.output ?? "",
				STATE_CONTENT: written.state ?? "",
				PATH_CONTENT: written.path ?? "",
				A: undefined,
				B: undefined,
				C: undefined,
				E: undefined,
				F: undefined,
			},
		});
		const values: Record<string, string> = {};
		for (const line of resultLines()) {
			const [name = "", ...rest] = line.split("=");
			values[name] = rest.join("=").slice(1, -1);
		}
		return { values, log: readText(logPath), envrc: readText(fixture.envrcPath) };
	}

	test("read CRLF line endings and heredoc values from GITHUB_ENV and GITHUB_OUTPUT (#4588)", async () => {
		const { values, log, envrc } = await writeCommands({
			env: "A=1\r\nB<<EOF\r\nline1\r\nline2\r\nEOF\r\n",
			output: "a=hello\r\nb<<X\r\nl1\r\nX\r\n",
		});

		assert.equal(values.A, "1");
		assert.equal(values.B, "line1|line2");
		assert.equal(values.OUT_A, "hello");
		assert.equal(values.OUT_B, "l1");
		assert.equal(envrc, "export A='1'\nexport B='line1\nline2'\n");
		assert.ok(!log.includes("malformed"), log);
	});

	test("tell a heredoc whose delimiter holds = from an assignment whose value holds << (#4588)", async () => {
		const { values, log } = await writeCommands({ env: "C<<D=1\nval\nD=1\nE=a<<b\n" });

		assert.equal(values.C, "val");
		assert.equal(values.E, "a<<b");
		assert.ok(!log.includes("malformed"), log);
	});

	test("skip one malformed line and keep the entries after it (#4588)", async () => {
		const { values, log } = await writeCommands({ env: "junk\nF=ok\n" });

		assert.equal(values.F, "ok");
		assert.ok(log.includes("ignored 1 malformed entries written to GITHUB_ENV, GITHUB_OUTPUT or GITHUB_STATE"), log);
	});

	test("count entries without a name before = or << as malformed (#4588)", async () => {
		const equalsFirst = await writeCommands({ output: "=orphan\na=kept\n" });
		const emptyName = await writeCommands({ output: "<<EOF\nv\nEOF\n" });

		assert.equal(equalsFirst.values.OUT_A, "kept");
		assert.ok(equalsFirst.log.includes("ignored 1 malformed entries"), equalsFirst.log);
		assert.ok(emptyName.log.includes("ignored 3 malformed entries"), emptyName.log);
	});

	test("count an unterminated heredoc as one malformed entry and ignore the rest (#4588)", async () => {
		const { values, log } = await writeCommands({ env: "B<<EOF\nnever closed\nC=swallowed\n" });

		assert.equal(values.B, "unset");
		assert.equal(values.C, "unset");
		assert.ok(log.includes("ignored 1 malformed entries"), log);
	});

	test("add the malformed entries of the three files (#4588)", async () => {
		const { log } = await writeCommands({ env: "bad name=1\n", output: "x\ny\n", state: "p\nq\nr\ns\n" });

		assert.ok(log.includes("ignored 7 malformed entries written to GITHUB_ENV, GITHUB_OUTPUT or GITHUB_STATE"), log);
	});

	test.skipIf(process.platform === "win32")(
		"put each GITHUB_PATH line first on PATH, trimmed and without blanks (#4588)",
		async () => {
			const { values, envrc } = await writeCommands({ path: "/first\r\n  \n\t/second  \n" });

			assert.ok(values.PATH?.startsWith(`/second${delimiter}/first${delimiter}`), values.PATH);
			assert.equal(envrc, `export PATH='/first':"$PATH"\nexport PATH='/second':"$PATH"\n`);
		},
	);

	test("leave the ENVRC untouched and the log silent when nothing was written (#4588)", async () => {
		const { values, log, envrc } = await writeCommands({});

		assert.equal(envrc, "");
		assert.equal(values.A, "unset");
		assert.ok(!log.includes("malformed"), log);
	});

	test("give each file command its own file in a directory under the runner temp (#4588)", async () => {
		const probe = script(
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			`const names = ${JSON.stringify(FILE_COMMANDS)};`,
			"const seen = Object.fromEntries(names.map((key) => {",
			"	const file = process.env[key];",
			"	return [key, { name: path.basename(file), parent: path.dirname(path.dirname(file)), mode: fs.statSync(file).mode & 0o777 }];",
			"}));",
			'fs.appendFileSync(process.env.RESULT_FILE, JSON.stringify(seen) + "\\n");',
		);

		await runToSuccess("github.com/acme/file-names@v1", {
			fetchAction: planted({ "acme/file-names": nodeAction(probe) }),
		});

		const seen = JSON.parse(resultLines()[0] ?? "") as Record<string, { name: string; parent: string; mode: number }>;
		const directory = join(fixture.cacheDir, "_runner", "temp", "_runner_file_commands");
		assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([key, value]) => [key, value.name])), {
			GITHUB_ENV: "set_env",
			GITHUB_PATH: "add_path",
			GITHUB_OUTPUT: "set_output",
			GITHUB_STATE: "save_state",
			GITHUB_STEP_SUMMARY: "step_summary",
		});
		for (const value of Object.values(seen)) {
			assert.equal(value.parent, directory);
			if (process.platform !== "win32") assert.equal(value.mode, 0o600);
		}
	});

	test("tolerate an action that deletes its file commands (#4588)", async () => {
		const probe = script(
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			"fs.rmSync(path.dirname(process.env.GITHUB_ENV), { recursive: true });",
		);

		const logPath = await runToSuccess("github.com/acme/deleter@v1", {
			fetchAction: planted({ "acme/deleter": nodeAction(probe) }),
		});

		assert.ok(!readText(logPath).includes("malformed"));
		assert.equal(readText(fixture.envrcPath), "");
	});
});

describe("the budget of a step", () => {
	test("is spent before a process starts when the deadline has already passed (#4588)", async () => {
		const started = 1_700_000_000_000;
		const timeoutMs = 5_000;
		let now = started;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const planting = planted({
			"acme/late": nodeAction(`require("node:fs").appendFileSync(process.env.RESULT_FILE, "ran\\n");\n`),
		});
		const fetchAction: ActionFetcher = async (request) => {
			await planting(request);
			now = started + timeoutMs;
		};

		try {
			const run = startRun("github.com/acme/late@v1", { fetchAction, timeoutMs });
			const exit = await run.result;

			assert.deepEqual(exit, { exitStatus: null, signal: null, timedOut: true, elapsedMs: timeoutMs });
			assert.deepEqual(resultLines(), []);
			assert.ok(!readText(run.logPath).includes("=== main of"));
		} finally {
			clock.mockRestore();
		}
	});
});

async function withEnvironment<T>(
	changes: Readonly<Record<string, string | undefined>>,
	run: () => Promise<T>,
): Promise<T> {
	const previous = Object.fromEntries(Object.keys(changes).map((name) => [name, process.env[name]]));
	const apply = (values: Readonly<Record<string, string | undefined>>) => {
		for (const [name, value] of Object.entries(values)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
	apply(changes);
	try {
		return await run();
	} finally {
		apply(previous);
	}
}

describe("fetching an action", () => {
	const emptyAction = (slug: string): Repositories => ({ [slug]: { "action.yml": compositeMetadata([]) } });

	test("hands the fetcher an empty staging directory beside the cache entry and the run's signal (#4588)", async () => {
		const requests: ActionFetchRequest[] = [];
		let listing: string[] = ["not listed"];
		const planting = planted(emptyAction("acme/request"));
		const fetchAction: ActionFetcher = async (request) => {
			requests.push(request);
			listing = readdirSync(request.destination);
			await planting(request);
		};
		const controller = new AbortController();

		await runToSuccess("github.com/acme/request@v1", { fetchAction, signal: controller.signal });

		assert.equal(requests.length, 1);
		const request = requests[0] as ActionFetchRequest;
		assert.deepEqual([request.owner, request.repo, request.ref], ["acme", "request", "v1"]);
		assert.equal(request.signal, controller.signal);
		assert.equal(dirname(request.destination), join(fixture.cacheDir, "acme", "request"));
		assert.match(
			basename(request.destination),
			/^\.fetch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		assert.deepEqual(listing, []);
		assert.deepEqual(readdirSync(join(fixture.cacheDir, "acme", "request")), ["v1"]);
	});

	test("logs whether the action was fetched or taken from the cache (#4588)", async () => {
		const fetchAction = planted(emptyAction("acme/logged"));

		const first = await runToSuccess("github.com/acme/logged@v1", { fetchAction });
		const second = await runToSuccess("github.com/acme/logged@v1", { fetchAction });

		assert.equal(readText(first), "=== Fetching github.com/acme/logged@v1 ===\n");
		assert.equal(readText(second), "=== Using the cached github.com/acme/logged@v1 ===\n");
	});

	test("caches a ref under its encoded name, never under one that climbs or hides (#4588)", async () => {
		const calls: string[] = [];
		const fetchAction = planted(emptyAction("acme/refs"), calls);

		for (const ref of [".hidden", "..", "v1.2", "a/b"])
			await runToSuccess(`github.com/acme/refs@${ref}`, { fetchAction });

		assert.deepEqual(calls, ["acme/refs@.hidden", "acme/refs@..", "acme/refs@v1.2", "acme/refs@a/b"]);
		assert.deepEqual(readdirSync(join(fixture.cacheDir, "acme", "refs")).sort(), [
			"%2E.",
			"%2Ehidden",
			"a%2Fb",
			"v1.2",
		]);
	});

	test("fails with action-fetch-failed when the fetcher fails, keeping its message out of the credentials (#4588)", async () => {
		const fetchAction: ActionFetcher = async () => {
			throw new Error("unable to access 'https://user:secret-token@example.test/acme/repo.git/': refused");
		};
		const uses = "github.com/acme/redact@v1";

		const started = startRun(uses, { fetchAction });
		const error = await expectUnsupported(started, uses, "action-fetch-failed");

		assert.equal(error.detail, "could not fetch acme/redact@v1");
		const log = readText(started.logPath);
		assert.ok(
			log.includes("could not fetch: unable to access 'https://example.test/acme/repo.git/': refused\n"),
			log,
		);
		assert.ok(!log.includes("secret-token"));
		assert.ok(!error.message.includes("secret-token"));
	});

	test.skipIf(process.platform === "win32")(
		"keeps the typed fetch failure when cleaning up the staged checkout fails too (#4588)",
		async () => {
			mkdirSync(fixture.cacheDir, { recursive: true });
			writeFileSync(join(fixture.cacheDir, "acme"), "a file where the owner directory should be");
			const fetchAction: ActionFetcher = async () => {};
			const uses = "github.com/acme/blocked@v1";

			const error = await expectUnsupported(startRun(uses, { fetchAction }), uses, "action-fetch-failed");

			const cleanup = (error as { cleanupCause?: NodeJS.ErrnoException }).cleanupCause;
			assert.equal(cleanup?.code, "ENOTDIR");
			assert.equal(Object.keys(error).includes("cleanupCause"), false);
		},
	);

	test("fails with action-fetch-failed when the staged checkout cannot be moved into the cache (#4588)", async () => {
		const fetchAction: ActionFetcher = async ({ destination }) => {
			rmSync(destination, { recursive: true });
		};
		const uses = "github.com/acme/unmovable@v1";

		const error = await expectUnsupported(startRun(uses, { fetchAction }), uses, "action-fetch-failed");

		assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOENT");
		assert.deepEqual(readdirSync(join(fixture.cacheDir, "acme", "unmovable")), []);
	});

	test.skipIf(process.platform === "win32")(
		"rejects with the file system's error when the cache cannot be read (#4588)",
		async () => {
			mkdirSync(join(fixture.cacheDir, "acme", "looping"), { recursive: true });
			symlinkSync("v1", join(fixture.cacheDir, "acme", "looping", "v1"));

			const rejection = await rejectionOf(
				startRun("github.com/acme/looping@v1", { fetchAction: planted(emptyAction("acme/looping")) }).result,
			);

			assert.equal((rejection as NodeJS.ErrnoException).code, "ELOOP");
		},
	);

	test("rejects with the signal's reason, not a fetch failure, when a fetch is aborted (#4588)", async () => {
		const reason = new Error("cancelled during the fetch");
		const controller = new AbortController();
		const fetchAction: ActionFetcher = async () => {
			controller.abort(reason);
			throw new Error("the fetch was interrupted");
		};

		const rejection = await rejectionOf(
			startRun("github.com/acme/aborted@v1", { fetchAction, signal: controller.signal }).result,
		);

		assert.equal(rejection, reason);
		assert.deepEqual(readdirSync(join(fixture.cacheDir, "acme", "aborted")), []);
	});
});

describe("fetching an action with git", () => {
	const gitEnvironment = () => ({
		GIT_CONFIG_GLOBAL: fixture.gitConfig,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_SSH_COMMAND: undefined,
		GIT_SSH: undefined,
	});

	test("names a missing repository or ref and keeps git's error as the cause (#4588)", async () => {
		commitNodeAction("acme/present", "process.exit(0);\n");
		const missing = ["github.com/acme/ghost@v1", "github.com/acme/present@v404"];

		for (const uses of missing) {
			const started = startRun(uses);
			const error = await expectUnsupported(started, uses, "action-not-found");
			const detail = `${uses.slice("github.com/".length)} does not exist`;

			assert.equal(error.detail, detail);
			assert.ok(readText(started.logPath).includes(`could not fetch: ${detail}\n`));
			const notFound = error.cause as Error;
			assert.equal(notFound.message, detail);
			assert.ok(isWorkspaceGitError(notFound.cause));
		}
		assert.deepEqual(readdirSync(join(fixture.cacheDir, "acme", "ghost")), []);
	});

	test("reports a git failure that is not a missing repository as action-fetch-failed (#4588)", async () => {
		const uses = "github.com/acme/unreachable@v1";

		const error = await withEnvironment(
			{ ...gitEnvironment(), [ACTIONS_GITHUB_BASE_URL_ENV]: "unknown-scheme://example.test" },
			() => expectUnsupported(startRun(uses), uses, "action-fetch-failed"),
		);

		assert.equal(error.detail, "could not fetch acme/unreachable@v1");
		assert.ok(isWorkspaceGitError(error.cause));
	});

	test.skipIf(process.platform === "win32")(
		"runs git in English, shallow, for one ref, without prompting, and checks out without conversions (#4588)",
		async () => {
			commitNodeAction("acme/git-probe", 'require("node:fs").appendFileSync(process.env.RESULT_FILE, "ran\\n");\n');
			const callLog = join(fixture.root, "git-calls.log");
			const wrapper = join(fixture.root, "git-wrapper");
			writeFileSync(
				wrapper,
				script(
					"#!/bin/sh",
					"{",
					`printf 'CALL LC_ALL=%s SSH=%s\\n' "$LC_ALL" "$GIT_SSH_COMMAND"`,
					`printf 'ARG %s\\n' "$@"`,
					`} >> ${shellQuote(callLog)}`,
					'exec git "$@"',
				),
			);
			chmodSync(wrapper, 0o755);
			const previousGit = setWorktreeSnapshotGit(async () => ({ path: wrapper, env: {} }));

			try {
				await withEnvironment(gitEnvironment(), () => runToSuccess("github.com/acme/git-probe@v1"));
			} finally {
				setWorktreeSnapshotGit(previousGit);
			}

			const calls = readText(callLog)
				.split(/^CALL /m)
				.filter((chunk) => chunk !== "")
				.map((chunk) => {
					const lines = chunk.split("\n");
					const [, language = "", ssh = ""] = /^LC_ALL=(.*?) SSH=(.*)$/.exec(lines[0] ?? "") ?? [];
					const args = lines.filter((line) => line.startsWith("ARG ")).map((line) => line.slice("ARG ".length));
					return { language, ssh, args };
				});
			assert.equal(calls.length, 4);
			const [init, config, fetch, checkout] = calls as [(typeof calls)[number], ...typeof calls];
			assert.deepEqual(init.args.slice(-2), ["init", "--quiet"]);
			assert.deepEqual(config.args.slice(-3), ["config", "--get", "core.sshCommand"]);
			assert.deepEqual(fetch.args.slice(-8), [
				"fetch",
				"--quiet",
				"--depth",
				"1",
				"--no-tags",
				"--",
				`${pathToFileURL(fixture.sources).href}/acme/git-probe.git`,
				"v1",
			]);
			assert.deepEqual(checkout?.args.slice(-4), ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
			for (const call of calls) assert.equal(call.language, "C");
			assert.equal(init.ssh, "");
			assert.ok(fetch.ssh.startsWith("ssh -o BatchMode=yes"), fetch.ssh);
			assert.ok(checkout?.args.includes("core.autocrlf=false"));
			assert.ok(!init.args.includes("core.autocrlf=false"));
			assert.ok(!fetch.args.includes("core.autocrlf=false"));
		},
	);

	test("fetches from https://github.com by default and ignores trailing slashes of a configured base (#4588)", async () => {
		commitNodeAction(
			"acme/default-base",
			'require("node:fs").appendFileSync(process.env.RESULT_FILE, "default\\n");\n',
		);
		commitNodeAction("acme/slashed", 'require("node:fs").appendFileSync(process.env.RESULT_FILE, "slashed\\n");\n');
		const sources = pathToFileURL(fixture.sources).href;
		writeFileSync(
			fixture.gitConfig,
			script(
				`[url "${sources}/acme/default-base.git"]`,
				"\tinsteadOf = https://github.com/acme/default-base.git",
				`[url "${sources}/acme/slashed.git"]`,
				"\tinsteadOf = https://actions.invalid/acme/slashed.git",
			),
		);

		await withEnvironment({ ...gitEnvironment(), [ACTIONS_GITHUB_BASE_URL_ENV]: undefined }, () =>
			runToSuccess("github.com/acme/default-base@v1"),
		);
		await withEnvironment({ ...gitEnvironment(), [ACTIONS_GITHUB_BASE_URL_ENV]: "https://actions.invalid///" }, () =>
			runToSuccess("github.com/acme/slashed@v1"),
		);

		assert.deepEqual(resultLines(), ["default", "slashed"]);
	});
});

async function withProcess<T>(overrides: { platform?: string; arch?: string }, run: () => Promise<T>): Promise<T> {
	const restores = Object.entries(overrides).map(([name, value]) => {
		const descriptor = Object.getOwnPropertyDescriptor(process, name) as PropertyDescriptor;
		Object.defineProperty(process, name, { ...descriptor, value });
		return () => Object.defineProperty(process, name, descriptor);
	});
	try {
		return await run();
	} finally {
		for (const restore of restores.reverse()) restore();
	}
}

describe("the platform an action believes it runs on", () => {
	const printRunner = (slug: string): Repositories => ({
		[slug]: {
			"action.yml": compositeMetadata([
				"    - shell: bash",
				`      run: echo "[${expression("runner.os")}][${expression("runner.arch")}][$RUNNER_OS][$RUNNER_ARCH]" >> "$RESULT_FILE"`,
			]),
		},
	});

	test.skipIf(process.platform === "win32")(
		"names the operating system and the architecture the way GitHub does (#4588)",
		async () => {
			const cases: ReadonlyArray<readonly [string, string, string, string]> = [
				["darwin", "arm64", "macOS", "ARM64"],
				["linux", "ia32", "Linux", "X86"],
				["freebsd", "arm", "Linux", "ARM"],
				["linux", "s390x", "Linux", "S390X"],
			];
			for (const [index, [platform, arch, os, architecture]] of cases.entries()) {
				const slug = `acme/runner-${index}`;
				await withProcess({ platform, arch }, () =>
					runToSuccess(`github.com/${slug}@v1`, { fetchAction: planted(printRunner(slug)) }),
				);
				assert.equal(resultLines().at(-1), `[${os}][${architecture}][${os}][${architecture}]`);
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"reports a bash step on Windows without bash as not started (#4588)",
		async () => {
			const metadata = compositeMetadata([
				"    - shell: bash",
				`      run: ${note("first")}`,
				"    - shell: bash",
				`      run: ${note("second")}`,
			]);

			const started = await withProcess({ platform: "win32" }, async () => {
				const run = startRun("github.com/acme/no-bash@v1", {
					fetchAction: planted({ "acme/no-bash": { "action.yml": metadata } }),
				});
				return { logPath: run.logPath, exit: await run.result };
			});

			assert.equal(started.exit.exitStatus, null);
			assert.equal(started.exit.signal, null);
			assert.equal(started.exit.timedOut, false);
			assert.ok(
				started.exit.spawnError?.message.startsWith("No bash shell found"),
				started.exit.spawnError?.message,
			);
			const log = readText(started.logPath);
			assert.ok(
				log.includes("=== Step 1 of 2: run (github.com/acme/no-bash@v1) ===\ncould not start: No bash shell found"),
				log,
			);
			assert.ok(
				!log.includes("Step 2 of 2: run (github.com/acme/no-bash@v1) ===\n"),
				"the step after a failure is skipped",
			);
			assert.deepEqual(resultLines(), []);
		},
	);

	test.skipIf(process.platform === "win32")(
		"reports a PowerShell step on Windows without PowerShell as not started (#4588)",
		async () => {
			const exits: ProcessExit[] = [];
			for (const shell of ["pwsh", "PowerShell"]) {
				const slug = `acme/no-${shell}`;
				const metadata = compositeMetadata([`    - shell: ${shell}`, "      run: Write-Output hi"]);
				exits.push(
					await withProcess(
						{ platform: "win32" },
						() =>
							startRun(`github.com/${slug}@v1`, { fetchAction: planted({ [slug]: { "action.yml": metadata } }) })
								.result,
					),
				);
			}

			for (const exit of exits) {
				assert.equal(exit.exitStatus, null);
				assert.ok(exit.spawnError?.message.startsWith("No PowerShell executable found"), exit.spawnError?.message);
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"refuses PowerShell steps outside Windows, whatever the case of the shell's name (#4588)",
		async () => {
			for (const [index, shell] of ["pwsh", "powershell", "PwSh", "PowerShell"].entries()) {
				const metadata = compositeMetadata([`    - shell: ${shell}`, "      run: Write-Output hi"]);
				const error = await failureOf(`acme/pwsh-${index}`, { "action.yml": metadata }, "unsupported-expression");

				assert.equal(error.detail, "PowerShell steps are only supported on Windows");
			}
		},
	);
});

describe("finding node for an action", () => {
	const probe = script(
		'const fs = require("node:fs");',
		"const seen = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|runner_os)$/i.test(key)));",
		'fs.appendFileSync(process.env.RESULT_FILE, JSON.stringify(seen) + "\\n");',
	);
	const preAndMain = (slug: string): Repositories => ({
		[slug]: {
			"action.yml": yaml("name: Probe", "runs:", "  using: node20", "  pre: pre.js", "  main: main.js"),
			"pre.js": 'require("node:fs").appendFileSync(process.env.GITHUB_PATH, "/added\\n");\n',
			"main.js": probe,
		},
	});
	const seenByMain = () => resultLines().map((line) => JSON.parse(line) as Record<string, string>);

	function programIn(directory: string, name: string): string {
		mkdirSync(directory, { recursive: true });
		const program = join(directory, name);
		symlinkSync(process.execPath, program);
		return program;
	}

	test.skipIf(process.platform === "win32")(
		"takes the first executable file called node on the search path (#4588)",
		() => {
			const real = programIn(join(fixture.root, "bin-real"), "node");
			const brokenDirectory = join(fixture.root, "bin-broken");
			mkdirSync(join(brokenDirectory, "node"), { recursive: true });
			const plain = join(fixture.root, "bin-plain");
			mkdirSync(plain);
			writeFileSync(join(plain, "node"), "not a program", { mode: 0o644 });
			const path = [brokenDirectory, plain, "", join(fixture.root, "bin-real")].join(delimiter);

			assert.equal(nodeExecutableFor({ PATH: path }, true, "linux"), real);
			assert.equal(findOnPath("node", { PATH: path }, "linux"), real);
			assert.equal(findOnPath("absent", { PATH: path }, "linux"), undefined);
			assert.throws(
				() => findOnPath("bad\0name", { PATH: path }, "linux"),
				(error: unknown) => (error as NodeJS.ErrnoException).code === "ERR_INVALID_ARG_VALUE",
			);
			assert.equal(nodeExecutableFor({ PATH: [brokenDirectory, plain].join(delimiter) }, true, "linux"), undefined);
			assert.equal(nodeExecutableFor({}, true, "linux"), undefined);
			assert.equal(
				nodeExecutableFor({ pAtH: path }, true, "linux"),
				undefined,
				"a PATH of another case is not PATH",
			);
		},
	);

	test.skipIf(process.platform === "win32")(
		"looks for node.exe on a Path variable of any case on Windows (#4588)",
		() => {
			const real = programIn(join(fixture.root, "bin-windows"), "node.exe");
			programIn(join(fixture.root, "bin-posix"), "node");

			assert.equal(nodeExecutableFor({ pAtH: join(fixture.root, "bin-windows") }, true, "win32"), real);
			assert.equal(nodeExecutableFor({ PATH: join(fixture.root, "bin-windows") }, true, "win32"), real);
			assert.equal(nodeExecutableFor({ pAtH: join(fixture.root, "bin-posix") }, true, "win32"), undefined);
			assert.equal(nodeExecutableFor({ pAtH: join(fixture.root, "bin-windows") }, true, "linux"), undefined);
		},
	);

	test("runs under the node that runs Atomic unless Bun hosts it (#4588)", () => {
		assert.equal(nodeExecutableFor({}, false, "linux"), process.execPath);
		assert.equal(nodeExecutableFor({}, false, "win32"), process.execPath);
	});

	test("runs a Node.js action under the node that runs Atomic, whatever the action's PATH holds (#4588)", async () => {
		const empty = join(fixture.root, "bin-empty");
		mkdirSync(empty);

		await runToSuccess("github.com/acme/own-node@v1", {
			fetchAction: planted(preAndMain("acme/own-node")),
			env: { PATH: empty },
		});

		assert.deepEqual(
			seenByMain().map((seen) => seen.PATH),
			[`/added${delimiter}${empty}`],
		);
	});

	test("names the search path variable PATH, or on Windows whichever case the environment uses (#4588)", () => {
		assert.equal(pathVariableName({ pAtH: "x", PATH: "y" }, "linux"), "PATH");
		assert.equal(pathVariableName({}, "darwin"), "PATH");
		assert.equal(pathVariableName({ OTHER: "x", pAtH: "y", Path: "z" }, "win32"), "pAtH");
		assert.equal(pathVariableName({ Path: "z" }, "win32"), "Path");
		assert.equal(pathVariableName({ OTHER: "x" }, "win32"), "Path");
		assert.equal(pathVariableName({}, "win32"), "Path");
	});

	test.skipIf(process.platform === "win32")(
		"adds GITHUB_PATH to PATH on this platform and to a Path variable of any case on Windows (#4588)",
		async () => {
			const fetchAction = planted(preAndMain("acme/path-names"));
			const cased = join(fixture.root, "cased");
			await runToSuccess("github.com/acme/path-names@v1", { fetchAction, env: { PATH: undefined, pAtH: cased } });
			await withProcess({ platform: "win32" }, () =>
				runToSuccess("github.com/acme/path-names@v1", { fetchAction, env: { PATH: undefined, pAtH: cased } }),
			);
			await withProcess({ platform: "win32" }, () =>
				runToSuccess("github.com/acme/path-names@v1", { fetchAction, env: { PATH: undefined } }),
			);

			assert.deepEqual(seenByMain(), [
				{ PATH: "/added", pAtH: cased, RUNNER_OS: process.platform === "darwin" ? "macOS" : "Linux" },
				{ pAtH: `/added${delimiter}${cased}`, RUNNER_OS: "Windows" },
				{ Path: "/added", RUNNER_OS: "Windows" },
			]);
		},
	);
});

describe("steps that name a shell", () => {
	test("run bash with pipefail and sh without it, and both stop at the first failing command (#4588)", async () => {
		const cases: ReadonlyArray<readonly [string, string, number, boolean]> = [
			["bash", "false | true", 1, false],
			["Bash", "false | true", 1, false],
			["sh", "false | true", 0, true],
			["bash", "false", 1, false],
			["sh", "false", 1, false],
			["bash", "true", 0, true],
		];
		for (const [index, [shell, command, status, reached]] of cases.entries()) {
			const slug = `acme/strict-${index}`;
			const metadata = compositeMetadata([
				`    - shell: ${shell}`,
				"      run: |",
				`        ${command}`,
				`        ${note(`reached-${index}`)}`,
			]);

			const exit = await startRun(`github.com/${slug}@v1`, {
				fetchAction: planted({ [slug]: { "action.yml": metadata } }),
			}).result;

			assert.equal(exit.exitStatus, status, `${shell}: ${command}`);
			assert.equal(resultLines().includes(`reached-${index}`), reached, `${shell}: ${command}`);
		}
	});

	test("builds the command line of each kind of shell (#4588)", () => {
		const script = "echo hi";
		const argv: ShellConfig = { shell: "/usr/bin/bash", args: ["-c"] };

		assert.deepEqual(bashInvocation(argv, "bash", script), {
			executable: "/usr/bin/bash",
			args: ["-c", "set -eo pipefail\necho hi"],
		});
		assert.deepEqual(bashInvocation(argv, "sh", script), {
			executable: "/usr/bin/bash",
			args: ["-c", "set -e\necho hi"],
		});
		assert.deepEqual(bashInvocation({ shell: "/usr/bin/BASH.EXE", args: ["-c"] }, "bash", script).args, [
			"-c",
			"set -eo pipefail\necho hi",
		]);
		assert.deepEqual(bashInvocation({ shell: "/usr/bin/mybash", args: ["-c"] }, "bash", script).args, [
			"-c",
			"set -e\necho hi",
		]);
		assert.deepEqual(bashInvocation({ shell: "sh", args: ["-c"] }, "bash", script), {
			executable: "sh",
			args: ["-c", "set -e\necho hi"],
		});
		assert.deepEqual(
			bashInvocation({ shell: "/bin/bash", args: ["-s"], commandTransport: "stdin" }, "bash", script),
			{
				executable: "/bin/bash",
				args: ["-s"],
				stdin: "set -eo pipefail\necho hi",
			},
		);
		assert.deepEqual(powerShellInvocation({ shell: "pwsh.exe", args: ["-NoProfile", "-Command"] }, script), {
			executable: "pwsh.exe",
			args: [
				"-NoProfile",
				"-Command",
				"$ErrorActionPreference = 'stop'\necho hi\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }",
			],
		});
	});
});

describe("steps that cannot even be named", () => {
	test("reject a step whose action is not an action reference, naming what it is (#4588)", async () => {
		const uses = "not an action";

		const error = await expectUnsupported(startRun(uses), uses, "action-not-found");

		assert.equal(
			error.detail,
			'"not an action" is not an action reference: expected github.com/<owner>/<repo>[/<subpath>]@<ref>',
		);
		assert.ok(error.cause instanceof ActionReferenceError);
	});

	test("refuse an action path outside the repository without fetching (#4588)", async () => {
		let fetches = 0;
		const fetchAction: ActionFetcher = async () => {
			fetches++;
		};

		for (const uses of ["github.com/acme/tools/../escape@v1", "github.com/acme/tools//etc@v1"]) {
			const error = await expectUnsupported(startRun(uses, { fetchAction }), uses, "action-metadata-invalid");
			assert.equal(error.detail, "the action path leaves the repository");
		}
		assert.equal(fetches, 0);
	});
});

describe("the log of a Node.js action", () => {
	test("shows the scripts it runs and the pre it skips (#4588)", async () => {
		const repositories: Repositories = {
			"acme/skippable": {
				"action.yml": yaml(
					"name: Skippable",
					"inputs:",
					"  go:",
					"    default: 'no'",
					"runs:",
					"  using: node20",
					`  pre-if: ${expression("inputs.go == 'yes'")}`,
					"  pre: scripts/pre.js",
					"  main: scripts/main.js",
				),
				"scripts/pre.js": "",
				"scripts/main.js": "",
			},
		};
		const fetchAction = planted(repositories);
		const label = "github.com/acme/skippable@v1";

		const skipped = readText(await runToSuccess("github.com/acme/skippable@v1", { fetchAction }));
		const ran = readText(await runToSuccess("github.com/acme/skippable@v1", { fetchAction, inputs: { go: "yes" } }));

		assert.equal(
			skipped,
			`=== Fetching ${label} ===\n=== Skipping pre of ${label}: its pre-if is false ===\n=== main of ${label} ===\n$ node scripts/main.js\n`,
		);
		assert.equal(
			ran,
			`=== Using the cached ${label} ===\n=== pre of ${label} ===\n$ node scripts/pre.js\n=== main of ${label} ===\n$ node scripts/main.js\n`,
		);
	});
});
