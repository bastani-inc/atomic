/**
 * Duration-headroom guard for Bun test suites.
 *
 * A fixed per-test timeout cannot detect drift: a test that creeps from 30 % to
 * 95 % of its budget looks identical to a healthy one until a slow runner tips
 * it over and the suite flakes. Only the *ratio* of duration to budget carries
 * that signal, so this module reads the durations Bun already prints, resolves
 * each test's effective timeout, and reports the tests closest to their budget.
 *
 * Timeout resolution mirrors Bun's own precedence: an explicit third argument on
 * the declaration wins, otherwise the suite-wide `--timeout` applies. When no
 * explicit `--timeout` can be resolved from the command the gate stays disabled
 * and only the duration table is emitted -- a suite that never declared a budget
 * must not be judged against one it did not choose.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Emit a warning once a test consumes this share of its effective timeout. */
export const WARN_RATIO = 0.4;
/** Fail the step once a test consumes this share of its effective timeout. */
export const FAIL_RATIO = 0.7;
/** Bun's built-in per-test timeout, used only for reporting an unset budget. */
export const BUN_DEFAULT_TIMEOUT_MS = 5000;

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
  samples: BudgetedSample[];
  warnings: BudgetedSample[];
  failures: BudgetedSample[];
}

const ANSI = /\u001b\[[0-9;]*m/g;
const FILE_HEADER = /^(\S.*\.(?:test|spec)\.[cm]?[jt]sx?):$/u;
const RESULT_LINE = /^\((pass|fail)\)\s+(.+?)\s+\[([0-9]+(?:\.[0-9]+)?)ms\]$/u;

/**
 * Extract every `(pass|fail) name [Nms]` sample, attributing each to the test
 * file header Bun prints above its group. This is the same grammar used to mine
 * duration corpora from raw CI logs, so it is known to hold on both platforms.
 */
export function parseTestDurations(output: string): DurationSample[] {
  const samples: DurationSample[] = [];
  let file = "";
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI, "").trimEnd();
    const header = FILE_HEADER.exec(line.trim());
    if (header?.[1]) {
      file = header[1].replaceAll("\\", "/");
      continue;
    }
    const result = RESULT_LINE.exec(line.trim());
    if (!result) continue;
    const [, status, fullName, duration] = result;
    samples.push({
      file,
      name: (fullName as string).split(" > ").at(-1) ?? (fullName as string),
      fullName: fullName as string,
      status: status as "pass" | "fail",
      durationMs: Number(duration),
    });
  }
  return samples;
}

