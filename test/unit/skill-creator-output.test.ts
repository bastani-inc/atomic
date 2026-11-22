import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";
import {
	createScriptSandbox,
	python,
	pyyaml,
	pyyamlRequired,
	type ScriptSandbox,
	skillCreatorDir,
} from "../helpers/skill-creator-scripts.js";

// Python writes to a pipe or a file in the locale's encoding, which on Windows is the ANSI code page: cp1252 here.
const ANSI_PIPE = { PYTHONIOENCODING: "cp1252" };
// Outside Windows' ANSI code page.
const WIDE = "\u2713 \u65e5\u672c";

const sandboxes: ScriptSandbox[] = [];
afterEach(() => {
	for (const sandbox of sandboxes.splice(0)) removeTempDirectory(sandbox.dir);
});

function sandbox(): ScriptSandbox {
	const created = createScriptSandbox("skill-creator-output-");
	sandboxes.push(created);
	return created;
}

function runScript(box: ScriptSandbox, script: string, args: readonly string[], env: Record<string, string> = {}) {
	const result = spawnSyncCollect([python ?? "python3", join(skillCreatorDir, "scripts", script), ...args], {
		cwd: box.project,
		env: box.env(env),
	});
	// A decoder that fails on anything but UTF-8: the output must be UTF-8 to read back exactly. Windows ends lines with CRLF.
	const decode = (bytes: Uint8Array) =>
		new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n");
	return { exitCode: result.exitCode, stdout: decode(result.stdout), stderr: decode(result.stderr) };
}

/** An iteration folder with one graded run per configuration, under a folder named `name`. */
function benchmarkFolder(box: ScriptSandbox, name: string): string {
	const iteration = join(box.dir, name);
	for (const config of ["with_skill", "without_skill"]) {
		const run = join(iteration, "eval-0", config, "run-1");
		mkdirSync(run, { recursive: true });
		writeFileSync(
			join(run, "grading.json"),
			JSON.stringify({
				summary: { pass_rate: 1, passed: 1, failed: 0, total: 1 },
				expectations: [{ text: "has a title", passed: true, evidence: "it does" }],
			}),
		);
	}
	return iteration;
}

/** run_loop's output for one iteration with one query, written to a file. */
function loopOutput(box: ScriptSandbox): string {
	const path = join(box.dir, "loop.json");
	const result = { query: `make a report ${WIDE}`, should_trigger: true, pass: true, triggers: 1, runs: 1 };
	const iteration = { iteration: 1, description: `Use for reports ${WIDE}`, train_passed: 1, train_total: 1 };
	writeFileSync(
		path,
		JSON.stringify({ holdout: 0, history: [{ ...iteration, train_results: [result], test_results: null }] }),
	);
	return path;
}

test.runIf(pyyamlRequired)("Python and PyYAML are installed for the tests that need them, as CI provides them", () => {
	assert.ok(python, "no Python 3.10 or later on PATH");
	assert.ok(pyyaml, `${python} cannot import PyYAML with the scripts' environment`);
});

