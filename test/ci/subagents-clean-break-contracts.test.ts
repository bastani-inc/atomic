import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const guardPath = "test/ci/subagents-clean-break-contracts.test.ts";

function atomicSubagent(...parts: string[]): string {
	return ["ATOMIC", "SUBAGENT", ...parts].join("_");
}

function deletedEnvNames(): readonly string[] {
	return [
		atomicSubagent("ATTEMPT", "IDLE", "TIMEOUT", "MS"),
		atomicSubagent("ATTEMPT", "TIMEOUT", "MS"),
		atomicSubagent("ATTEMPT", "KILL", "GRACE", "MS"),
		atomicSubagent("CHILD"),
		atomicSubagent("FANOUT", "CHILD"),
		atomicSubagent("DEPTH"),
		atomicSubagent("MAX", "DEPTH"),
		atomicSubagent("PARENT", "EVENT", "SINK"),
		atomicSubagent("PARENT", "CONTROL", "INBOX"),
		atomicSubagent("PARENT", "ROOT", "RUN", "ID"),
		atomicSubagent("PARENT", "RUN", "ID"),
		atomicSubagent("PARENT", "CHILD", "INDEX"),
		atomicSubagent("PARENT", "DEPTH"),
		atomicSubagent("PARENT", "PATH"),
		atomicSubagent("PARENT", "CAPABILITY", "TOKEN"),
		atomicSubagent("INHERIT", "PROJECT", "CONTEXT"),
		atomicSubagent("INHERIT", "SKILLS"),
		atomicSubagent("INTERCOM", "SESSION", "NAME"),
		atomicSubagent("ORCHESTRATOR", "TARGET"),
		atomicSubagent("SUPERVISOR", "CAPABILITY"),
		atomicSubagent("SUPERVISOR", "SESSION", "ID"),
		atomicSubagent("RUN", "ID"),
		atomicSubagent("CHILD", "AGENT"),
		atomicSubagent("CHILD", "INDEX"),
		atomicSubagent("STRUCTURED", "OUTPUT", "CAPTURE"),
		atomicSubagent("STRUCTURED", "OUTPUT", "SCHEMA"),
		["ATOMIC", "CODEX", "FAST", "MODE"].join("_"),
		["MCP", "DIRECT", "TOOLS"].join("_"),
		["_", "_", "none", "_", "_"].join(""),
	];
}

const deletedModulePaths = [
	"packages/subagents/src/runs/shared/attempt-watchdog.ts",
	"packages/subagents/src/runs/shared/pi-args.ts",
	"packages/subagents/src/runs/shared/pi-spawn.ts",
	"packages/subagents/src/runs/shared/spawn-env.ts",
	"packages/subagents/src/runs/shared/final-drain.ts",
	"packages/subagents/src/runs/shared/subagent-prompt-runtime.ts",
	"packages/subagents/src/runs/background/async-event-journal.ts",
	"packages/subagents/src/runs/background/async-resume.ts",
	"packages/subagents/src/runs/background/async-status.ts",
	"packages/subagents/src/runs/background/top-level-async.ts",
	"packages/subagents/src/runs/background/completion-claims.ts",
	"packages/subagents/src/runs/background/completion-dedupe.ts",
	"packages/subagents/src/runs/background/stale-run-reconciler.ts",
	"packages/subagents/src/runs/background/run-status.ts",
	"packages/subagents/src/runs/background/run-id-resolver.ts",
	"packages/subagents/src/runs/background/parallel-groups.ts",
	"packages/subagents/src/runs/background/result-watcher.ts",
	"packages/subagents/src/runs/background/result-watcher-data.ts",
	"packages/subagents/src/runs/background/result-file-claims.ts",
	"packages/subagents/src/runs/background/result-delivery-processor.ts",
	"packages/subagents/src/runs/background/result-quarantine.ts",
	"packages/subagents/src/runs/background/result-retry-scheduler.ts",
	"packages/subagents/src/runs/background/result-status.ts",
	"packages/subagents/src/runs/inprocess/runtime-support/process-args.ts",
	"packages/subagents/src/runs/shared/nested-events-control.ts",
	"packages/subagents/src/runs/shared/nested-events-core.ts",
	"packages/subagents/src/runs/shared/nested-events-projection.ts",
	"packages/subagents/src/runs/shared/nested-events-registry.ts",
	"packages/subagents/src/runs/shared/nested-events-sanitize.ts",
	"packages/subagents/src/runs/shared/nested-path.ts",
	"packages/subagents/src/runs/shared/nested-render.ts",
	"packages/subagents/src/runs/foreground/execution-attempt.ts",
	"packages/subagents/src/runs/foreground/execution-attempt-control.ts",
	"packages/subagents/src/runs/foreground/execution-attempt-finalize.ts",
	"packages/subagents/src/runs/foreground/execution-attempt-types.ts",
] as const;

const deletedModulePatterns = [
	/^packages\/subagents\/src\/runs\/background\/subagent-runner[^/]*\.ts$/u,
	/^packages\/subagents\/src\/runs\/background\/async-execution-[^/]+\.ts$/u,
	/^packages\/subagents\/src\/runs\/background\/result-[^/]+\.ts$/u,
] as const;

function trackedFiles(): string[] {
	const result = spawnSyncCollect(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout
		.toString("utf8")
		.split("\0")
		.filter((file) => file.length > 0);
}

function isChangelogPath(file: string): boolean {
	return file.endsWith("CHANGELOG.md") || file.endsWith("/changelog.mdx");
}

function guardedSource(file: string): string {
	const source = readFileSync(join(root, file), "utf8");
	if (!isChangelogPath(file)) return source;
	const start = source.indexOf("## [Unreleased]");
	if (start < 0) return "";
	const nextSection = source.indexOf("\n## [", start + "## [Unreleased]".length);
	return source.slice(start, nextSection < 0 ? source.length : nextSection);
}

function scanPath(file: string): boolean {
	if (file === guardPath || file.startsWith("specs/") || file.startsWith("research/")) return false;
	if (file.startsWith("packages/coding-agent/dist/")) return false;
	if (file.includes("/test/") || file.startsWith("test/")) return false;
	return file.startsWith("packages/") || file.startsWith("scripts/");
}

test("the clean-break env bridge and CLI-child protocol stay absent", () => {
	const files = trackedFiles();
	for (const relative of files.filter(scanPath)) {
		const source = guardedSource(relative);
		for (const envName of deletedEnvNames()) {
			assert.equal(source.includes(envName), false, `${relative} reintroduced deleted environment key ${envName}`);
		}
		assert.equal(
			source.includes(["build", "Pi", "Args"].join("")),
			false,
			`${relative} reintroduced the deleted CLI argv builder`,
		);
		assert.equal(
			/--mode\s+json\s+-p/u.test(source),
			false,
			`${relative} reintroduced the deleted --mode json -p child protocol`,
		);
	}
	for (const relative of deletedModulePaths) {
		assert.equal(existsSync(join(root, relative)), false, `${relative} was reintroduced`);
	}
	for (const relative of files) {
		for (const pattern of deletedModulePatterns) {
			assert.equal(
				pattern.test(relative),
				false,
				`${relative} matches deleted process-era module pattern ${pattern}`,
			);
		}
	}
});
