import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { ExecOptions, ExecResult } from "../src/core/extensions/index.ts";
import type { FeedbackSessionFacts } from "../src/extensions/feedback/index.ts";
import {
	FeedbackDebuggerProtocolError,
	FeedbackInvestigationController,
	INVESTIGATION_UNAVAILABLE,
} from "../src/extensions/feedback/investigation.ts";
import {
	captureWorkingTreeSnapshot,
	compareWorkingTreeSnapshots,
	type FeedbackExec,
	formatWorkingTreeDisclosure,
} from "../src/extensions/feedback/working-tree.ts";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function facts(): FeedbackSessionFacts {
	return {
		version: "1.2.3-alpha.4",
		platform: "darwin",
		architecture: "arm64",
		runtime: "Bun 1.4.0",
		mode: "tui",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		nonBuiltinExtensionsLoaded: true,
		recentFailedOutcomes: ["Tool bash failed"],
		sessionErrorState: "present",
	};
}

function git(directory: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: directory,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

const execGit: FeedbackExec = async (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
	assert.equal(command, "git");
	try {
		return {
			stdout: execFileSync(command, args, {
				cwd: options?.cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
			stderr: "",
			code: 0,
			killed: false,
		};
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string; status?: number };
		return {
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
			code: failure.status ?? 1,
			killed: false,
		};
	}
};

function createRepository(): string {
	const directory = mkdtempSync(join(tmpdir(), "atomic-feedback-tree-"));
	tempDirectories.push(directory);
	git(directory, ["init", "-q"]);
	git(directory, ["config", "user.name", "Feedback Test"]);
	git(directory, ["config", "user.email", "feedback@example.invalid"]);
	writeFileSync(join(directory, "tracked.txt"), "base\n");
	git(directory, ["add", "tracked.txt"]);
	git(directory, ["commit", "-qm", "fixture"]);
	return directory;
}

describe("feedback debugger handoff", () => {
	test("rewrites one existing foreground debugger call with the report-only objective and normal model policy", () => {
		const prompt = "  exact report\nwith two  spaces  ";
		const controller = new FeedbackInvestigationController({
			prompt,
			facts: facts(),
			debuggerToolAvailable: true,
		});
		const input: Record<string, unknown> = {
			agent: "debugger",
			task: "replace this",
			model: "override/model",
			context: "fork",
			worktree: true,
		};

		assert.equal(controller.handleSubagentCall("debug-call", input), undefined);
		assert.equal(input.agent, "debugger");
		assert.equal(typeof input.task, "string");
		const task = input.task as string;
		assert.ok(task.endsWith(prompt));
		assert.match(task, /investigation and report only/i);
		assert.match(task, /Do not intentionally implement/i);
		assert.match(task, /Do not reset, clean, stash, or overwrite pre-existing tracked or untracked/);
		assert.match(task, /Do not launch a workflow, create or customize another agent/);
		assert.match(task, /no wall-clock or tool-call limit/i);
		assert.match(task, /Atomic version: 1\.2\.3-alpha\.4/);
		assert.match(task, /Non-builtin extensions loaded: yes/);
		assert.equal("model" in input, false);
		assert.equal("context" in input, false);
		assert.equal("worktree" in input, false);

		controller.handleSubagentResult("debug-call", "completed");
		assert.equal(controller.assess("bug").status, "available");
	});

	test("rejects duplicate, non-debugger, parallel, and enhancement debugger activity", () => {
		const duplicate = new FeedbackInvestigationController({
			prompt: "bug",
			facts: facts(),
			debuggerToolAvailable: true,
		});
		assert.equal(duplicate.handleSubagentCall("first", { agent: "debugger" }), undefined);
		assert.deepEqual(duplicate.handleSubagentCall("second", { agent: "debugger" }), {
			block: true,
			reason: "Feedback bug investigation already launched.",
		});
		assert.throws(() => duplicate.assess("bug"), FeedbackDebuggerProtocolError);

		for (const input of [{ agent: "worker" }, { tasks: [{ agent: "debugger", task: "bug" }] }]) {
			const invalid = new FeedbackInvestigationController({
				prompt: "bug",
				facts: facts(),
				debuggerToolAvailable: true,
			});
			assert.equal(invalid.handleSubagentCall("invalid", input)?.block, true);
			assert.throws(() => invalid.assess("bug"), FeedbackDebuggerProtocolError);
		}

		const enhancement = new FeedbackInvestigationController({
			prompt: "please add a feature",
			facts: facts(),
			debuggerToolAvailable: true,
		});
		assert.equal(enhancement.assess("enhancement").status, "not-required");
		assert.equal(enhancement.handleSubagentCall("wrong", { agent: "debugger" }), undefined);
		assert.throws(() => enhancement.assess("enhancement"), FeedbackDebuggerProtocolError);
	});

	test("rejects a bug submission before the available debugger has run", () => {
		// #2799: zero debugger runs must not degrade when the tool exists.
		const controller = new FeedbackInvestigationController({
			prompt: "bug",
			facts: facts(),
			debuggerToolAvailable: true,
		});

		assert.throws(
			() => controller.assess("bug"),
			/Feedback bug submission requires one foreground debugger investigation before preview\./u,
		);
	});

	test("keeps the raw report and marks unavailable, failed, or interrupted investigation honestly", () => {
		const prompt = " original bug text ";
		const unavailable = new FeedbackInvestigationController({
			prompt,
			facts: facts(),
			debuggerToolAvailable: false,
		});
		assert.deepEqual(unavailable.assess("bug"), {
			status: "unavailable",
			message: INVESTIGATION_UNAVAILABLE,
			prompt,
			nonBuiltinExtensionsLoaded: true,
			workingTree: undefined,
		});

		for (const failure of ["failed", "interrupted"] as const) {
			const controller = new FeedbackInvestigationController({
				prompt,
				facts: facts(),
				debuggerToolAvailable: true,
			});
			assert.equal(controller.handleSubagentCall("debug", { agent: "debugger" }), undefined);
			controller.handleSubagentResult("debug", failure);
			const assessment = controller.assess("bug");
			assert.equal(assessment.status, "unavailable");
			assert.equal(assessment.message, INVESTIGATION_UNAVAILABLE);
			assert.equal(assessment.prompt, prompt);
			assert.equal("diagnosis" in assessment, false);
		}
	});
});

describe("feedback working-tree disclosure", () => {
	test("preserves caller changes and reports only new or subsequently changed debugger artifacts", async () => {
		const directory = createRepository();
		writeFileSync(join(directory, "tracked.txt"), "user change\n");
		writeFileSync(join(directory, "user notes.txt"), "keep exact\n");
		const before = await captureWorkingTreeSnapshot(directory, execGit);

		mkdirSync(join(directory, "diagnostics"));
		writeFileSync(join(directory, "diagnostics", "debug.log"), "synthetic diagnostic\n");
		const after = await captureWorkingTreeSnapshot(directory, execGit);
		const disclosure = compareWorkingTreeSnapshots(before, after);

		assert.equal(disclosure.status, "changed");
		assert.equal(disclosure.preExistingChangesPreserved, true);
		assert.deepEqual(
			disclosure.artifacts.map((artifact) => ({ path: artifact.path, change: artifact.change })),
			[{ path: "diagnostics/debug.log", change: "created" }],
		);
		assert.equal(readFileSync(join(directory, "tracked.txt"), "utf8"), "user change\n");
		assert.equal(readFileSync(join(directory, "user notes.txt"), "utf8"), "keep exact\n");

		writeFileSync(join(directory, "tracked.txt"), "debugger overwrote user change\n");
		const overwritten = compareWorkingTreeSnapshots(before, await captureWorkingTreeSnapshot(directory, execGit));
		assert.equal(overwritten.preExistingChangesPreserved, false);
		assert.deepEqual(
			overwritten.artifacts.map((artifact) => artifact.path),
			["tracked.txt", "diagnostics/debug.log"],
		);
	});

	test("degrades without assuming the cwd is an Atomic checkout", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-feedback-installed-"));
		tempDirectories.push(directory);
		writeFileSync(join(directory, "installed.txt"), "not a checkout\n");

		const before = await captureWorkingTreeSnapshot(directory, execGit);
		const after = await captureWorkingTreeSnapshot(directory, execGit);
		assert.deepEqual(before, {
			cwd: directory,
			status: "unavailable",
			entries: [],
		});
		assert.deepEqual(compareWorkingTreeSnapshots(before, after), {
			status: "unavailable",
			preExistingChangesPreserved: undefined,
			artifacts: [],
		});
	});

	test("captures state with a read-only Git command and never resets, cleans, or stashes", async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const exec: FeedbackExec = async (command, args) => {
			calls.push({ command, args });
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		await captureWorkingTreeSnapshot("/installed/atomic", exec);
		assert.deepEqual(calls, [
			{
				command: "git",
				args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			},
		]);
	});

	test("renders ordered artifact paths without file contents", () => {
		const text = formatWorkingTreeDisclosure({
			status: "changed",
			preExistingChangesPreserved: true,
			artifacts: [
				{ path: "diagnostics/first.log", status: "??", change: "created" },
				{ path: "src/existing.ts", status: " M", change: "changed" },
			],
		});
		assert.equal(
			text,
			"Working-tree disclosure: pre-existing changes were preserved.\n" +
				"Debugger changes or artifacts left in place:\n" +
				"- created: diagnostics/first.log\n" +
				"- changed: src/existing.ts",
		);
		assert.doesNotMatch(text, /synthetic diagnostic|file contents/i);
	});
});
