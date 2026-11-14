import assert from "node:assert/strict";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { ActionFetcher } from "../src/core/resume/blueprint/actions.ts";
import { bashPath, evaluateEnvrc } from "../src/core/resume/blueprint/envrc.ts";
import {
	type BlueprintSection,
	BlueprintStepFailedError,
	BlueprintStepTimedOutError,
	BlueprintUsesUnsupportedError,
} from "../src/core/resume/blueprint/errors.ts";
import {
	bashProcess,
	powerShellProcess,
	runSection,
	runsInPowerShell,
	type SectionResult,
	type StepContext,
} from "../src/core/resume/blueprint/steps.ts";
import type { RunStep, UsesStep } from "../src/core/resume/blueprint/types.ts";
import type { ShellConfig } from "../src/utils/shell.ts";
import { WORKING_DIRECTORY_COMMAND } from "./helpers/blueprint-fixtures.ts";
import { shellPath } from "./helpers/hook-commands.ts";

const STEP_TIMEOUT_MS = 60_000;
const PROCESS_START_WAIT_MS = 20_000;
const LOG_PREFIX = "20261109000000000-abcd1234-global";

let sandbox: string;

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "blueprint-steps-")));
	mkdirSync(path("repo"), { recursive: true });
	writeFileSync(path("build.envrc"), "");
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

const path = (...segments: string[]) => join(sandbox, ...segments);
const markers = () => path("markers.txt");
const results = () => path("results.txt");

