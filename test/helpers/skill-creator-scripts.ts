import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { makeTempDirectory, moduleDir, sleep } from "./runtime.js";

const root = resolve(moduleDir(import.meta.url), "../..");
export const skillCreatorDir = join(root, "packages/subagents/skills/skill-creator");
export const fakeAtomic = join(root, "test/fixtures/skill-creator/fake-atomic.py");

/** A Python 3.10+ interpreter, the oldest the skill-creator scripts support, or undefined when none is installed. */
function findPython(): string | undefined {
	for (const candidate of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
		const probe = spawnSync(
			candidate,
			["-c", "import sys; print(sys.executable); sys.exit(sys.version_info < (3, 10))"],
			{
				encoding: "utf8",
			},
		);
		if (probe.status === 0) return probe.stdout.trim();
	}
	return undefined;
}

export const python = findPython();

/** The variables a script's environment keeps from the test's: what Python and `cmd.exe` need to start on Windows. */
function inheritedEnvironment(): Record<string, string> {
	const inherited: Record<string, string> = {};
	for (const key of ["SystemRoot", "ComSpec", "PATHEXT", "WINDIR", "LANG", "LC_ALL"]) {
		const value = process.env[key];
		if (value !== undefined) inherited[key] = value;
	}
	return inherited;
}

/**
 * Whether that interpreter imports PyYAML, which package_skill and quick_validate read SKILL.md's frontmatter with, in an
 * environment like the scripts' own (a package installed for the user only, under %APPDATA%, is not found there).
 */
export const pyyaml =
	python !== undefined &&
	spawnSync(python, ["-c", "import yaml"], { env: { ...inheritedEnvironment(), PATH: process.env.PATH ?? "" } })
		.status === 0;

/**
 * Whether that interpreter also imports PyYAML in isolated mode (`-I`), which ignores user site-packages even where
 * POSIX still resolves the user's home directory without `HOME`.
 */
export const pyyamlIsolated =
	python !== undefined &&
	spawnSync(python, ["-I", "-c", "import yaml"], { env: { ...inheritedEnvironment(), PATH: process.env.PATH ?? "" } })
		.status === 0;

/** CI installs PyYAML and sets ATOMIC_REQUIRE_PYYAML=1: there, the tests that need it must run, never skip. */
export const pyyamlRequired = process.env.ATOMIC_REQUIRE_PYYAML === "1";

/** What the fake `atomic` recorded about one start. */
export interface FakeAtomicRecord {
	readonly pid: number;
	readonly ppid: number;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly prompt: string;
	readonly scenario: string;
	readonly heap: string | null;
	readonly tstp_blocked_at_start: boolean | null;
	readonly skill: string | null;
	readonly child?: number;
	readonly grandchild?: number;
}

/** Every process a fake `atomic` start left a record of: itself, its child and that child's child. */
export function startedPids(records: readonly FakeAtomicRecord[]): number[] {
	return records.flatMap((record) => [record.pid, record.child, record.grandchild].filter((pid) => pid !== undefined));
}

/** A sandbox with a fake `atomic` first on PATH, a skill, a project folder and a private temporary folder. */
export interface ScriptSandbox {
	readonly dir: string;
	readonly project: string;
	readonly skill: string;
	readonly temp: string;
	readonly log: string;
	env(extra?: Record<string, string>): Record<string, string>;
	records(): FakeAtomicRecord[];
	waitForRecords(count: number, timeoutMs: number): Promise<FakeAtomicRecord[]>;
	writeEvalSet(items: readonly { query: string; should_trigger: boolean }[]): string;
}

export function createScriptSandbox(prefix: string): ScriptSandbox {
	if (python === undefined) throw new Error("Python 3.10 or later is required");
	const dir = makeTempDirectory(prefix);
	const bin = join(dir, "bin");
	const project = join(dir, "project");
	const skill = join(dir, "skill");
	const temp = join(dir, "temp");
	const log = join(dir, "log");
	for (const path of [bin, project, skill, temp, log]) mkdirSync(path);
	if (process.platform === "win32") {
		writeFileSync(join(bin, "atomic.cmd"), `@"${python}" "${fakeAtomic}" %*\r\n`);
	} else {
		writeFileSync(join(bin, "atomic"), `#!/bin/sh\nexec "${python}" "${fakeAtomic}" "$@"\n`);
		chmodSync(join(bin, "atomic"), 0o755);
	}
	writeFileSync(
		join(skill, "SKILL.md"),
		"---\nname: sample\ndescription: Use this skill for sample reports.\n---\n# Sample\n",
	);
	const records = (): FakeAtomicRecord[] =>
		readdirSync(log)
			.filter((name) => name.endsWith(".json"))
			.map((name) => JSON.parse(readFileSync(join(log, name), "utf8")) as FakeAtomicRecord);
	return {
		dir,
		project,
		skill,
		temp,
		log,
		env(extra = {}) {
			return {
				...inheritedEnvironment(),
				PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
				PYTHONPATH: skillCreatorDir,
				PYTHONDONTWRITEBYTECODE: "1",
				PYTHONIOENCODING: "utf-8",
				TMPDIR: temp,
				TEMP: temp,
				TMP: temp,
				FAKE_ATOMIC_LOG: log,
				// No browser opens during a test.
				BROWSER: process.platform === "win32" ? "" : "true",
				...extra,
			};
		},
		records,
		async waitForRecords(count, timeoutMs) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const found = records();
				if (found.length >= count) return found;
				if (Date.now() > deadline) throw new Error(`expected ${count} atomic starts, saw ${found.length}`);
				await sleep(25);
			}
		},
		writeEvalSet(items) {
			const path = join(dir, `eval-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
			writeFileSync(path, JSON.stringify(items));
			return path;
		},
	};
}

/** Whether a process exists (a zombie the test's own children leave counts as gone on Linux). */
export function processRuns(pid: number): boolean {
	if (process.platform === "linux" && existsSync(`/proc/${pid}/stat`)) {
		const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.[0];
		return state !== "Z" && state !== "X";
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

/** Waits until none of `pids` runs, or fails after `timeoutMs`. */
export async function waitUntilGone(pids: readonly number[], timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const running = pids.filter(processRuns);
		if (running.length === 0) return;
		if (Date.now() > deadline) throw new Error(`still running: ${running.join(", ")}`);
		await sleep(25);
	}
}

/** The first line a stream prints, without its line ending (LF, or CRLF as Windows writes it). */
export async function readLine(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	return readUntil(stream, /^(.*)\r?\n/u);
}

/** The first capture group of `pattern` in what a stream prints, once it appears; fails if the stream ends first. */
export async function readUntil(stream: ReadableStream<Uint8Array> | null, pattern: RegExp): Promise<string> {
	if (stream === null) throw new Error("the stream is not piped");
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		for (;;) {
			const match = pattern.exec(text);
			if (match) return match[1] ?? "";
			const { value, done } = await reader.read();
			if (done) throw new Error(`output ended before ${pattern}: ${text}`);
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}
