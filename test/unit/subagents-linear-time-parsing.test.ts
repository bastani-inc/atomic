import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import { unwrapSubagentPrompt } from "../../packages/subagents/src/extension/tool-rendering.js";
import { isMutatingBashCommand } from "../../packages/subagents/src/runs/shared/long-running-guard.js";
import { injectSingleOutputInstruction } from "../../packages/subagents/src/runs/shared/single-output.js";
import {
	buildTaskInstructions,
	injectSingleProgressInstruction,
} from "../../packages/subagents/src/shared/settings.js";
import { extractOutputTarget } from "../../packages/subagents/src/tui/render-status-progress.js";

const PATHOLOGICAL_REPETITIONS = 50_000;
const NEWLINE_TEE_REPETITIONS = 80_000;
const BASELINE_SAMPLES = 5;
const LINEAR_BASELINE_FLOOR_MS = 25;
const LINEAR_BUDGET_MULTIPLIER = 40;
const ORACLE_MAX_LENGTH = 512;

function measureMs(run: () => void): number {
	const started = performance.now();
	run();
	return performance.now() - started;
}

function linearBudgetMs(runLinearBaseline: () => void): number {
	const samples: number[] = [];
	for (let i = 0; i < BASELINE_SAMPLES; i++) {
		samples.push(measureMs(runLinearBaseline));
	}
	samples.sort((a, b) => a - b);
	const medianBaselineMs = samples[Math.floor(samples.length / 2)]!;
	return Math.max(medianBaselineMs, LINEAR_BASELINE_FLOOR_MS) * LINEAR_BUDGET_MULTIPLIER;
}

function assertLinearTime<T>(label: string, runLinearBaseline: () => void, runPathological: () => T): T {
	const budgetMs = linearBudgetMs(runLinearBaseline);
	let result!: T;
	const elapsedMs = measureMs(() => {
		result = runPathological();
	});
	assert.ok(
		elapsedMs <= budgetMs,
		`${label} took ${elapsedMs.toFixed(1)} ms; expected <= ${budgetMs.toFixed(1)} ms (${LINEAR_BUDGET_MULTIPLIER}x linear baseline)`,
	);
	return result;
}

function legacyExtractOutputTarget(task: string): string | undefined {
	assert.ok(task.length <= ORACLE_MAX_LENGTH, "legacy oracle only accepts short bounded fixtures");
	const writeToMatch = task.match(/\[Write to:(?:[^\S\n]*\n)*([^\]\n]+)\]/i);
	if (writeToMatch?.[1]?.trim()) return writeToMatch[1].trim();
	const findingsMatch = task.match(/Write your findings to:\s*(\S+)/i);
	if (findingsMatch?.[1]?.trim()) return findingsMatch[1].trim();
	const outputMatch = task.match(/[Oo]utput(?:\s+to)?\s*:\s*(\S+)/i);
	if (outputMatch?.[1]?.trim()) return outputMatch[1].trim();
	return undefined;
}

function legacyUnwrapSubagentPrompt(task: string): string {
	assert.ok(task.length <= ORACLE_MAX_LENGTH, "legacy oracle only accepts short bounded fixtures");
	let text = task;
	const forkMarker = "\n\nTask:\n";
	const forkIndex = text.indexOf(forkMarker);
	if (forkIndex >= 0 && text.startsWith("You are continuing from")) {
		text = text.slice(forkIndex + forkMarker.length);
	}
	text = text.replace(
		/\n\n---\n(?:Create and maintain progress at:|Update progress at:|Write your findings to:)(?:[^\S\n]*\n)*[^\n]+$/g,
		"",
	);
	text = text.replace(/\n\n\[Write to:(?:[^\S\n]*\n)*[^\]\n]+\]\s*$/i, "");
	return text.trim();
}

