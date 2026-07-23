#!/usr/bin/env bun
/** Bounded CI-only flake recovery: one retry with durable first-attempt diagnostics. */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, platform, release, totalmem } from "node:os";
import { basename, resolve } from "node:path";

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
    if (args[i] === "--") { i++; break; }
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
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tests";
}

async function runAttempt(command: string[], logPath: string, persist: boolean): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env: process.env });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = `${stdout}${stderr}`;
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (persist) writeFileSync(logPath, output);
  return { code, output };
}

function debugSummary(label: string, command: string[]): string {
  const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return [
    `suite: ${label}`,
    `command: ${command.join(" ")}`,
    `platform: ${platform()} ${release()} (${process.arch})`,
    `bun: ${Bun.version}`,
    `cpu: ${cpus().length} logical`,
    `memory: ${gib(freemem())} free / ${gib(totalmem())} total`,
    `loadavg: ${loadavg().map((value) => value.toFixed(2)).join(", ")}`,
    `cwd: ${process.cwd()}`,
  ].join("\n");
}

function appendSummary(markdown: string): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${markdown}\n`);
}

function findFailedDeterministicFile(output: string, files: string[]): string | undefined {
  let current: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = files.find((file) => trimmed.endsWith(`${file}:`));
    if (header) {
      current = header;
      continue;
    }
    if (/\.(?:test|spec)\.[cm]?[jt]sx?:$/.test(trimmed)) current = undefined;
    if (current && trimmed.startsWith("(fail)")) return current;
  }
  return undefined;
}

const options = parseArgs();
const name = safeName(options.label);
const firstLog = resolve(options.diagnosticsDir, `${name}-attempt-1.log`);
const secondLog = resolve(options.diagnosticsDir, `${name}-attempt-2.log`);
rmSync(firstLog, { force: true });
rmSync(secondLog, { force: true });

const first = await runAttempt(options.command, firstLog, false);
if (first.code === 0) process.exit(0);

mkdirSync(options.diagnosticsDir, { recursive: true });
writeFileSync(firstLog, first.output);
const debug = debugSummary(options.label, options.command);
writeFileSync(resolve(options.diagnosticsDir, `${name}-debug.txt`), `${debug}\n`);
console.error(`\n::warning title=${options.label} first attempt failed::Preserved diagnostics; evaluating one bounded retry.`);
console.error(`\n${debug}\n`);

const deterministicHit = findFailedDeterministicFile(first.output, options.deterministicFiles);
if (deterministicHit) {
  appendSummary(`### ❌ ${options.label}\nNo retry: deterministic test file failed (\`${deterministicHit}\`). First-attempt diagnostics were preserved.`);
  console.error(`No retry: deterministic test file failed (${deterministicHit}).`);
  process.exit(first.code);
}

console.error(`Retrying ${options.label} once (smallest safe suite)...`);
const second = await runAttempt(options.command, secondLog, true);
if (second.code === 0) {
  appendSummary(`### ⚠️ Detected flake: ${options.label}\nAttempt 1 failed and the single bounded retry passed. Diagnostic logs are retained as CI artifacts.`);
  console.error(`::warning title=Detected flake: ${options.label}::Attempt 1 failed; bounded retry passed. See diagnostic artifact.`);
  process.exit(0);
}
appendSummary(`### ❌ Persistent failure: ${options.label}\nBoth the first attempt and the single bounded retry failed. Both logs are retained.`);
console.error(`::error title=Persistent failure: ${options.label}::Both attempts failed; see both diagnostic logs.`);
process.exit(second.code);
