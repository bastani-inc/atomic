#!/usr/bin/env bun
/** Bounded CI-only flake recovery: one retry with durable first-attempt diagnostics. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { basename, resolve } from "node:path";
import { spawnProcess } from "../test/helpers/runtime.js";
import {
	type BudgetedSample,
	evaluateDurations,
	FAIL_RATIO,
	renderDurationTable,
	resolveDefaultTimeoutMs,
	WARN_RATIO,
} from "./test-duration-guard.js";

interface Options {
	label: string;
	diagnosticsDir: string;
	deterministicFiles: string[];
	command: string[];
}

function parseArgs(): Options {
	const args = process.argv.slice(2);
	let label = "test suite";
	let diagnosticsDir = ".ci-diagnostics";
	const deterministicFiles: string[] = [];
	let i = 0;
	for (; i < args.length; i++) {
		if (args[i] === "--") {
			i++;
			break;
		}
		if (args[i] === "--label" && args[i + 1]) label = args[++i] as string;
		else if (args[i] === "--diagnostics-dir" && args[i + 1]) diagnosticsDir = args[++i] as string;
		else if (args[i] === "--no-retry-file" && args[i + 1]) deterministicFiles.push(basename(args[++i] as string));
		else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
	}
	const command = args.slice(i);
	if (command.length === 0) throw new Error("Expected a command after --");
	return { label, diagnosticsDir: resolve(diagnosticsDir), deterministicFiles, command };
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

interface AttemptResult {
	code: number;
	output: string;
	report: string | undefined;
}

/**
 * Stream child output as it arrives instead of buffering it until the child exits.
 * A suite that overruns the job's `timeout-minutes` budget is killed mid-run, and a
 * buffered attempt discards every line it had already collected, leaving the cancelled
 * step with no record of which test stalled. Teeing preserves the retry and diagnostics
 * contract while making a timed-out attempt self-describing in the step log.
 */
async function runAttempt(
	command: string[],
	logPath: string,
	reportPath: string,
	persist: boolean,
): Promise<AttemptResult> {
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
	if (persist) writeFileSync(logPath, output);
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
 * Whether a file that must never be retried is among the failures.
 *
 * vitest names the failing file in its `FAIL <path>` line and again in the
 * per-failure header, so the file set is read from the report when one exists
 * and from the log only as a fallback for a suite that died before writing one.
 */
function findFailedDeterministicFile(attempt: AttemptResult, files: string[]): string | undefined {
	if (attempt.report) {
		try {
			const parsed = JSON.parse(attempt.report) as {
				testResults?: { name?: string; assertionResults?: { status?: string }[] }[];
			};
			for (const result of parsed.testResults ?? []) {
				const failed = (result.assertionResults ?? []).some((assertion) => assertion.status === "failed");
				if (!failed) continue;
				const match = files.find((file) => (result.name ?? "").replaceAll("\\", "/").endsWith(`/${file}`));
				if (match) return match;
			}
			return undefined;
		} catch {
			// Fall through to the log scan below.
		}
	}
	for (const line of attempt.output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!/^(?:FAIL|❯|×)/u.test(trimmed) && !trimmed.startsWith("FAIL")) continue;
		const match = files.find((file) => trimmed.includes(file));
		if (match) return match;
	}
	return undefined;
}

