/**
 * Duration-headroom guard for the repository's vitest suites.
 *
 * A fixed per-test timeout cannot detect drift: a test that creeps from 30 % to
 * 95 % of its budget looks identical to a healthy one until a slow runner tips
 * it over and the suite flakes. Only the *ratio* of duration to budget carries
 * that signal, so this module reads vitest's JSON reporter, resolves each test's
 * effective timeout, and reports the tests closest to their budget.
 *
 * Timeout resolution mirrors vitest's own precedence: an explicit third argument
 * on the declaration wins, otherwise the project's resolved `testTimeout`
 * applies. When no budget can be resolved from the command the gate stays
 * disabled and only the duration table is emitted -- a suite that never declared
 * a budget must not be judged against one it did not choose.
 *
 * It previously scraped Bun's human-readable `(pass) name [Nms]` stdout. That
 * scored 4288 of 4417 unit tests: 127 passing tests print no duration at all,
 * and 67 files' tests were attributed to the wrong file because Bun files
 * barrel-re-exported tests under the importing header. The JSON reporter emits a
 * record per test with its own file, so the gate now covers the whole suite and
 * `blind` finally means what it says.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Emit a warning once a test consumes this share of its effective timeout. */
export const WARN_RATIO = 0.4;
/** Fail the step once a test consumes this share of its effective timeout. */
export const FAIL_RATIO = 0.7;
/** vitest's built-in per-test timeout, used only for reporting an unset budget. */
export const VITEST_DEFAULT_TIMEOUT_MS = 5000;

export interface DurationSample {
	file: string;
	name: string;
	fullName: string;
	status: "pass" | "fail";
	durationMs: number;
}

export interface BudgetedSample extends DurationSample {
	timeoutMs: number;
	ratio: number;
	explicit: boolean;
}

export interface DurationGuardReport {
	enabled: boolean;
	defaultTimeoutMs: number | undefined;
	ranTests: number;
	blind: boolean;
	samples: BudgetedSample[];
	warnings: BudgetedSample[];
	failures: BudgetedSample[];
}

/** The subset of vitest's JSON reporter this guard reads. */
interface VitestAssertion {
	ancestorTitles?: string[];
	title?: string;
	fullName?: string;
	status?: string;
	duration?: number | null;
}

interface VitestFileResult {
	name?: string;
	assertionResults?: VitestAssertion[];
}

interface VitestReport {
	numTotalTests?: number;
	testResults?: VitestFileResult[];
}

/**
 * Every completed test in a vitest JSON report, as a duration sample.
 *
 * Skipped and pending tests are excluded: they carry no duration and scoring a
 * zero against a budget would dilute the table with rows that cannot drift.
 * They still count towards `ranTests`, which is what distinguishes "nothing to
 * measure" from "the harness produced no measurements".
 */
export function parseVitestReport(json: string, rootDir: string = process.cwd()): DurationSample[] {
	const report = JSON.parse(json) as VitestReport;
	const samples: DurationSample[] = [];
	for (const result of report.testResults ?? []) {
		const absolute = result.name ?? "";
		const file = (isAbsolute(absolute) ? relative(rootDir, absolute) : absolute).replaceAll("\\", "/");
		for (const assertion of result.assertionResults ?? []) {
			if (assertion.status !== "passed" && assertion.status !== "failed") continue;
			const title = assertion.title ?? "";
			const scopes = assertion.ancestorTitles ?? [];
			// vitest's `fullName` joins the scope path with a space; the explicit
			// per-test budgets below are keyed by the `scope > name` form, so the
			// path is rebuilt rather than trusted.
			const fullName = [...scopes, title].filter((part) => part !== "").join(" > ");
			samples.push({
				file,
				name: title,
				fullName,
				status: assertion.status === "passed" ? "pass" : "fail",
				durationMs: assertion.duration ?? 0,
			});
		}
	}
	return samples;
}

/** Tests vitest reported, whether or not each produced a duration. */
export function reportedTestCount(json: string): number {
	const report = JSON.parse(json) as VitestReport;
	if (typeof report.numTotalTests === "number") return report.numTotalTests;
	return (report.testResults ?? []).reduce((total, result) => total + (result.assertionResults?.length ?? 0), 0);
}