const DECLARATION_HEAD = "(?:\\.(?:only|skip|todo|failing|serial|concurrent))*\\s*\\(";
const CLOSER = /^(\s*)\},\s*([0-9][0-9_]*|[A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*;?\s*$/u;
const TRAILING_VALUE = /^\s*([0-9][0-9_]*|[A-Za-z_$][A-Za-z0-9_$]*)\s*,?\s*$/u;
const CALL_END = /^(\s*)\)\s*;?\s*$/u;
const NAME_LITERAL = /^\s*(["'`])((?:\\.|(?!\1).)*)\1/u;

function numericConstants(lines: string[]): Map<string, number> {
  const constants = new Map<string, number>();
  for (const line of lines) {
    const match = /^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*number\s*)?=\s*([0-9][0-9_]*)\s*;?\s*$/u.exec(line);
    if (match?.[1] && match[2]) constants.set(match[1], Number(match[2].replaceAll("_", "")));
  }
  return constants;
}

/** `test`, `it`, and any local alias bound to them (e.g. `const runTest = ... test.skip`). */
function declarationPattern(lines: string[]): RegExp {
  const names = new Set(["test", "it"]);
  for (const line of lines) {
    const match = /^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=[^;]*\b(?:test|it)\b/u.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  const alternation = [...names].map((name) => name.replace(/[$]/gu, "\\$")).join("|");
  return new RegExp(`^(\\s*)(?:${alternation})${DECLARATION_HEAD}`, "u");
}

function previousMeaningfulIndex(lines: string[], index: number): number {
  for (let back = index - 1; back >= 0; back--) if ((lines[back] as string).trim() !== "") return back;
  return -1;
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
 * Map declared test names to their explicit timeout argument.
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
      const head = lines.slice(back, back + 3).join(" ").slice((opener[0] as string).length);
      const name = NAME_LITERAL.exec(head)?.[2];
      if (name) record(name, value);
      break;
    }
  }
  return declared;
}

function timeoutIndex(rootDir: string): (file: string, name: string) => number | undefined {
  const cache = new Map<string, Map<string, number>>();
  return (file, name) => {
    if (!file) return undefined;
    let declared = cache.get(file);
    if (!declared) {
      const path = resolve(rootDir, file);
      declared = existsSync(path) ? declaredTimeouts(readFileSync(path, "utf8")) : new Map<string, number>();
      cache.set(file, declared);
    }
    return declared.get(name);
  };
}

/**
 * Resolve the suite-wide `--timeout` a command actually runs with, following one
 * `bun run <script>` indirection into package.json. Returns undefined when the
 * command declares no budget, which disables the gate rather than inventing one.
 */
export function resolveDefaultTimeoutMs(command: string[], rootDir: string): number | undefined {
  const direct = timeoutFromArgs(command);
  if (direct !== undefined) return direct;
  const script = scriptInvocation(command);
  if (!script) return undefined;
  const manifestPath = resolve(rootDir, script.cwd, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { scripts?: Record<string, string> };
  const body = manifest.scripts?.[script.name];
  return body ? timeoutFromArgs(body.split(/\s+/u)) : undefined;
}

/** Resolve `bun run [--cwd <dir>] [--bun] <script>` to its manifest directory and name. */
function scriptInvocation(command: string[]): { cwd: string; name: string } | undefined {
  const runIndex = command.indexOf("run");
  if (runIndex === -1) return undefined;
  let cwd = ".";
  for (let index = runIndex + 1; index < command.length; index++) {
    const part = command[index] as string;
    if (part === "--cwd" && command[index + 1]) {
      cwd = command[++index] as string;
      continue;
    }
    if (part.startsWith("-")) continue;
    return { cwd, name: part };
  }
  return undefined;
}

function timeoutFromArgs(args: string[]): number | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg.startsWith("--timeout=")) return Number(arg.slice("--timeout=".length));
    if (arg === "--timeout" && args[index + 1]) return Number(args[index + 1]);
  }
  return undefined;
}

/** Join durations to budgets and classify each sample against the two ratios. */
export function evaluateDurations(
  output: string,
  command: string[],
  rootDir: string = process.cwd(),
): DurationGuardReport {
  const defaultTimeoutMs = resolveDefaultTimeoutMs(command, rootDir);
  const lookup = timeoutIndex(rootDir);
  const samples: BudgetedSample[] = [];
  for (const sample of parseTestDurations(output)) {
    const explicitTimeout = lookup(sample.file, sample.name);
    const timeoutMs = explicitTimeout ?? defaultTimeoutMs ?? BUN_DEFAULT_TIMEOUT_MS;
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
  const warnings = enabled
    ? samples.filter((sample) => sample.ratio >= WARN_RATIO && sample.ratio < FAIL_RATIO)
    : [];
  return { enabled, defaultTimeoutMs, samples, warnings, failures };
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
    `Warn at ${WARN_RATIO * 100} % of budget, fail at ${FAIL_RATIO * 100} %. Samples: ${report.samples.length}.`,
    "",
    "| Budget used | Duration | Timeout | File | Test |",
    "|---|---|---|---|---|",
  ];
  const rows = report.samples.slice(0, limit).map(row);
  return [...header, ...(rows.length > 0 ? rows : ["| n/a | n/a | n/a | n/a | no duration samples parsed |"])].join("\n");
}
