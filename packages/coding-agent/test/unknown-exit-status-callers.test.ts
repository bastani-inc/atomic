import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { openStepLog, runLoggedProcess } from "../src/core/resume/blueprint/process.ts";
import { runSection } from "../src/core/resume/blueprint/steps.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { ChildProcessExitStatusUnknownError } from "../src/utils/child-process.ts";

let failUnknown = false;

vi.mock("../src/utils/child-process.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/child-process.ts")>();
	return {
		...actual,
		waitForChildProcess: async (...args: Parameters<typeof actual.waitForChildProcess>) => {
			await actual.waitForChildProcess(...args);
			if (failUnknown) {
				throw new actual.ChildProcessExitStatusUnknownError(args[0].pid);
			}
			return 0;
		},
	};
});

describe("callers surface explicit exit status unknown failure and never report 0", () => {
	afterEach(() => {
		failUnknown = false;
	});

	it("execCommand reports non-zero failure with unknown exit status message", async () => {
		failUnknown = true;
		const result = await execCommand(
			process.execPath,
			["-e", 'console.error("stderr-line"); process.exit(0)'],
			tmpdir(),
		);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /stderr-line/);
		assert.match(result.stderr, /exit status unknown/i);
	});

	it("bash tool rejects with captured output and unknown exit status message", async () => {
		failUnknown = true;
		const bashTool = createBashToolDefinition(tmpdir());
		await expect(
			bashTool.execute("call-1", { command: "echo hi-before-unknown" }, undefined, undefined, {} as never),
		).rejects.toThrow(/hi-before-unknown[\s\S]*exit status unknown/i);
	});

	it.runIf(process.platform === "win32")(
		"blueprint runLoggedProcess and runSection record explicit unknown exit status failure on Windows",
		async () => {
			failUnknown = true;
			const dir = mkdtempSync(join(tmpdir(), "atomic-unknown-blueprint-"));
			try {
				const log = await openStepLog(join(dir, "step.log"));
				try {
					const exit = await runLoggedProcess(
						{
							command: process.execPath,
							args: ["-e", "process.exit(0)"],
							cwd: dir,
							env: { ...process.env },
						},
						log,
						{ timeoutMs: 30_000 },
					);
					assert.equal(exit.exitStatus, null);
					assert.equal(exit.spawnError, undefined);
					assert.ok(exit.exitError instanceof ChildProcessExitStatusUnknownError);
				} finally {
					await log.close();
				}

				const section = await runSection("maintenance", [{ kind: "run", name: "check", run: "exit 0", env: {} }], {
					blueprint: join(dir, ".atomic", "blueprint.yaml"),
					scope: "repository",
					cwd: dir,
					shell: "bash",
					platform: "windows",
					envrcPath: join(dir, "envrc"),
					logDirectory: dir,
					logPrefix: "test",
					timeoutMs: 30_000,
					environment: { ...process.env },
					actionsCacheDir: join(dir, "actions"),
				});
				assert.ok(section.failure !== undefined);
				assert.match(section.failure.error.message, /ended with an unknown exit status/);
				assert.ok(section.failure.logPath !== null);
				assert.match(readFileSync(section.failure.logPath, "utf8"), /# exit status unknown/);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
