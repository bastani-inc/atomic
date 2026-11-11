/** The most session aliases kept for one run's stages; the oldest is forgotten first. */
export const WORKFLOW_STAGE_ALIASES_PER_RUN_MAX = 256;

/** The stage a session alias stands for: its run, its canonical `workflow:` target and the stage's own group. */
export interface WorkflowStageAlias {
	readonly runId: string;
	readonly target: string;
	readonly group: string;
}

const normalizeAlias = (alias: string): string => alias.trim().toLowerCase();

/**
 * #4639: the names and ids every session of a workflow stage registered under, kept per run, so a send to a stage's
 * `subagent-chat-<id>` name or session id reaches the stage through its `workflow:` target even after that session was
 * replaced or released: the canonical target routes to the stage's current session, or queues for it in the run's
 * queue while it has none. Aliases live as long as their run's route; the broker forgets a run's aliases with it.
 */
export class WorkflowStageAliases {
	private readonly byAlias = new Map<string, WorkflowStageAlias>();
	private readonly byRun = new Map<string, Set<string>>();

	constructor(private readonly perRunMax = WORKFLOW_STAGE_ALIASES_PER_RUN_MAX) {}

	/** Aliases kept, across every run. */
	get size(): number {
		return this.byAlias.size;
	}

	/** Remember that a session of the stage at `stage.target` registered under these aliases. */
	record(stage: WorkflowStageAlias, aliases: readonly string[]): void {
		for (const raw of aliases) {
			const alias = normalizeAlias(raw);
			if (alias.length === 0) continue;
			const previous = this.byAlias.get(alias);
			// Every alias kept is in its run's set.
			if (previous !== undefined) (this.byRun.get(previous.runId) as Set<string>).delete(alias);
			let run = this.byRun.get(stage.runId);
			if (run === undefined) {
				run = new Set();
				this.byRun.set(stage.runId, run);
			}
			run.add(alias);
			this.byAlias.set(alias, { runId: stage.runId, target: stage.target, group: stage.group });
			if (run.size > this.perRunMax) {
				const oldest = run.values().next().value as string;
				run.delete(oldest);
				this.byAlias.delete(oldest);
			}
		}
	}

	resolve(alias: string): WorkflowStageAlias | undefined {
		return this.byAlias.get(normalizeAlias(alias));
	}

	/** The run's route is gone: none of its stages is reachable through an alias any more. */
	forgetRun(runId: string): void {
		const run = this.byRun.get(runId);
		if (run === undefined) return;
		for (const alias of run) this.byAlias.delete(alias);
		this.byRun.delete(runId);
	}

	/** Aliases and runs held now; counted by tests. */
	sizes(): { readonly aliases: number; readonly runs: number } {
		return { aliases: this.byAlias.size, runs: this.byRun.size };
	}
}