function legacyIsMutatingBashCommand(command: string): boolean {
	assert.ok(command.length <= ORACLE_MAX_LENGTH, "legacy oracle only accepts short bounded fixtures");
	const patterns = [
		/(^|[;&|()\s])rm\s+/,
		/(^|[;&|()\s])mv\s+/,
		/(^|[;&|()\s])cp\s+/,
		/(^|[;&|()\s])mkdir\s+/,
		/(^|[;&|()\s])touch\s+/,
		/(^|[;&|()\s])git\s+apply\b/,
		/(^|[;&|()\s])patch\s+/,
		/(^|[;&|()\s])sed\s(?:[^\S\n]*\n)*[^\n;&|]*\s-i\b/,
		/(^|[;&|()\s])perl\s(?:[^\S\n]*\n)*[^\n;&|]*\s-pi\b/,
		/(^|[;&|()]|\n)\s*tee\s+[^|&;]+/,
		/\b(writeFile|writeFileSync|appendFile|appendFileSync)\b/,
		/\bwrite_text\s*\(/,
		/\bopen\s*\([^)]*,\s*["'][wa]/,
	];
	return patterns.some((pattern) => pattern.test(command));
}

describe("extractOutputTarget linear-time parsing", () => {
	test("completes in linear time on 50k+ repeated unclosed [Write to: prefixes", () => {
		const pathological = "[Write to:\\".repeat(PATHOLOGICAL_REPETITIONS);
		const sameLengthBenign = "x".repeat(pathological.length);
		const result = assertLinearTime(
			"extractOutputTarget([Write to:\\ repeated)",
			() => {
				extractOutputTarget(sameLengthBenign);
			},
			() => extractOutputTarget(pathological),
		);
		assert.equal(result, undefined);
	});

	test("completes in linear time on repeated prefixes for findings and output patterns", () => {
		const cases: readonly [name: string, input: string, expected: string | undefined][] = [
			["repeated blank-line [Write to:", `[Write to:${" \n".repeat(PATHOLOGICAL_REPETITIONS)}`, undefined],
			["repeated Write your findings to:", "Write your findings to:".repeat(PATHOLOGICAL_REPETITIONS), "Write"],
			[
				"trailing spaces after findings",
				`Write your findings to:${" ".repeat(PATHOLOGICAL_REPETITIONS)}`,
				undefined,
			],
			["repeated output tokens", "output ".repeat(PATHOLOGICAL_REPETITIONS), undefined],
			["repeated output to tokens", "output to ".repeat(PATHOLOGICAL_REPETITIONS), undefined],
			["trailing spaces after output", `output${" ".repeat(PATHOLOGICAL_REPETITIONS)}`, undefined],
		];
		for (const [name, input, expected] of cases) {
			const sameLengthBenign = "x".repeat(input.length);
			const result = assertLinearTime(
				name,
				() => {
					extractOutputTarget(sameLengthBenign);
				},
				() => extractOutputTarget(input),
			);
			assert.equal(result, expected, name);
		}
	});

	test("matches legacy extraction byte-identically across realistic and edge-case task texts", () => {
		const table: readonly [description: string, task: string, expected: string | undefined][] = [
			["single-line Write to", "Audit auth module.\n\n[Write to: out/report.md]", "out/report.md"],
			["single-line Write to without space", "[Write to:out/report.md]", "out/report.md"],
			["multi-line Write to with blank lines", "[Write to:  \n\t\n  out/report.md ]", "out/report.md"],
			["multi-line Write to with CRLF", "[Write to: \r\n\r\n  out/report.md ]", "out/report.md"],
			["Write to with CR before closing bracket", "[Write to: \r\n  out/report.md\r]", "out/report.md"],
			[
				"Write to with newline before closing bracket does not match",
				"[Write to: \r\n  out/report.md\r\n]",
				undefined,
			],
			["unmatched opening bracket before closing bracket", "[Write to: [draft/report.md]", "[draft/report.md"],
			["trailing bracketed note does not bleed into target", "[Write to: out/report.md] [urgent]", "out/report.md"],
			["earlier bracketed tag ignored", "Check [urgent] issue [Write to: notes/out.md]", "notes/out.md"],
			["case variants on Write to", "[wRiTe To:\n  Mixed/Case.MD]", "Mixed/Case.MD"],
			["uppercase Write to", "[WRITE TO: UPPER.MD]", "UPPER.MD"],
			["missing closing bracket returns undefined", "[Write to: out/report.md", undefined],
			["missing closing bracket across newline", "[Write to: out/report.md\nclosing later]", undefined],
			[
				"unclosed Write to falls through to findings pattern",
				"[Write to: unclosed\nWrite your findings to: fallback/findings.md",
				"fallback/findings.md",
			],
			[
				"two Write to prefixes on one line where second spans newline",
				"[Write to: unclosed [Write to:  \nout/second.md]",
				"out/second.md",
			],
			[
				"blank-trimmed Write to does not fall back to later Write to",
				"[Write to:   ] [Write to: later.md]",
				undefined,
			],
			[
				"blank-trimmed Write to falls through to Output pattern",
				"[Write to:   ] Output: fallback.md",
				"fallback.md",
			],
			["empty Write to brackets continue to later Write to", "[Write to:] [Write to: later.md]", "later.md"],
			["blank-line-only empty Write to continues", "[Write to:\n] [Write to: later.md]", "later.md"],
			[
				"Write your findings to with tabs and newline",
				"Analyze.\nWRITE YOUR FINDINGS TO:\n\tnotes/a.md extra",
				"notes/a.md",
			],
			["Write your findings to with only whitespace", "Write your findings to:   \n\t ", undefined],
			["Output with colon", "Output: dist/out.json", "dist/out.json"],
			["lowercase output to with spaces", "output   to  :\n  dist/out.json", "dist/out.json"],
			["mixed-case output to", "OuTpUt\tTo: result.txt", "result.txt"],
			["overlapping output toutput token", "output toutput: overlap.md", "overlap.md"],
			["output without colon", "output to the directory", undefined],
			[
				"Write to takes precedence over findings and output",
				"Output: a.md\nWrite your findings to: b.md\n[Write to: c.md]",
				"c.md",
			],
			["findings takes precedence over output", "Output: a.md\nWrite your findings to: b.md", "b.md"],
			[
				"Unicode dotted I before Write to preserves indices",
				"Check \u0130stanbul [Write to: out/tr.md]",
				"out/tr.md",
			],
			[
				"Unicode dotted I before findings preserves indices",
				"Check \u0130stanbul Write your findings to: out/tr.md",
				"out/tr.md",
			],
			["Unicode dotted I before output preserves indices", "Check \u0130stanbul Output to: out/tr.md", "out/tr.md"],
			["Unicode whitespace in multi-line Write to", "[Write to:\u00a0\n\u2003out/u.md\ufeff]", "out/u.md"],
			["plain task without target", "Refactor the parser and run tests.", undefined],
		];

		for (const [description, task, expected] of table) {
			assert.equal(legacyExtractOutputTarget(task), expected, `oracle mismatch: ${description}`);
			assert.equal(extractOutputTarget(task), expected, `new mismatch: ${description}`);
		}
	});

	test("round-trips real subagent output and progress producers including spaces, Windows paths, Unicode, and nested brackets", () => {
		const paths = [
			"out/report.md",
			"/tmp/findings.md",
			"/Users/Jane Doe/My Project/report.md",
			"C:\\Users\\Jane Doe\\My Project\\report.md",
			"app/users/[id]/report.md",
			"C:\\work\\[v1]\\out.md",
			"/tmp/r\u00e9sum\u00e9/\u65e5\u672c\u8a9e report.md",
		];
		const baseTasks = [
			"Audit auth module.",
			"Inspect \u0130stanbul parser.\nLine 2.",
			"Check [urgent] ticket\r\nLine 2",
		];
		for (const baseTask of baseTasks) {
			for (const outputPath of paths) {
				const withOutput = injectSingleOutputInstruction(baseTask, outputPath);
				assert.equal(extractOutputTarget(withOutput), outputPath, `single output extract: ${outputPath}`);
				assert.equal(unwrapSubagentPrompt(withOutput), baseTask.trim(), `single output unwrap: ${outputPath}`);

				const withProgressAndOutput = injectSingleOutputInstruction(
					injectSingleProgressInstruction(baseTask, "/tmp/progress dir"),
					outputPath,
				);
				assert.equal(
					extractOutputTarget(withProgressAndOutput),
					outputPath,
					`stacked progress+output extract: ${outputPath}`,
				);
				assert.equal(
					unwrapSubagentPrompt(withProgressAndOutput),
					baseTask.trim(),
					`stacked progress+output unwrap: ${outputPath}`,
				);

				const cwd = "/workspace/my repo";
				const built = buildTaskInstructions(
					{ output: outputPath, outputMode: "inline", reads: false, progress: true, skills: false },
					cwd,
					true,
				);
				const expectedBuiltPath = path.isAbsolute(outputPath) ? outputPath : path.join(cwd, outputPath);
				assert.equal(
					extractOutputTarget(`${built.prefix}${baseTask}${built.suffix}`),
					expectedBuiltPath,
					`buildTaskInstructions extract: ${outputPath}`,
				);
			}
		}

		// Balanced bracket paths inside [Write to: ...] extract intact without eating later bracketed tags
		assert.equal(extractOutputTarget("[Write to: dir/[v1]/report.md] [note]"), "dir/[v1]/report.md");
		assert.equal(extractOutputTarget("[Write to: [draft] out.md]"), "[draft] out.md");
		assert.equal(unwrapSubagentPrompt("Inspect.\n\n[Write to: app/users/[id]/report.md]"), "Inspect.");
		assert.equal(
			unwrapSubagentPrompt("Inspect.\n\n[Write to: out.md] [keep]"),
			"Inspect.\n\n[Write to: out.md] [keep]",
		);
	});
});

describe("unwrapSubagentPrompt linear-time parsing", () => {
	test("completes in linear time on 50k+ repeated trailer prefixes", () => {
		const cases: readonly [name: string, input: string][] = [
			["repeated [Write to: lines", "\n\n[Write to:".repeat(PATHOLOGICAL_REPETITIONS)],
			[
				"repeated blank lines inside [Write to:",
				`Inspect.\n\n[Write to:${" \n".repeat(PATHOLOGICAL_REPETITIONS)}keep\nthis`,
			],
			["repeated progress lines", "\n\n---\nWrite your findings to:\n".repeat(PATHOLOGICAL_REPETITIONS)],
			[
				"repeated blank lines inside progress",
				`Inspect.\n\n---\nUpdate progress at:${" \n".repeat(PATHOLOGICAL_REPETITIONS)}keep\nthis`,
			],
		];
		for (const [name, input] of cases) {
			const sameLengthBenign = "x".repeat(input.length);
			assertLinearTime(
				name,
				() => {
					unwrapSubagentPrompt(sameLengthBenign);
				},
				() => unwrapSubagentPrompt(input),
			);
		}
	});

	test("matches legacy prompt unwrapping byte-identically across realistic and edge-case prompts", () => {
		const table: readonly [description: string, task: string, expected: string][] = [
			["plain prompt", "Inspect the parser.", "Inspect the parser."],
			[
				"fork preamble stripped",
				"You are continuing from a parent.\n\nTask:\nInspect the parser.",
				"Inspect the parser.",
			],
			["progress trailer single-line", "Inspect.\n\n---\nCreate and maintain progress at: p.md", "Inspect."],
			["progress trailer multi-line blank lines", "Inspect.\n\n---\nUpdate progress at:\n \t\np.md", "Inspect."],
			["progress trailer CRLF blank line", "Inspect.\n\n---\nWrite your findings to:\r\n  p.md", "Inspect."],
			["progress trailer with trailing space only", "Inspect.\n\n---\nUpdate progress at: ", "Inspect."],
			[
				"progress trailer with nothing after colon kept",
				"Inspect.\n\n---\nUpdate progress at:",
				"Inspect.\n\n---\nUpdate progress at:",
			],
			[
				"progress trailer followed by another line kept",
				"Inspect.\n\n---\nUpdate progress at: p.md\nKeep this.",
				"Inspect.\n\n---\nUpdate progress at: p.md\nKeep this.",
			],
			["Write to trailer single-line", "Inspect.\n\n[Write to: report.md]", "Inspect."],
			["Write to trailer uppercase with trailing whitespace", "Inspect.\n\n[WRITE TO: report.md]\n  ", "Inspect."],
			["Write to trailer multi-line blank lines", "Inspect.\n\n[Write to:\n \nreport.md]", "Inspect."],
			[
				"Write to trailer with unbalanced closing bracket kept",
				"Inspect.\n\n[Write to: a] b]",
				"Inspect.\n\n[Write to: a] b]",
			],
			["chained Write to trailers strip leftmost match", "Inspect.\n\n[Write to:\n\n[Write to: b]", "Inspect."],
			[
				"triple chained Write to strips from second",
				"Inspect.\n\n[Write to:\n\n[Write to:\n\n[Write to: b]",
				"Inspect.\n\n[Write to:",
			],
			["chained Write to ending with empty bracket", "Inspect.\n\n[Write to:\n\n[Write to:]", "Inspect."],
			[
				"both progress and Write to trailers",
				"Inspect.\n\n[Write to: out.md]\n\n---\nUpdate progress at: p.md",
				"Inspect.",
			],
			["Unicode dotted I before Write to trailer", "\u0130nspect.\n\n[Write to: report.md]", "\u0130nspect."],
		];

		for (const [description, task, expected] of table) {
			assert.equal(legacyUnwrapSubagentPrompt(task), expected, `oracle mismatch: ${description}`);
			assert.equal(unwrapSubagentPrompt(task), expected, `new mismatch: ${description}`);
		}
	});
});

describe("isMutatingBashCommand linear-time parsing", () => {
	test("completes in linear time on 50k+ repetitions of sed, perl, tee newlines, and open", () => {
		const cases: readonly [name: string, command: string][] = [
			["repeated sed tokens", " sed ".repeat(PATHOLOGICAL_REPETITIONS)],
			["repeated perl tokens", " perl ".repeat(PATHOLOGICAL_REPETITIONS)],
			["repeated newlines for tee", "\n".repeat(NEWLINE_TEE_REPETITIONS)],
			["repeated open(,", "open(,".repeat(PATHOLOGICAL_REPETITIONS)],
		];
		for (const [name, command] of cases) {
			const sameLengthBenign = "a".repeat(command.length);
			const result = assertLinearTime(
				name,
				() => {
					isMutatingBashCommand(sameLengthBenign);
				},
				() => isMutatingBashCommand(command),
			);
			assert.equal(result, false, name);
		}
	});

	test("matches legacy classification across sed, perl, tee, and open edge cases", () => {
		const table: readonly [command: string, expected: boolean][] = [
			["sed  -i", true],
			["sed -e s/a/b/ -i f", true],
			["sed\n -i", true],
			["sed \n-i", true],
			["sed\n\n-i", true],
			["sed \n \n-i", true],
			["sed -e x\n-i", true],
			["sed -e x\n -i", false],
			["sed -e x ; -i", false],
			["sed\n; -i", false],
			["sed \n\n  -i f", true],
			["sed -i_bak", false],
			["sed  -i-bak", true],
			["sed s/a/b/ f", false],
			["sed -e 's/-i/x/'", false],
			["sed foo sed \n-i", true],
			["perl -e 1 -pi f", true],
			["perl \n\n  -pi f", true],
			["perl -e 1", false],
			["perl  -pi", true],
			["perl foo perl \n-pi", true],
			["echo hi | tee out.txt", true],
			["\n  tee out.txt", true],
			["tee  |", true],
			["tee |", false],
			["tee ", false],
			["tee  ", true],
			["mytee out.txt", false],
			["python -c \"open('a', 'w')\"", true],
			["python -c \"open('a', 'a')\"", true],
			["python -c \"open('a', 'r')\"", false],
			["python -c \"open(a, 'x') open(b, 'w')\"", true],
			["python -c \"open(a, 'x', 'w')\"", true],
			["python -c \"reopen('a', 'w')\"", false],
		];

		for (const [command, expected] of table) {
			assert.equal(legacyIsMutatingBashCommand(command), expected, `oracle mismatch: ${JSON.stringify(command)}`);
			assert.equal(isMutatingBashCommand(command), expected, `new mismatch: ${JSON.stringify(command)}`);
		}
	});

	test("flags real single-space in-place sed/perl edits and Python open write modes", () => {
		for (const command of [
			"sed -i 's/foo/bar/g' file.txt",
			"sed -i '' 's/foo/bar/' file.txt",
			"sed -i.bak 's/foo/bar/' file.txt",
			"sed\n-i 's/foo/bar/' file.txt",
			"perl -pi -e 's/foo/bar/' file.txt",
			"perl -pi.bak -e 's/foo/bar/' file.txt",
			"python3 -c \"open('out.txt', mode='w').write('x')\"",
			'python3 -c \'open("out.txt", mode = "a")\'',
			"python3 -c \"open(os.path.join(d, 'f'), 'w')\"",
		]) {
			assert.equal(isMutatingBashCommand(command), true, command);
		}
		for (const command of [
			"sed -info file.txt",
			"perl -pipe -e 1",
			"python3 -c \"open('out.txt', mode='r')\"",
			"python3 -c \"open(os.path.join(d, 'f'), 'r')\"",
		]) {
			assert.equal(isMutatingBashCommand(command), false, command);
		}
	});
});
