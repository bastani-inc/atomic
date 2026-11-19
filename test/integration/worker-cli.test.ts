import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

/**
 * Names Atomic removed with workflows get no message of their own: each behaves exactly as a name Atomic never had,
 * through the same code path, so the comparison below runs both in fresh, identical directories.
 */
const cli = fileURLToPath(new URL("../../packages/coding-agent/src/cli.ts", import.meta.url));
const CLI_STARTUP_TIMEOUT_MS = 60_000;

interface Run {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** Every file the run left in the agent directory (a holder record named by its process ID as `<holder>`). */
	files: string[];
	settings: string;
}

function listFiles(dir: string, base = dir): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "cache" && dir === base ? [] : listFiles(path, base);
		return [
			relative(base, path)
				.replaceAll("\\", "/")
				.replace(/-holders\/\d+-\d+$/, "-holders/<holder>"),
		];
	});
}

/** One CLI run in a fresh directory whose global settings still carry a setting startup migrates. */
function run(args: string[], env: Record<string, string> = {}): Run {
	const root = makeTempDirectory("removed-cli-name-");
	try {
		const agentDir = join(root, "agent");
		const home = join(root, "home");
		mkdirSync(agentDir);
		mkdirSync(home);
		const settings = join(agentDir, "settings.json");
		writeFileSync(settings, JSON.stringify({ modelRouting: { auto: true } }));
		const values = Object.fromEntries(
			Object.entries(env).map(([name, value]) => [name, value.replaceAll("<root>", root)]),
		);
		const result = spawnSyncCollect([bunExecutable(), cli, ...args], {
			cwd: root,
			env: {
				...process.env,
				...values,
				HOME: home,
				USERPROFILE: home,
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_OFFLINE: "1",
			},
			timeout: CLI_STARTUP_TIMEOUT_MS,
		});
		const normalize = (text: string) => text.replaceAll(root, "<root>").replaceAll("\\", "/");
		return {
			exitCode: result.exitCode,
			stdout: normalize(result.stdout.toString()),
			stderr: normalize(result.stderr.toString()),
			files: listFiles(agentDir).sort(),
			settings: readFileSync(settings, "utf8"),
		};
	} finally {
		removeTempDirectory(root);
	}
}

test(
	"atomic worker runs exactly like any other first word",
	() => {
		for (const tail of [[], ["--help"], ["start", "--slots", "2"]]) {
			const unknown = run(["never-a-command", ...tail]);
			const worker = run(["worker", ...tail]);
			const label = ["worker", ...tail].join(" ");
			assert.deepEqual(
				worker,
				{
					...unknown,
					stdout: unknown.stdout.replaceAll("never-a-command", "worker"),
					stderr: unknown.stderr.replaceAll("never-a-command", "worker"),
				},
				label,
			);
		}
	},
	6 * CLI_STARTUP_TIMEOUT_MS,
);

test(
	"the workflow environment variables are ignored like any variable Atomic never read",
	() => {
		const values = ['{"path":"journal.sqlite"}', "<root>/legacy-journal.sqlite", "<root>/artifacts"];
		const removed = ["ATOMIC_WORKFLOWS_JOURNAL", "ATOMIC_WORKFLOW_JOURNAL_PATH", "ATOMIC_WORKFLOW_ARTIFACT_DIR"];
		const unknown = ["ATOMIC_NEVER_A_VARIABLE_1", "ATOMIC_NEVER_A_VARIABLE_2", "ATOMIC_NEVER_A_VARIABLE_3"];
		const env = (names: string[]) => Object.fromEntries(names.map((name, index) => [name, values[index]!]));
		for (const args of [
			["storage", "status"],
			["blueprint", "--help"],
		]) {
			assert.deepEqual(run(args, env(removed)), run(args, env(unknown)), args.join(" "));
		}
	},
	4 * CLI_STARTUP_TIMEOUT_MS,
);
