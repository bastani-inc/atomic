import { join } from "node:path";
import { repositoryRoot } from "../../../vitest.base.js";
import { readJson, readStreamText, spawnProcess } from "../../helpers/runtime.js";

/** Set to `1` to make a fixture opt out of the shared default agent directory, as a test of the default home does. */
export const OPT_OUT_ENV = "REAL_HOME_GUARD_FIXTURE_OPT_OUT";
/** Where a fixture writes what it observed. */
export const OUTCOME_ENV = "REAL_HOME_GUARD_FIXTURE_OUTCOME";

/**
 * Structural: each run starts a real vitest process that transforms the module graph its fixture loads. Named and kept
 * at the call sites, per the per-test timeout policy in AGENTS.md.
 */
export const CHILD_VITEST_TIMEOUT_MS = 120_000;

export interface FixtureRun<Outcome> {
	readonly exitCode: number;
	readonly output: string;
	readonly status: string;
	/** What vitest reported for the fixture's test when it failed: the guard's refusal when only its check failed it. */
	readonly failure: string;
	readonly outcome: Outcome;
}

/**
 * Run one fixture of this directory in a child vitest under the shared test setup. The child starts without any
 * agent, session or storage selection of its own, so only the setup's default and `env` decide where it reads and
 * writes; `name` keeps each run's report and outcome apart in `scratch`.
 */
export async function runGuardFixture<Outcome>(
	fixture: string,
	scratch: string,
	name: string,
	env: Record<string, string>,
): Promise<FixtureRun<Outcome>> {
	const report = join(scratch, `${name}-report.json`);
	const outcomeFile = join(scratch, `${name}-outcome.json`);
	const child = spawnProcess(
		[
			process.execPath,
			join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
			"--run",
			"--config",
			join(repositoryRoot, "test", "fixtures", "real-home-storage-guard", "vitest.config.ts"),
			"--reporter=json",
			"--outputFile",
			report,
			fixture,
		],
		{
			cwd: repositoryRoot,
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: undefined,
				PI_CODING_AGENT_DIR: undefined,
				ATOMIC_CODING_AGENT_SESSION_DIR: undefined,
				PI_CODING_AGENT_SESSION_DIR: undefined,
				ATOMIC_SESSIONS_STORAGE: undefined,
				ATOMIC_STORAGE: undefined,
				ATOMIC_PROFILE: undefined,
				[OUTCOME_ENV]: outcomeFile,
				...env,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		readStreamText(child.stdout),
		readStreamText(child.stderr),
		child.exited,
	]);
	const output = stdout + stderr;
	const results = await readJson<{
		testResults: { assertionResults: { status: string; failureMessages: string[] }[] }[];
	}>(report);
	const result = results.testResults[0]?.assertionResults[0];
	return {
		exitCode,
		output,
		status: result?.status ?? "missing",
		failure: result?.failureMessages.join("\n") ?? "",
		outcome: await readJson<Outcome>(outcomeFile),
	};
}