const DECLARATION_HEAD = "(?:\\.(?:only|skip|todo|failing|serial|concurrent))*\\s*\\(";
const DESCRIBE = /^(\s*)describe(?:\.(?:only|skip|todo|each|if))*\s*\(/u;
const CLOSER = /^(\s*)\},\s*([0-9][0-9_]*|[A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*;?\s*$/u;
const TRAILING_VALUE = /^\s*([0-9][0-9_]*|[A-Za-z_$][A-Za-z0-9_$]*)\s*,?\s*$/u;
const CALL_END = /^(\s*)\)\s*;?\s*$/u;
const NAME_LITERAL = /^\s*(["'`])((?:\\.|(?!\1).)*)\1/u;

function numericConstants(lines: string[]): Map<string, number> {
	const constants = new Map<string, number>();
	for (const line of lines) {
		const match =
			/^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*number\s*)?=\s*([0-9][0-9_]*)\s*;?\s*$/u.exec(
				line,
			);
		if (match?.[1] && match[2]) constants.set(match[1], Number(match[2].replaceAll("_", "")));
	}
	return constants;
}

/**
 * Escape every RegExp metacharacter, backslash included, so an alias name is
 * only ever matched literally. Escaping a subset would leave a backslash in the
 * input able to re-open the escape it was meant to neutralise.
 */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** `test`, `it`, and any local alias bound to them (e.g. `const runTest = ... test.skip`). */
function declarationPattern(lines: string[]): RegExp {
	const names = new Set(["test", "it"]);
	for (const line of lines) {
		const match = /^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=[^;]*\b(?:test|it)\b/u.exec(line);
		if (match?.[1]) names.add(match[1]);
	}
	const alternation = [...names].map(escapeRegExp).join("|");
	return new RegExp(`^(\\s*)(?:${alternation})${DECLARATION_HEAD}`, "u");
}

function previousMeaningfulIndex(lines: string[], index: number): number {
	for (let back = index - 1; back >= 0; back--) if ((lines[back] as string).trim() !== "") return back;
	return -1;
}

/**
 * Reconstruct the `describe` path enclosing a declaration, outermost first, by
 * walking outwards through strictly shallower `describe(` openers. A test is
 * reported as `scope > name`, so without the path two same-named tests in
 * different scopes would collapse onto one budget and be scored against each
 * other's.
 */
function describeScopes(lines: string[], index: number, indent: string): string[] {
	const scopes: string[] = [];
	let inner = indent;
	for (let back = index - 1; back >= 0 && inner.length > 0; back--) {
		const opener = DESCRIBE.exec(lines[back] as string);
		if (!opener || (opener[1] as string).length >= inner.length) continue;
		const name = NAME_LITERAL.exec((lines[back] as string).slice((opener[0] as string).length))?.[2];
		if (name) scopes.unshift(name);
		inner = opener[1] as string;
	}
	return scopes;
}

/**
 * Locate the explicit timeout argument that terminates a test declaration, in
 * both formatted shapes this repository uses: `}, 60_000);` on one line, and a
 * multi-line call whose penultimate line is a bare `240_000,` after `},`.
 * Returns the raw token plus the indentation of the call's own closing line.
 */
function timeoutTail(lines: string[], index: number): { raw: string; indent: string } | undefined {
	const line = lines[index] as string;
	const closer = CLOSER.exec(line);
	if (closer?.[1] !== undefined && closer[2]) return { raw: closer[2], indent: closer[1] };
	const callEnd = CALL_END.exec(line);
	if (!callEnd) return undefined;
	const valueIndex = previousMeaningfulIndex(lines, index);
	if (valueIndex === -1) return undefined;
	const value = TRAILING_VALUE.exec(lines[valueIndex] as string);
	if (!value?.[1]) return undefined;
	const bodyIndex = previousMeaningfulIndex(lines, valueIndex);
	if (bodyIndex === -1 || !/^\s*\},?\s*$/u.test(lines[bodyIndex] as string)) return undefined;
	return { raw: value[1], indent: callEnd[1] as string };
}

/**
 * Map each declared test to its explicit timeout argument, keyed by the fully
 * qualified `scope > name` it is reported under.
 *
 * The key is always qualified. Recording a scoped declaration under its bare
 * terminal name too would lend that budget to a same-named test in a sibling
 * scope that declared none, scoring it against a timeout it never had.
 *
 * The scan is line-based rather than AST-based on purpose: it must never throw
 * on syntax it does not model, and an unresolved declaration degrades to the
 * suite default instead of to a wrong budget. A declaration is matched to its
 * terminating line by indentation, which excludes the far more common inner
 * `}, <number>)` of a nested callback such as `setTimeout` or a poll helper.
 */
export function declaredTimeouts(source: string): Map<string, number> {
	const lines = source.split(/\r?\n/);
	const constants = numericConstants(lines);
	const declaration = declarationPattern(lines);
	const declared = new Map<string, number>();
	const record = (name: string, value: number): void => {
		const previous = declared.get(name);
		declared.set(name, previous === undefined ? value : Math.min(previous, value));
	};
	for (let index = 0; index < lines.length; index++) {
		const tail = timeoutTail(lines, index);
		if (!tail) continue;
		const value = /^[0-9]/u.test(tail.raw) ? Number(tail.raw.replaceAll("_", "")) : constants.get(tail.raw);
		if (value === undefined || !Number.isFinite(value)) continue;
		for (let back = index; back >= 0; back--) {
			const candidate = lines[back] as string;
			const opener = declaration.exec(candidate);
			if (!opener || opener[1] !== tail.indent) continue;
			const head = lines
				.slice(back, back + 3)
				.join(" ")
				.slice((opener[0] as string).length);
			const name = NAME_LITERAL.exec(head)?.[2];
			if (name) record([...describeScopes(lines, back, tail.indent), name].join(" > "), value);
			break;
		}
	}
	return declared;
}

/**
 * Look a sample's explicit budget up by its qualified name. There is
 * deliberately no bare-name fallback: a declaration this scan could not qualify
 * degrades to the suite default rather than borrowing the budget of a same-named
 * test declared elsewhere in the file.
 */
function timeoutIndex(rootDir: string): (file: string, fullName: string) => number | undefined {
	const cache = new Map<string, Map<string, number>>();
	return (file, fullName) => {
		if (!file) return undefined;
		let declared = cache.get(file);
		if (!declared) {
			const path = resolve(rootDir, file);
			declared = existsSync(path) ? declaredTimeouts(readFileSync(path, "utf8")) : new Map<string, number>();
			cache.set(file, declared);
		}
		return declared.get(fullName);
	};
}

/** Minimal shape of a resolved vitest config, enough to find a project's budget. */
interface VitestConfigShape {
	test?: { name?: string; testTimeout?: number; projects?: VitestConfigShape[] };
}

// Windows resolves executables through PATHEXT, which is conventionally
// uppercase (`.EXE;.CMD`), and its filesystems match names case-insensitively.
// The binary checks must match the same way, or a resolved `bun.EXE` head is
// not recognised as the runtime and the gate silently disables on Windows.
const NPM_BINARY = /^(?:npm|npx)(?:\.cmd|\.exe)?$/iu;
const VITEST_BINARY = /^vitest(?:\.cmd|\.exe)?$/iu;
const BUN_BINARY = /^bunx?(?:\.exe)?$/iu;

function flag(args: string[], name: string): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
		if (arg === name && args[index + 1]) return args[index + 1];
	}
	return undefined;
}

