#!/usr/bin/env bun
/** CI test-run wrapper: runs a suite once, scores its per-test duration headroom, and reports diagnostics. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { basename, resolve } from "node:path";
import { spawnProcess } from "../test/helpers/runtime.js";
import {
	type BudgetedSample,
	evaluateDurations,
	renderDurationTable,
	resolveDefaultTimeoutMs,
	WARN_RATIO,
} from "./test-duration-guard.js";

interface Options {
	label: string;
	diagnosticsDir: string;
	command: string[];
}

function parseArgs(): Options {
	const args = process.argv.slice(2);
	let label = "test suite";
	let diagnosticsDir = ".ci-diagnostics";
	let i = 0;
	for (; i < args.length; i++) {
		if (args[i] === "--") {
			i++;
			break;
		}
		if (args[i] === "--label" && args[i + 1]) label = args[++i] as string;
		else if (args[i] === "--diagnostics-dir" && args[i + 1]) diagnosticsDir = args[++i] as string;
		else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
	}
	const command = args.slice(i);
	if (command.length === 0) throw new Error("Expected a command after --");
	return { label, diagnosticsDir: resolve(diagnosticsDir), command };
}

function safeName(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "tests"
	);
}

/**
 * Ask the suite for a machine-readable report *in addition to* the human one.
 *
 * The default reporter is what makes a cancelled or timed-out step readable in
 * the live log; the JSON reporter is what the duration gate scores. Requesting
 * only the second would trade a diagnosable step log for a measurable one.
 *
 * The reporter flags are added here rather than in the workflow so the child
 * command stays exactly the one a developer runs locally --
 * test/ci/test-workflow-topology.test.ts asserts that.
 */
function withJsonReporter(command: string[], outputFile: string): string[] {
	const flags = ["--reporter=default", "--reporter=json", `--outputFile.json=${outputFile}`];
	const isNpmRun = /^(?:npm|npx)(?:\.cmd|\.exe)?$/iu.test(basename(command[0] ?? "")) && command[1] === "run";
	return isNpmRun ? [...command, "--", ...flags] : [...command, ...flags];
}

/** Tee one child stream to the live step log while capturing it for diagnostics. */
async function pump(stream: ReadableStream<Uint8Array> | null, sink: NodeJS.WriteStream): Promise<string> {
	if (!stream) return "";
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		text += value;
		sink.write(value);
	}
	return text;
}

interface RunResult {
	code: number;
	output: string;
	report: string | undefined;
}

/**
 * Stream child output as it arrives instead of buffering it until the child exits.
 * A suite that overruns the job's `timeout-minutes` budget is killed mid-run, and a
 * buffered run discards every line it had already collected, leaving the cancelled
 * step with no record of which test stalled. Teeing keeps a timed-out run
 * self-describing in the step log.
 */