/** The lines of `file`: bash ends them with LF, PowerShell's `Add-Content` with CRLF on Windows. */
/** A step log with its start and finish times and its duration, which differ per run, replaced by placeholders. */
function timesOmitted(log: string): string {
	return log
		.replace(/^# (started|finished): \d{4}-\d\d-\d\dT[\d:.]+Z$/gm, "# $1: <time>")
		.replace(/^# duration: \d+ ms$/m, "# duration: <ms>");
}

/** Asserts that a step's log ends with `line`, then when the step finished and how long it ran (#4748). */
function assertLogEnd(log: string, line: string | RegExp): void {
	const end = timesOmitted(log).endsWith("\n# finished: <time>\n# duration: <ms>\n");
	assert.ok(end, `log ends with its finish time and duration:\n${log}`);
	const before = log.slice(0, log.lastIndexOf("# finished: "));
	if (typeof line === "string") assert.ok(before.endsWith(`\n${line}\n`), before);
	else assert.match(before, line);
}

function lines(file: string): string[] {
	return existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean) : [];
}

function hostSystemEnvironment(): Record<string, string> {
	if (process.platform !== "win32") return {};
	const names = ["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "ProgramFiles"];
	return Object.fromEntries(
		names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
	);
}

function context(overrides: Partial<StepContext> = {}): StepContext {
	return {
		blueprint: path("repo", ".atomic", "blueprint.yaml"),
		scope: "repository",
		cwd: path("repo"),
		shell: "default",
		platform: "linux",
		envrcPath: path("build.envrc"),
		logDirectory: path("logs"),
		logPrefix: LOG_PREFIX,
		timeoutMs: STEP_TIMEOUT_MS,
		environment: {
			...hostSystemEnvironment(),
			PATH: process.env.PATH ?? "",
			HOME: sandbox,
			MARKERS: markers(),
			RESULT_FILE: results(),
		},
		actionsCacheDir: path("actions"),
		...overrides,
	};
}

function run(command: string, name?: string, env: Record<string, string> = {}): RunStep {
	return { kind: "run", name, run: command, env };
}

function uses(
	reference: string,
	name?: string,
	inputs: Record<string, string> = {},
	env: Record<string, string> = {},
): UsesStep {
	return { kind: "uses", name, uses: reference, with: inputs, env };
}

const logPathOf = (section: BlueprintSection, number: number) => path("logs", `${LOG_PREFIX}-${section}-${number}.log`);
const readLog = (section: BlueprintSection, number: number) => readFileSync(logPathOf(section, number), "utf8");

function failureOf(result: SectionResult) {
	assert.ok(result.failure !== undefined, "expected a failure");
	return result.failure;
}

async function waitFor(done: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + PROCESS_START_WAIT_MS;
	while (!done()) {
		assert.ok(Date.now() < deadline, `${what} never happened`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function lowestFreeDescriptor(): number {
	const descriptor = openSync(path("probe"), "w");
	closeSync(descriptor);
	return descriptor;
}

describe("a section's steps and their logs (#4588)", () => {
	test("every step gets its own log with the header, its output and its exit status (#4588)", async () => {
		const steps = [run("echo hello", "Say hello"), run("echo second")];
		const result = await runSection("maintenance", steps, context());
		assert.deepEqual(result, { completed: 2 });
		assert.equal(
			timesOmitted(readLog("maintenance", 1)),
			[
				"# started: <time>",
				`# blueprint: ${path("repo", ".atomic", "blueprint.yaml")}`,
				"# scope: repository",
				"# section: maintenance",
				"# step: Say hello (1/2)",
				`# cwd: ${path("repo")}`,
				"# command:",
				"echo hello",
				"# --- output ---",
				"hello",
				"",
				"# exit status 0",
				"# finished: <time>",
				"# duration: <ms>",
				"",
			].join("\n"),
		);
		assert.match(readLog("maintenance", 2), /^# step: maintenance step 2 \(2\/2\)$/m);
		assert.deepEqual(readdirSync(path("logs")).sort(), [
			`${LOG_PREFIX}-maintenance-1.log`,
			`${LOG_PREFIX}-maintenance-2.log`,
		]);
	});

	test("each section names its logs and its unnamed steps after itself (#4588)", async () => {
		for (const section of ["initialize", "maintenance", "post-build"] as const) {
			const scope = section === "post-build" ? "global" : "workspace";
			assert.deepEqual(await runSection(section, [run("echo x")], context({ scope })), { completed: 1 });
			const log = readLog(section, 1);
			assert.match(log, new RegExp(`^# scope: ${scope}$`, "m"));
			assert.match(log, new RegExp(`^# section: ${section}$`, "m"));
			assert.match(log, new RegExp(`^# step: ${section} step 1 \\(1/1\\)$`, "m"));
		}
	});

	test("an empty section completes nothing and creates no log (#4588)", async () => {
		assert.deepEqual(await runSection("initialize", [], context()), { completed: 0 });
		assert.equal(existsSync(path("logs")), false);
	});

	test("the first step that exits non-zero stops the section and is reported with its location and output (#4588)", async () => {
		const steps = [run("echo fine"), run('echo "oops" >&2\nexit 7', "Install"), run(`echo third >> "$MARKERS"`)];
		const result = await runSection("initialize", steps, context());
		assert.equal(result.completed, 1);
		const failure = failureOf(result);
		assert.ok(failure.error instanceof BlueprintStepFailedError);
		assert.deepEqual(
			{ ...failure.error.fields },
			{
				blueprint: path("repo", ".atomic", "blueprint.yaml"),
				scope: "repository",
				section: "initialize",
				index: 1,
				step: "Install",
				exitStatus: 7,
				signal: null,
				logPath: logPathOf("initialize", 2),
			},
		);
		assert.equal(failure.error.cause, undefined);
		assert.equal(failure.logPath, logPathOf("initialize", 2));
		assert.equal(failure.outputTail, readLog("initialize", 2));
		assertLogEnd(failure.outputTail, /\noops\n\n# exit status 7\n$/);
		assert.deepEqual(lines(markers()), []);
		assert.equal(existsSync(logPathOf("initialize", 3)), false);
	});

	test("a step stopped by a signal is a failure with the signal and no exit status (#4588)", async () => {
		const failure = failureOf(await runSection("maintenance", [run("kill -TERM $$")], context()));
		assert.ok(failure.error instanceof BlueprintStepFailedError);
		if (process.platform === "win32") {
			assert.equal(failure.error.signal, null);
			assert.ok(failure.error.exitStatus !== null && failure.error.exitStatus !== 0);
			assertLogEnd(failure.outputTail, /\n# exit status \d+\n$/);
			return;
		}
		assert.equal(failure.error.signal, "SIGTERM");
		assert.equal(failure.error.exitStatus, null);
		assertLogEnd(failure.outputTail, "# stopped by signal SIGTERM");
	});

	test("a step that cannot be started is a failure that keeps the spawn error as its cause (#4588)", async () => {
		const failure = failureOf(
			await runSection("maintenance", [run("echo never")], context({ cwd: path("no-such-directory") })),
		);
		assert.ok(failure.error instanceof BlueprintStepFailedError);
		assert.equal(failure.error.exitStatus, null);
		assert.equal(failure.error.signal, null);
		assert.ok(failure.error.cause instanceof Error);
		assert.equal((failure.error.cause as NodeJS.ErrnoException).code, "ENOENT");
		assertLogEnd(failure.outputTail, `# could not be started: ${failure.error.cause.message}`);
	});

	test("a step that outlives the timeout is stopped and reported as timed out in its section (#4588)", async () => {
		const result = await runSection(
			"post-build",
			[run(`echo started >> "$MARKERS"\nsleep 30\necho finished >> "$MARKERS"`, "Hang")],
			context({ timeoutMs: 400 }),
		);
		const failure = failureOf(result);
		assert.ok(failure.error instanceof BlueprintStepTimedOutError);
		const { elapsedMs, ...fields } = failure.error.fields;
		assert.deepEqual(fields, {
			blueprint: path("repo", ".atomic", "blueprint.yaml"),
			scope: "repository",
			section: "post-build",
			index: 0,
			step: "Hang",
			logPath: logPathOf("post-build", 1),
			timeoutMs: 400,
			phase: "post-build",
		});
		assert.ok(typeof elapsedMs === "number" && elapsedMs >= 300, `elapsed ${String(elapsedMs)} ms`);
		assertLogEnd(failure.outputTail, "# timed out after 400 ms and was stopped");
		assert.deepEqual(lines(markers()), ["started"]);
	});

	test("the log of every step is closed again, whether the step passed or failed (#4588)", async () => {
		const before = lowestFreeDescriptor();
		await runSection("maintenance", [run("echo 1"), run("echo 2"), run("echo 3"), run("exit 1")], context());
		assert.ok(lowestFreeDescriptor() <= before);
	});
});

describe("what a run step sees (#4588)", () => {
	test("it runs in the working directory with the context environment, its own variables and the ENVRC path (#4588)", async () => {
		writeFileSync(path("build.envrc"), "SHARED=from-envrc\nENVRC_ONLY=from-envrc\n");
		const script = [
			`echo "cwd $(${WORKING_DIRECTORY_COMMAND})" >> "$MARKERS"`,
			'echo "envrc $ENVRC" >> "$MARKERS"',
			'echo "context $FROM_CONTEXT" >> "$MARKERS"',
			'echo "step $FROM_STEP" >> "$MARKERS"',
			'echo "quoted $QUOTED" >> "$MARKERS"',
			'echo "shared $SHARED" >> "$MARKERS"',
			'echo "exported $(printenv ENVRC_ONLY)" >> "$MARKERS"',
			'LOCAL=1; printenv LOCAL || echo "local unexported" >> "$MARKERS"',
		].join("\n");
		const step = run(script, "Look around", {
			FROM_STEP: "step",
			QUOTED: `it's "$HOME" \`id\` \\ done`,
			SHARED: "step-wins",
		});
		const result = await runSection(
			"maintenance",
			[step],
			context({ environment: { ...context().environment, FROM_CONTEXT: "ctx" } }),
		);
		assert.deepEqual(result, { completed: 1 });
		assert.deepEqual(lines(markers()), [
			`cwd ${shellPath(path("repo"))}`,
			`envrc ${bashPath(path("build.envrc"))}`,
			"context ctx",
			"step step",
			`quoted it's "$HOME" \`id\` \\ done`,
			"shared step-wins",
			"exported from-envrc",
			"local unexported",
		]);
	});

	test("a powershell blueprint on Windows is not run in bash, and on another platform it is (#4588)", async () => {
		const step = run('echo ran >> "$MARKERS"');
		if (process.platform === "win32") {
			const inPowerShell = await runSection(
				"maintenance",
				[
					run(
						'Add-Content -LiteralPath $env:MARKERS -Value powershell; [IO.File]::AppendAllText($env:ENVRC, "FROM_POWERSHELL=yes`n")',
					),
				],
				context({ shell: "powershell", platform: "windows" }),
			);
			assert.deepEqual(inPowerShell, { completed: 1 });
			assert.deepEqual(lines(markers()), ["powershell"]);
			assert.equal(readFileSync(path("build.envrc"), "utf8"), "FROM_POWERSHELL=yes\n");
		} else {
			const onWindows = await runSection(
				"maintenance",
				[step],
				context({ shell: "powershell", platform: "windows" }),
			);
			assert.equal(onWindows.completed, 0);
			assert.ok(onWindows.failure !== undefined);
			assert.deepEqual(lines(markers()), []);
		}
		const elsewhere = await runSection(
			"maintenance",
			[step],
			context({ shell: "powershell", platform: "linux", logPrefix: "elsewhere" }),
		);
		assert.deepEqual(elsewhere, { completed: 1 });
		assert.deepEqual(lines(markers()), process.platform === "win32" ? ["powershell", "ran"] : ["ran"]);
	});

	test("a missing ENVRC file is no obstacle (#4588)", async () => {
		rmSync(path("build.envrc"));
		assert.deepEqual(await runSection("maintenance", [run(`echo ok >> "$MARKERS"`)], context()), { completed: 1 });
		assert.deepEqual(lines(markers()), ["ok"]);
	});
});

describe("cancelling a section (#4588)", () => {
	test("an aborted signal rejects with its reason before any step starts (#4588)", async () => {
		const reason = new Error("resume cancelled");
		await assert.rejects(
			runSection("maintenance", [run("echo never")], context({ signal: AbortSignal.abort(reason) })),
			(error: unknown) => error === reason,
		);
		assert.equal(existsSync(path("logs")), false);
	});

	test("aborting while a step runs rejects with the reason, leaves the step's log unfinished and skips the rest (#4588)", async () => {
		const controller = new AbortController();
		const reason = new Error("resume cancelled");
		const pending = runSection(
			"initialize",
			[run(`echo started >> "$MARKERS"\nsleep 30`), run(`echo second >> "$MARKERS"`)],
			context({ signal: controller.signal }),
		);
		await waitFor(() => lines(markers()).length > 0, "the first step starting");
		controller.abort(reason);
		await assert.rejects(pending, (error: unknown) => error === reason);
		assert.doesNotMatch(readLog("initialize", 1), /# (exit status|stopped by signal|failed|timed out|could not)/);
		assert.deepEqual(lines(markers()), ["started"]);
		assert.equal(existsSync(logPathOf("initialize", 2)), false);
	});
});

describe("uses steps (#4588)", () => {
	function fetcher(calls: string[], files: Record<string, string>): ActionFetcher {
		return async ({ owner, repo, ref, destination }) => {
			calls.push(`${owner}/${repo}@${ref} -> ${destination}`);
			for (const [name, content] of Object.entries(files)) {
				mkdirSync(dirname(join(destination, name)), { recursive: true });
				writeFileSync(join(destination, name), content);
			}
		};
	}

	const action = (main: string): Record<string, string> => ({
		"action.yml": [
			"name: Fixture",
			"inputs:",
			"  greeting:",
			"    required: true",
			"runs:",
			"  using: node20",
			"  main: main.js",
			"",
		].join("\n"),
		"main.js": main,
	});

	test("a uses step runs its action with the inputs, the evaluated ENVRC and its own env, and logs its command (#4588)", async () => {
		writeFileSync(path("build.envrc"), "FROM_ENVRC=envrc\nSHARED=envrc\n");
		const main = [
			'const fs = require("node:fs");',
			"const seen = {",
			"  input: process.env.INPUT_GREETING, step: process.env.FROM_STEP, shared: process.env.SHARED,",
			"  envrc: process.env.FROM_ENVRC, context: process.env.FROM_CONTEXT, workspace: process.env.GITHUB_WORKSPACE,",
			"};",
			'fs.appendFileSync(process.env.RESULT_FILE, JSON.stringify(seen) + "\\n");',
			'fs.appendFileSync(process.env.GITHUB_ENV, "EXPORTED=from-action\\n");',
		].join("\n");
		const calls: string[] = [];
		const step = uses(
			"github.com/acme/hello@v1",
			"Use it",
			{ greeting: "hello" },
			{ FROM_STEP: "step", SHARED: "step-wins" },
		);
		const result = await runSection(
			"initialize",
			[run("echo before"), step],
			context({
				environment: { ...context().environment, FROM_CONTEXT: "ctx" },
				fetchAction: fetcher(calls, action(main)),
			}),
		);
		assert.deepEqual(result, { completed: 2 });
		assert.deepEqual(
			lines(results()).map((line) => JSON.parse(line)),
			[
				{
					input: "hello",
					step: "step",
					shared: "step-wins",
					envrc: "envrc",
					context: "ctx",
					workspace: path("repo"),
				},
			],
		);
		assert.equal(calls.length, 1);
		assert.ok(calls[0]?.startsWith("acme/hello@v1 -> "));
		assert.ok(calls[0]?.includes(path("actions")));
		const log = readLog("initialize", 2);
		assert.ok(
			timesOmitted(log).startsWith(
				`# started: <time>\n# blueprint: ${path("repo", ".atomic", "blueprint.yaml")}\n# scope: repository\n`,
			),
		);
		assert.ok(log.includes("# step: Use it (2/2)\n"));
		assert.ok(log.includes(`# cwd: ${path("repo")}\n# command:\nuses github.com/acme/hello@v1\n# --- output ---\n`));
		assertLogEnd(log, "# exit status 0");
		const exported = await evaluateEnvrc(path("build.envrc"), process.env);
		assert.equal(exported.EXPORTED, "from-action");
	});

	test("a uses step that cannot run is a typed failure with its location and the cause, and its log says why (#4588)", async () => {
		const cause = new Error("the network is down");
		const fetchAction: ActionFetcher = async () => {
			throw cause;
		};
		const reference = "github.com/acme/offline@v1";
		for (const signal of [undefined, new AbortController().signal]) {
			const result = await runSection(
				"initialize",
				[run("echo before"), uses(reference, "Fetch tool")],
				context({ fetchAction, signal }),
			);
			assert.equal(result.completed, 1);
			const failure = failureOf(result);
			assert.ok(failure.error instanceof BlueprintUsesUnsupportedError);
			assert.deepEqual(
				{ ...failure.error.fields },
				{
					blueprint: path("repo", ".atomic", "blueprint.yaml"),
					scope: "repository",
					section: "initialize",
					index: 1,
					step: "Fetch tool",
					uses: reference,
					reason: "action-fetch-failed",
					detail: failure.error.detail,
					logPath: logPathOf("initialize", 2),
				},
			);
			assert.equal(failure.error.cause, cause);
			assert.equal(failure.logPath, logPathOf("initialize", 2));
			assert.ok(readLog("initialize", 2).includes(`\n# failed: ${failure.error.message}\n`));
		}
	});

	test("a uses step whose ENVRC cannot be sourced is a step failure that keeps the cause and logs it (#4588)", async () => {
		writeFileSync(path("build.envrc"), "echo boom >&2\nexit 3\n");
		const result = await runSection("maintenance", [uses("github.com/acme/never@v1")], context());
		const failure = failureOf(result);
		assert.ok(failure.error instanceof BlueprintStepFailedError);
		assert.deepEqual(
			{ ...failure.error.fields },
			{
				blueprint: path("repo", ".atomic", "blueprint.yaml"),
				scope: "repository",
				section: "maintenance",
				index: 0,
				step: "maintenance step 1",
				exitStatus: null,
				signal: null,
				logPath: logPathOf("maintenance", 1),
			},
		);
		assert.ok(failure.error.cause instanceof Error);
		assert.equal(failure.error.cause.message, "Sourcing the ENVRC file failed with status 3: boom");
		assertLogEnd(failure.outputTail, "# failed: Sourcing the ENVRC file failed with status 3: boom");
	});
});

describe("which shell runs a step (#4588)", () => {
	const step = run("echo hi", "Greet", { A: "1", ENVRC: "step-value" });

	test("only a powershell blueprint on Windows goes to PowerShell (#4588)", () => {
		assert.equal(runsInPowerShell("powershell", "windows"), true);
		assert.equal(runsInPowerShell("powershell", "linux"), false);
		assert.equal(runsInPowerShell("powershell", "macos"), false);
		assert.equal(runsInPowerShell("default", "windows"), false);
		assert.equal(runsInPowerShell("default", "linux"), false);
	});

	test("the PowerShell process stops on errors, runs in the working directory and its ENVRC wins over the step env (#4588)", () => {
		const powerShell = { shell: "pwsh.exe", args: ["-NoProfile", "-Command"] };
		const evaluated = { BASE: "evaluated", A: "evaluated" };
		const envrcPath = "C:\\build\\envrc";
		assert.deepEqual(
			powerShellProcess(run("Write-Output 'hi'", "Greet", step.env), context({ envrcPath }), powerShell, evaluated),
			{
				command: "pwsh.exe",
				args: ["-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; Write-Output 'hi'"],
				cwd: path("repo"),
				env: { BASE: "evaluated", A: "1", ENVRC: envrcPath },
			},
		);
	});

	test("the bash process takes its script as the last argument and sources the ENVRC before the step's variables (#4588)", () => {
		const script = [
			"set -a",
			'[ -f "$ENVRC" ] && . "$ENVRC"',
			"set +a",
			"export A='1'",
			"export ENVRC='step-value'",
			"set -e",
			"echo hi",
			"",
		].join("\n");
		assert.deepEqual(bashProcess(step, context(), { shell: "/bin/bash", args: ["-c"] }), {
			command: "/bin/bash",
			args: ["-c", script],
			cwd: path("repo"),
			env: { ...context().environment, A: "1", ENVRC: bashPath(path("build.envrc")) },
		});
	});

	test("a bash that cannot take its command as an argument gets the script on stdin (#4588)", () => {
		const legacy: ShellConfig = { shell: "C:\\Windows\\System32\\bash.exe", args: ["-s"], commandTransport: "stdin" };
		const legacyProcess = bashProcess(run("echo hi"), context(), legacy);
		assert.equal(legacyProcess.command, legacy.shell);
		assert.deepEqual(legacyProcess.args, ["-s"]);
		assert.equal(legacyProcess.stdin, 'set -a\n[ -f "$ENVRC" ] && . "$ENVRC"\nset +a\nset -e\necho hi\n');
		const argv = bashProcess(run("echo hi"), context(), {
			shell: "/bin/bash",
			args: ["-c"],
			commandTransport: "argv",
		});
		assert.equal("stdin" in argv, false);
		assert.equal(argv.args.length, 2);
	});
});