/** Resolve `npm run [--workspace=X] <script>` to its manifest directory and name. */
function scriptInvocation(command: string[]): { cwd: string; name: string } | undefined {
	if (!NPM_BINARY.test(basename(command[0] ?? ""))) return undefined;
	const rest = command.slice(1);
	if (rest[0] !== "run") return undefined;
	const workspace = flag(rest, "--workspace") ?? flag(rest, "-w");
	const name = rest.slice(1).find((arg) => !arg.startsWith("-") && arg !== workspace);
	if (!name) return undefined;
	// Workspace names are resolved through the root manifest's `workspaces` glob
	// only in the one shape this repository uses.
	const cwd =
		workspace === undefined
			? "."
			: workspace.startsWith("@bastani/")
				? `packages/${workspace === "@bastani/atomic" ? "coding-agent" : workspace.slice("@bastani/".length)}`
				: workspace;
	return { cwd, name };
}

async function readConfiguredTimeout(
	rootDir: string,
	cwd: string,
	project: string | undefined,
): Promise<number | undefined> {
	for (const candidate of ["vitest.config.ts", "vitest.config.mts", "vitest.config.js"]) {
		const path = resolve(rootDir, cwd, candidate);
		if (!existsSync(path)) continue;
		const module = (await import(pathToFileURL(path).href)) as { default?: VitestConfigShape };
		const config = module.default;
		if (!config?.test) return undefined;
		const projects = config.test.projects ?? [];
		if (project !== undefined) {
			const match = projects.find((entry) => entry.test?.name === project);
			return match?.test?.testTimeout ?? config.test.testTimeout;
		}
		// No `--project`: every project must agree, or the suite has no single
		// budget to score against and the gate stays off rather than picking one.
		if (projects.length > 0) {
			const budgets = new Set(projects.map((entry) => entry.test?.testTimeout));
			return budgets.size === 1 ? [...budgets][0] : undefined;
		}
		return config.test.testTimeout;
	}
	return undefined;
}

/**
 * Resolve the per-test budget a command actually runs with, following one
 * `npm run <script>` indirection into package.json and then into the vitest
 * config that script selects. Returns undefined when the command declares no
 * budget, which disables the gate rather than inventing one.
 *
 * Only a vitest invocation is read for a budget, whichever runtime hosts it: a
 * leading `bun`/`bunx` (with its own flags, and an optional `run`/`x`) is the
 * runtime, not the command. A command that is not vitest has no `testTimeout`,
 * and scoring its output against one would report drift against a ceiling
 * nothing enforces.
 */