async function runOnce(command: string[], reportPath: string): Promise<RunResult> {
	rmSync(reportPath, { force: true });
	const child = spawnProcess(withJsonReporter(command, reportPath), {
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const [stdout, stderr, code] = await Promise.all([
		pump(child.stdout, process.stdout),
		pump(child.stderr, process.stderr),
		child.exited,
	]);
	const output = `${stdout}${stderr}`;
	return { code, output, report: existsSync(reportPath) ? readFileSync(reportPath, "utf8") : undefined };
}

function debugSummary(label: string, command: string[]): string {
	const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
	return [
		`suite: ${label}`,
		`command: ${command.join(" ")}`,
		`platform: ${platform()} ${release()} (${process.arch})`,
		`node: ${process.version}`,
		`cpu: ${cpus().length} logical`,
		`memory: ${gib(freemem())} free / ${gib(totalmem())} total`,
		`loadavg: ${loadavg()
			.map((value) => value.toFixed(2))
			.join(", ")}`,
		`cwd: ${process.cwd()}`,
	].join("\n");
}

function appendSummary(markdown: string): void {
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary) appendFileSync(summary, `${markdown}\n`);
}

/**
 * The report text only if it is readable.
 *
 * A report the guard cannot parse measures exactly as much as a report that was
 * never written, and treating the two differently is how a gate goes quiet: the
 * parse would throw inside the scorer, or worse, be swallowed into an empty
 * sample set indistinguishable from a healthy run. Both collapse to "blind".
 */
function readableReport(report: string | undefined): string | undefined {
	if (report === undefined) return undefined;
	try {
		JSON.parse(report);
		return report;
	} catch {
		return undefined;
	}
}

/**
 * Duration-headroom gate.
 *
 * Raising the per-test budget removes a flake but would otherwise let tests
 * drift silently toward the new ceiling until the class returns. The gate scores
 * every duration vitest reported against that test's effective timeout, so a
 * regression is reported on the slow test itself rather than on whichever
 * neighbour happened to lose the coin flip. The full table is always written as
 * an artifact, including on green runs, so cross-platform ratios need one
 * download instead of a log scrape.
 *
 * A gate that cannot see is reported, never assumed green: a run that executed
 * tests without producing a readable report fails the step, because an empty
 * sample set otherwise looks exactly like a suite with nothing to report.
 */
async function reportDurations(result: RunResult, options: Options, name: string): Promise<number> {
	const budget = await resolveDefaultTimeoutMs(options.command, process.cwd());
	const report = readableReport(result.report);
	const missing = report === undefined;
	const evaluated = evaluateDurations(report ?? '{"numTotalTests":0,"testResults":[]}', budget);
	mkdirSync(options.diagnosticsDir, { recursive: true });
	const table = renderDurationTable(evaluated);
	writeFileSync(
		resolve(options.diagnosticsDir, `${name}-durations.md`),
		`# ${options.label}: per-test duration headroom\n\n${table}\n`,
	);
	if (!evaluated.enabled) return 0;
	if (evaluated.blind || missing) {
		console.error(
			`::error title=Duration guard blind: ${options.label}::${missing ? "the suite wrote no readable JSON report" : `${evaluated.ranTests} test(s) ran but the report carried no durations`}, so no headroom could be measured.`,
		);
		appendSummary(
			`### ❌ Duration guard blind: ${options.label}\nThe suite produced no per-test durations. Restore vitest's JSON reporter output before trusting this run.\n\n${table}`,
		);
		return 1;
	}
	const describe = (sample: BudgetedSample): string =>
		`${sample.file} > ${sample.fullName} took ${sample.durationMs.toFixed(0)}ms of its ${sample.timeoutMs}ms budget (${(sample.ratio * 100).toFixed(0)}%).`;
	for (const message of evaluated.warnings.slice(0, 10).map(describe)) {
		console.error(`::warning title=Slow test: ${options.label}::${message}`);
	}
	if (evaluated.warnings.length > 0) {
		appendSummary(
			`### ⚠️ Slow tests: ${options.label}\n${evaluated.warnings.length} test(s) used at least ${WARN_RATIO * 100} % of their per-test timeout. Headroom is advisory; Vitest enforces the actual timeout.\n\n${table}`,
		);
	}
	return 0;
}

const options = parseArgs();
const name = safeName(options.label);
const logPath = resolve(options.diagnosticsDir, `${name}.log`);
const reportPath = resolve(options.diagnosticsDir, `${name}.json`);
rmSync(logPath, { force: true });
mkdirSync(options.diagnosticsDir, { recursive: true });

const result = await runOnce(options.command, reportPath);
if (result.code !== 0) {
	writeFileSync(logPath, result.output);
	const debug = debugSummary(options.label, options.command);
	writeFileSync(resolve(options.diagnosticsDir, `${name}-debug.txt`), `${debug}\n`);
	console.error(`\n${debug}\n`);
}
const guard = await reportDurations(result, options, name);
process.exit(result.code !== 0 ? result.code : guard);