describe.skipIf(python === undefined)("skill-creator scripts' output", () => {
	test("aggregate_benchmark writes its output as UTF-8 to a pipe in Windows' ANSI code page", () => {
		const box = sandbox();
		const iteration = benchmarkFolder(box, `iteration ${WIDE}`);
		const result = runScript(box, "aggregate_benchmark.py", [iteration], ANSI_PIPE);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.ok(result.stdout.includes(`Generated: ${join(iteration, "benchmark.json")}\n`), result.stdout);
		assert.ok(existsSync(join(iteration, "benchmark.md")));
	});

	test.skipIf(!pyyaml)("package_skill writes its output as UTF-8 to a pipe in Windows' ANSI code page", () => {
		const box = sandbox();
		const dist = join(box.dir, `dist ${WIDE}`);
		const result = runScript(box, "package_skill.py", [box.skill, dist], ANSI_PIPE);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.ok(result.stdout.startsWith(`\u{1f4e6} Packaging skill: ${box.skill}\n`), result.stdout);
		assert.ok(
			result.stdout.endsWith(`\u2705 Successfully packaged skill to: ${join(dist, "skill.skill")}\n`),
			result.stdout,
		);
		assert.ok(existsSync(join(dist, "skill.skill")));
	});

	test("generate_report writes its page as UTF-8 to a pipe in Windows' ANSI code page", () => {
		const box = sandbox();
		const result = runScript(box, "generate_report.py", [loopOutput(box), "--skill-name", "reports"], ANSI_PIPE);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.match(result.stdout, /<title>[^<]*reports \u2014 /u);
		assert.ok(result.stdout.includes(`<td class="description">Use for reports ${WIDE}</td>`), result.stdout);
		assert.match(result.stdout, /<td class="result pass">\u2713<span class="rate">1\/1<\/span><\/td>/u);
	});

	test.skipIf(!pyyaml)("quick_validate writes its message as UTF-8 to a pipe in Windows' ANSI code page", () => {
		const box = sandbox();
		writeFileSync(join(box.skill, "SKILL.md"), `---\nname: ${WIDE}\ndescription: Reports.\n---\n# Reports\n`);
		const result = runScript(box, "quick_validate.py", [box.skill], ANSI_PIPE);
		assert.equal(result.exitCode, 1, "an invalid name");
		assert.equal(
			result.stdout,
			`Name '${WIDE}' should be kebab-case (lowercase letters, digits, and hyphens only)\n`,
			result.stderr,
		);
	});

	test("the evaluation writes its progress as UTF-8 to standard error in Windows' ANSI code page", () => {
		const box = sandbox();
		const evalSet = box.writeEvalSet([{ query: `make a report ${WIDE}`, should_trigger: true }]);
		const result = runScript(
			box,
			"run_eval.py",
			[
				"--eval-set",
				evalSet,
				"--skill-path",
				box.skill,
				"--description",
				`Use for reports ${WIDE}`,
				"--runs-per-query",
				"1",
				"--verbose",
			],
			ANSI_PIPE,
		);
		assert.equal(result.exitCode, 0, result.stderr);
		assert.ok(result.stderr.includes(`Evaluating: Use for reports ${WIDE}\n`), result.stderr);
		assert.ok(result.stderr.includes(`: make a report ${WIDE}\n`), result.stderr);
	});

	test("the review viewer writes its errors as UTF-8 in Windows' ANSI code page", () => {
		const box = sandbox();
		const workspace = join(box.dir, `workspace ${WIDE}`);
		mkdirSync(workspace);
		const result = spawnSyncCollect(
			[python ?? "python3", join(skillCreatorDir, "eval-viewer", "generate_review.py"), workspace],
			{ cwd: box.project, env: box.env(ANSI_PIPE) },
		);
		assert.equal(result.exitCode, 1, "no runs to review");
		assert.equal(
			new TextDecoder("utf-8", { fatal: true }).decode(result.stderr).trim(),
			`No runs found in ${workspace}`,
		);
	});

	test.skipIf(!pyyaml)(
		"aggregate_benchmark, generate_report and quick_validate still run as files outside the skill-creator folder",
		() => {
			const box = sandbox();
			// No PYTHONPATH: only the script's own folder is on the module path, as when it is run by its path.
			const env = { ...ANSI_PIPE, PYTHONPATH: "" };
			const iteration = benchmarkFolder(box, `iteration ${WIDE}`);
			const aggregate = runScript(box, "aggregate_benchmark.py", [iteration], env);
			assert.equal(aggregate.exitCode, 0, aggregate.stderr);
			assert.ok(aggregate.stdout.includes(`Generated: ${join(iteration, "benchmark.md")}\n`), aggregate.stdout);
			const report = runScript(box, "generate_report.py", [loopOutput(box), "--skill-name", WIDE], env);
			assert.equal(report.exitCode, 0, report.stderr);
			assert.ok(report.stdout.includes(`<title>${WIDE} \u2014 `), report.stdout);
			const validate = runScript(box, "quick_validate.py", [box.skill], env);
			assert.equal(validate.exitCode, 0, validate.stderr);
			assert.equal(validate.stdout, "Skill is valid!\n");
		},
	);

	test.skipIf(!pyyaml)(
		"aggregate_benchmark, generate_report and quick_validate run by their path without their folder on the module path",
		() => {
			const box = sandbox();
			const iteration = benchmarkFolder(box, "iteration-1");
			const runs: [script: string, args: string[], expected: string][] = [
				["aggregate_benchmark.py", [iteration], `Generated: ${join(iteration, "benchmark.md")}\n`],
				["generate_report.py", [loopOutput(box), "--skill-name", "reports"], "<title>reports \u2014 "],
				["quick_validate.py", [box.skill], "Skill is valid!\n"],
			];
			// An isolated interpreter, Python 3.11's safe path, and runpy from another program: nothing puts the
			// script's folder on the module path.
			const runpy = "import runpy, sys\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name='__main__')";
			for (const [script, args, expected] of runs) {
				const path = join(skillCreatorDir, "scripts", script);
				for (const command of [
					["-I", path, ...args],
					[path, ...args],
					["-c", runpy, path, ...args],
				]) {
					const result = spawnSyncCollect([python ?? "python3", ...command], {
						cwd: box.project,
						env: box.env({ ...ANSI_PIPE, PYTHONPATH: "", PYTHONSAFEPATH: "1" }),
					});
					const stdout = result.stdout.toString().replaceAll("\r\n", "\n");
					assert.equal(result.exitCode, 0, `${script}: ${result.stderr.toString()}`);
					assert.ok(stdout.includes(expected), `${script}: ${stdout}`);
				}
			}
		},
	);

	test.skipIf(!pyyaml)(
		"each script run with its output captured in place, as by runpy, writes its output there",
		() => {
			const box = sandbox();
			const iteration = benchmarkFolder(box, "iteration-1");
			const evalSet = box.writeEvalSet([{ query: "make a report", should_trigger: true }]);
			const results = join(box.dir, "results.json");
			writeFileSync(
				results,
				JSON.stringify({
					description: "Use this skill for sample reports.",
					summary: { passed: 0, failed: 1, total: 1 },
					results: [{ query: "make a report", should_trigger: true, pass: false, triggers: 0, runs: 1 }],
				}),
			);
			const loop = ["--model", "local/model", "--max-iterations", "1", "--holdout", "0", "--report", "none"];
			const runs: [script: string, args: string[], expected: string, scenario?: string][] = [
				["aggregate_benchmark.py", [iteration], "Generated: "],
				["generate_report.py", [loopOutput(box), "--skill-name", "reports"], "<title>reports \u2014 "],
				["quick_validate.py", [box.skill], "Skill is valid!"],
				["package_skill.py", [box.skill, join(box.dir, "dist")], "Successfully packaged skill to: "],
				["run_eval.py", ["--eval-set", evalSet, "--skill-path", box.skill, "--runs-per-query", "1"], '"passed": 1'],
				[
					"run_loop.py",
					["--eval-set", evalSet, "--skill-path", box.skill, "--runs-per-query", "1", ...loop],
					'"best_description"',
				],
				[
					"improve_description.py",
					["--eval-results", results, "--skill-path", box.skill, "--model", "local/model"],
					"Use this skill for fake work.",
					"improve",
				],
			];
			// Standard output replaced by a StringIO, which has no encoding to set up; standard error stays the real one.
			const program = [
				"import contextlib, io, runpy, sys",
				"captured = io.StringIO()",
				"sys.argv = sys.argv[1:]",
				"status = 0",
				"with contextlib.redirect_stdout(captured):",
				"    try:",
				"        runpy.run_path(sys.argv[0], run_name='__main__')",
				"    except SystemExit as exit:",
				"        status = exit.code or 0",
				"sys.stdout.buffer.write(f'{status}\\n{captured.getvalue()}'.encode('utf-8'))",
			].join("\n");
			for (const [script, args, expected, scenario = "read-skill"] of runs) {
				const result = spawnSyncCollect(
					[python ?? "python3", "-c", program, join(skillCreatorDir, "scripts", script), ...args],
					{ cwd: box.project, env: box.env({ FAKE_ATOMIC_SCENARIO: scenario }) },
				);
				const [status, ...captured] = result.stdout.toString().replaceAll("\r\n", "\n").split("\n");
				assert.equal(result.exitCode, 0, `${script}: ${result.stderr.toString()}`);
				assert.equal(status, "0", `${script}: ${result.stderr.toString()}`);
				assert.ok(captured.join("\n").includes(expected), `${script}: ${captured.join("\n")}`);
			}
		},
	);

	test("the review viewer run with its errors captured in place, as by runpy, reports them there", () => {
		const box = sandbox();
		const program = [
			"import contextlib, io, runpy, sys",
			"captured = io.StringIO()",
			"sys.argv = [sys.argv[1], sys.argv[2]]",
			"with contextlib.redirect_stderr(captured):",
			"    try:",
			"        runpy.run_path(sys.argv[0], run_name='__main__')",
			"    except SystemExit as exit:",
			"        print(exit.code, captured.getvalue().strip())",
		].join("\n");
		const missing = join(box.dir, "missing");
		const result = spawnSyncCollect(
			[python ?? "python3", "-c", program, join(skillCreatorDir, "eval-viewer", "generate_review.py"), missing],
			{ cwd: box.project, env: box.env(ANSI_PIPE) },
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(result.stdout.toString().trim(), `1 Error: ${missing} is not a directory`);
	});

	test.skipIf(!pyyaml)("importing the scripts leaves the process's output streams as they were", () => {
		const box = sandbox();
		const imported = spawnSyncCollect(
			[
				python ?? "python3",
				"-c",
				[
					"import sys",
					"import scripts.aggregate_benchmark, scripts.generate_report, scripts.improve_description",
					"import scripts.package_skill, scripts.quick_validate, scripts.run_eval, scripts.run_loop",
					"print(sys.stdout.encoding, sys.stderr.encoding)",
				].join("\n"),
			],
			{ cwd: box.project, env: box.env(ANSI_PIPE) },
		);
		assert.equal(imported.exitCode, 0, imported.stderr.toString());
		assert.equal(imported.stdout.toString().trim(), "cp1252 cp1252");
	});

	test("a script writes even text that UTF-8 cannot encode to a pipe in Windows' ANSI code page, escaped", () => {
		const box = sandbox();
		// A lone surrogate, as Python names a file whose name is not valid text.
		const result = spawnSyncCollect(
			[
				python ?? "python3",
				"-c",
				"import sys\nfrom scripts.utils import write_output_in_utf8\nwrite_output_in_utf8()\nsys.stdout.write('a-\\udcff')\nsys.stderr.write('b-\\udcff')",
			],
			{ cwd: box.project, env: box.env(ANSI_PIPE) },
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(result.stdout.toString(), "a-\\udcff");
		assert.equal(result.stderr.toString(), "b-\\udcff");
	});

	test("output already in UTF-8 is written as before, with the stream's own error handling", () => {
		const box = sandbox();
		// A UTF-8 stream that writes back a name's undecodable bytes as they were, as a C locale's does.
		const result = spawnSyncCollect(
			[
				python ?? "python3",
				"-c",
				"import sys\nfrom scripts.utils import write_output_in_utf8\nwrite_output_in_utf8()\nsys.stdout.write('name-\\udcff')",
			],
			{ cwd: box.project, env: box.env({ PYTHONIOENCODING: "utf-8:surrogateescape" }) },
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(Buffer.from(result.stdout), Buffer.from([...Buffer.from("name-"), 0xff]));
	});

	test.skipIf(process.platform === "win32")(
		"a script run without standard output or error, as under pythonw, runs",
		() => {
			const box = sandbox();
			// Standard output and error closed: Python starts with sys.stdout and sys.stderr set to None.
			const closed = (script: string, args: readonly string[]) =>
				spawnSyncCollect(
					[
						"sh",
						"-c",
						'exec "$0" "$@" >&- 2>&-',
						python ?? "python3",
						join(skillCreatorDir, "scripts", script),
						...args,
					],
					{ cwd: box.project, env: box.env(ANSI_PIPE) },
				).exitCode;
			const iteration = benchmarkFolder(box, "iteration-1");
			assert.equal(closed("aggregate_benchmark.py", [iteration]), 0);
			assert.ok(existsSync(join(iteration, "benchmark.json")));
			const evalSet = box.writeEvalSet([{ query: "make a report", should_trigger: true }]);
			assert.equal(
				closed("run_eval.py", ["--eval-set", evalSet, "--skill-path", box.skill, "--runs-per-query", "1"]),
				0,
			);
			assert.equal(box.records().length, 1, "the query ran");
		},
	);
});