export async function resolveDefaultTimeoutMs(
	command: string[],
	rootDir: string = process.cwd(),
): Promise<number | undefined> {
	let args = command;
	let cwd = ".";
	const script = scriptInvocation(command);
	if (script) {
		const manifestPath = resolve(rootDir, script.cwd, "package.json");
		if (!existsSync(manifestPath)) return undefined;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { scripts?: Record<string, string> };
		const line = manifest.scripts?.[script.name];
		if (!line) return undefined;
		args = line.split(/\s+/u).filter((part) => part !== "");
		cwd = script.cwd;
	}
	let head = args[0] ?? "";
	if (NPM_BINARY.test(basename(head)) && basename(head).startsWith("npx")) {
		args = args.slice(1).filter((arg) => arg !== "--no-install" && arg !== "-y");
		head = args[0] ?? "";
	}
	// `bun --bun vitest ...` is still a vitest invocation, and the one the
	// Bun runtime a suite may be launched with. Dropping the runtime
	// prefix keeps the gate on for it; without this the guard would read `bun`,
	// find no budget, and silently stop scoring the suite that needs Bun most.
	//
	// Only the runtime's *own* leading flags are dropped. Filtering every `-`
	// argument would also swallow the `--project` that selects the budget, and
	// the gate would then average whichever projects happened to agree.
	if (BUN_BINARY.test(basename(head))) {
		args = args.slice(1);
		while (args[0]?.startsWith("-")) args = args.slice(1);
		if (args[0] === "run" || args[0] === "x") args = args.slice(1);
		head = args[0] ?? "";
	}
	if (!VITEST_BINARY.test(basename(head))) return undefined;
	return readConfiguredTimeout(rootDir, cwd, flag(args.slice(1), "--project"));
}

/** Join durations to budgets and classify each sample against the two ratios. */
export function evaluateDurations(
	reportJson: string,
	defaultTimeoutMs: number | undefined,
	rootDir: string = process.cwd(),
): DurationGuardReport {
	const lookup = timeoutIndex(rootDir);
	const samples: BudgetedSample[] = [];
	for (const sample of parseVitestReport(reportJson, rootDir)) {
		const explicitTimeout = lookup(sample.file, sample.fullName);
		const timeoutMs = explicitTimeout ?? defaultTimeoutMs ?? VITEST_DEFAULT_TIMEOUT_MS;
		samples.push({
			...sample,
			timeoutMs,
			explicit: explicitTimeout !== undefined,
			ratio: timeoutMs > 0 ? sample.durationMs / timeoutMs : 0,
		});
	}
	samples.sort((left, right) => right.ratio - left.ratio);
	const enabled = defaultTimeoutMs !== undefined;
	const failures = enabled ? samples.filter((sample) => sample.ratio >= FAIL_RATIO) : [];
	const warnings = enabled ? samples.filter((sample) => sample.ratio >= WARN_RATIO && sample.ratio < FAIL_RATIO) : [];
	// A suite that ran tests yet yielded no durations has not been measured. An
	// empty sample set is otherwise indistinguishable from a healthy run, which
	// is exactly how a silently disabled gate survives. Under the JSON reporter
	// this can only mean the harness broke: it emits a record per test.
	const ranTests = reportedTestCount(reportJson);
	const blind = enabled && ranTests > 0 && samples.length === 0;
	return { enabled, defaultTimeoutMs, ranTests, blind, samples, warnings, failures };
}

function row(sample: BudgetedSample): string {
	const cell = (value: string): string => value.replaceAll("|", "\\|");
	const percent = `${(sample.ratio * 100).toFixed(1)} %`;
	const budget = `${sample.timeoutMs} ms${sample.explicit ? " (explicit)" : ""}`;
	return `| ${percent} | ${sample.durationMs.toFixed(2)} ms | ${budget} | ${cell(sample.file)} | ${cell(sample.fullName)} |`;
}

/** Render the slowest samples as a Markdown table for artifacts and summaries. */
export function renderDurationTable(report: DurationGuardReport, limit = 40): string {
	const header = [
		`Default per-test timeout: ${report.defaultTimeoutMs === undefined ? "not declared (gate disabled)" : `${report.defaultTimeoutMs} ms`}`,
		`Warn at ${WARN_RATIO * 100} % of budget, fail at ${FAIL_RATIO * 100} %. Samples: ${report.samples.length} of ${report.ranTests} test(s) run.`,
		"",
		"| Budget used | Duration | Timeout | File | Test |",
		"|---|---|---|---|---|",
	];
	const rows = report.samples.slice(0, limit).map(row);
	const empty = report.blind
		? "| n/a | n/a | n/a | n/a | tests ran but the reporter emitted no durations |"
		: "| n/a | n/a | n/a | n/a | no duration samples parsed |";
	return [...header, ...(rows.length > 0 ? rows : [empty])].join("\n");
}
