import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import { SettingsManager } from "../settings-manager.ts";
import { removeRestoredWorktree } from "../worktree-snapshot/restore.ts";
import { ResumePreconditionError, type ResumePreconditionProblem } from "./errors.ts";
import { defaultResumePreflightIo, gitUnavailableProblem, type ResumePreflightIo } from "./preflight.ts";
import { resumeStoreDir, savedProjectTrust } from "./session-resume.ts";
import { ensureResumeSetup, predictedSetupProblem, type ResumeSetupConfig } from "./setup-hook.ts";

/** A checkout a workflow run's resume restores, with the environment fingerprint its snapshot recorded. */
export interface RunWorktreeTarget {
	readonly root: string;
	readonly envHash: string;
}

export interface RunResumeSetupOptions {
	readonly signal?: AbortSignal;
	readonly io?: ResumePreflightIo;
}

/**
 * The worktree store and setup hook configuration of Atomic's agent directory. `resume.setupCommand` and the default
 * project trust are global settings, so no project's settings are read.
 */
function runSetupConfig(): { readonly storeDir: string; readonly setup: ResumeSetupConfig } {
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
	return {
		storeDir: resumeStoreDir(agentDir),
		setup: { command: settings.getResumeSetupCommand(), trusted: savedProjectTrust(agentDir, settings) },
	};
}

/**
 * The unmet preconditions of restoring a workflow run's `missing` checkouts on this node, checked before the resume
 * claims the run: Git can be started, and a setup hook could run for a snapshot with dependency inputs. Returns one
 * `ResumePreconditionError` (entry point `workflow-resume`) listing every unmet piece, or undefined.
 */
export async function runRestorePreconditionError(
	runId: string,
	missing: readonly RunWorktreeTarget[],
	options: RunResumeSetupOptions = {},
): Promise<ResumePreconditionError | undefined> {
	if (missing.length === 0) return undefined;
	const io = options.io ?? defaultResumePreflightIo;
	const { storeDir, setup } = runSetupConfig();
	const problems: ResumePreconditionProblem[] = [];
	const git = await io.probeGit(options.signal);
	if (git) {
		problems.push(
			gitUnavailableProblem(
				git,
				`workflow run ${runId} must restore ${missing.map((target) => target.root).join(", ")}, which this node does not have`,
			),
		);
	}
	for (const target of missing) {
		const problem = await predictedSetupProblem(target.envHash, join(storeDir, "worktrees"), setup);
		if (problem) {
			problems.push(problem);
			break;
		}
	}
	return problems.length === 0
		? undefined
		: new ResumePreconditionError({ entryPoint: "workflow-resume", problems }, git);
}

/**
 * Runs the setup hook in each worktree a workflow run's resume restored, once per worktree and environment. When any
 * hook is missing, fails or is cancelled, every worktree in `restored` is removed again (a removal failure is kept as
 * the error's `cleanupCause`) and the error is rethrown, so the next resume restores and sets up from scratch.
 */
export async function setUpRestoredRunWorktrees(
	restored: readonly RunWorktreeTarget[],
	options: RunResumeSetupOptions = {},
): Promise<void> {
	const { storeDir, setup } = runSetupConfig();
	try {
		for (const target of restored) {
			await ensureResumeSetup({
				entryPoint: "workflow-resume",
				worktree: target.root,
				envHash: target.envHash,
				storeDir,
				config: setup,
				signal: options.signal,
			});
		}
	} catch (error) {
		const failures: unknown[] = [];
		for (const target of restored) {
			await removeRestoredWorktree(target.root).catch((cleanup: unknown) => {
				failures.push(cleanup);
			});
		}
		if (failures.length > 0 && error instanceof Error) {
			Object.defineProperty(error, "cleanupCause", {
				value: failures.length === 1 ? failures[0] : new AggregateError(failures, "worktree cleanup failed"),
				enumerable: false,
			});
		}
		throw error;
	}
}