interface Attempt {
	label: string;
	result: AttemptResult;
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
 * Every attempt is scored, not just the one that decided the exit code. A first
 * attempt that exhausted a test's headroom and a retry that happened to be fast
 * are the same regression; reporting only the retry would discard the sample
 * that actually shows the drift.
 *
 * A gate that cannot see is reported, never assumed green: an attempt that ran
 * tests without producing a readable report fails the step, because an empty
 * sample set otherwise looks exactly like a suite with nothing to report.
 */
async function reportDurations(attempts: Attempt[], options: Options, name: string): Promise<number> {
	const budget = await resolveDefaultTimeoutMs(options.command, process.cwd());
	const scored = attempts.map((attempt) => {
		const report = readableReport(attempt.result.report);
		return {
			label: attempt.label,
			missing: report === undefined,
			report: evaluateDurations(report ?? '{"numTotalTests":0,"testResults":[]}', budget),
		};
	});
	mkdirSync(options.diagnosticsDir, { recursive: true });
	const table = scored.map(({ label, report }) => `## ${label}\n\n${renderDurationTable(report)}`).join("\n\n");
	writeFileSync(
		resolve(options.diagnosticsDir, `${name}-durations.md`),
		`# ${options.label}: per-test duration headroom\n\n${table}\n`,
	);
	const gated = scored.filter(({ report }) => report.enabled);
	if (gated.length === 0) return 0;
	const blind = gated.filter(({ report, missing }) => report.blind || missing);
	if (blind.length > 0) {
		for (const { label, report, missing } of blind) {
			console.error(
				`::error title=Duration guard blind: ${options.label}::${label}: ${missing ? "the suite wrote no readable JSON report" : `${report.ranTests} test(s) ran but the report carried no durations`}, so no headroom could be measured.`,
			);
		}
		appendSummary(
			`### ❌ Duration guard blind: ${options.label}\nThe suite ran tests but produced no per-test durations, so the ${FAIL_RATIO * 100} % headroom gate measured nothing. Restore vitest's JSON reporter output before trusting this run.\n\n${table}`,
		);
		return 1;
	}
	const describe = (label: string, sample: BudgetedSample): string =>
		`${label}: ${sample.file} > ${sample.fullName} took ${sample.durationMs.toFixed(0)}ms of its ${sample.timeoutMs}ms budget (${(sample.ratio * 100).toFixed(0)}%).`;
	const collect = (
		pick: (entry: { label: string; report: ReturnType<typeof evaluateDurations> }) => BudgetedSample[],
	): string[] => gated.flatMap((entry) => pick(entry).map((sample) => describe(entry.label, sample)));
	for (const message of collect((entry) => entry.report.warnings).slice(0, 10)) {
		console.error(`::warning title=Slow test: ${options.label}::${message}`);
	}
	const failures = collect((entry) => entry.report.failures);
	if (failures.length === 0) return 0;
	for (const message of failures.slice(0, 10)) {
		console.error(`::error title=Timeout headroom exhausted: ${options.label}::${message}`);
	}
	appendSummary(
		`### ❌ Timeout headroom exhausted: ${options.label}\n${failures.length} test(s) used at least ${FAIL_RATIO * 100} % of their per-test timeout (warning threshold ${WARN_RATIO * 100} %). Raise the specific test's explicit timeout only if the cost is structural, and make it fast otherwise.\n\n${table}`,
	);
	return 1;
}

const options = parseArgs();
const name = safeName(options.label);
const firstLog = resolve(options.diagnosticsDir, `${name}-attempt-1.log`);
const secondLog = resolve(options.diagnosticsDir, `${name}-attempt-2.log`);
const firstReport = resolve(options.diagnosticsDir, `${name}-attempt-1.json`);
const secondReport = resolve(options.diagnosticsDir, `${name}-attempt-2.json`);
rmSync(firstLog, { force: true });
rmSync(secondLog, { force: true });
mkdirSync(options.diagnosticsDir, { recursive: true });

const first = await runAttempt(options.command, firstLog, firstReport, false);
const firstAttempt: Attempt = { label: "attempt 1", result: first };
if (first.code === 0) process.exit(await reportDurations([firstAttempt], options, name));

writeFileSync(firstLog, first.output);
const debug = debugSummary(options.label, options.command);
writeFileSync(resolve(options.diagnosticsDir, `${name}-debug.txt`), `${debug}\n`);
console.error(
	`\n::warning title=${options.label} first attempt failed::Preserved diagnostics; evaluating one bounded retry.`,
);
console.error(`\n${debug}\n`);

const deterministicHit = findFailedDeterministicFile(first, options.deterministicFiles);
if (deterministicHit) {
	await reportDurations([firstAttempt], options, name);
	appendSummary(
		`### ❌ ${options.label}\nNo retry: deterministic test file failed (\`${deterministicHit}\`). First-attempt diagnostics were preserved.`,
	);
	console.error(`No retry: deterministic test file failed (${deterministicHit}).`);
	process.exit(first.code);
}

console.error(`Retrying ${options.label} once (smallest safe suite)...`);
const second = await runAttempt(options.command, secondLog, secondReport, true);
const attempts: Attempt[] = [firstAttempt, { label: "attempt 2", result: second }];
if (second.code === 0) {
	const guard = await reportDurations(attempts, options, name);
	appendSummary(
		`### ⚠️ Detected flake: ${options.label}\nAttempt 1 failed and the single bounded retry passed. Diagnostic logs are retained as CI artifacts.`,
	);
	console.error(
		`::warning title=Detected flake: ${options.label}::Attempt 1 failed; bounded retry passed. See diagnostic artifact.`,
	);
	process.exit(guard);
}
await reportDurations(attempts, options, name);
appendSummary(
	`### ❌ Persistent failure: ${options.label}\nBoth the first attempt and the single bounded retry failed. Both logs are retained.`,
);
console.error(`::error title=Persistent failure: ${options.label}::Both attempts failed; see both diagnostic logs.`);
process.exit(second.code);
