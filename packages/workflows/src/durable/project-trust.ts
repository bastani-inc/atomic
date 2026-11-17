import { formatProjectTrustPrompt, getAgentDir, getProjectTrustOptions, ProjectTrustStore } from "@bastani/atomic";

/** How to trust the project folder `projectDir`, for a refusal to load its workflows. */
export function projectTrustInstruction(projectDir: string): string {
	return `Start Atomic in ${projectDir} and use /trust to trust it`;
}

/**
 * A workflow was looked up in a project folder that is not trusted, so the folder's workflow modules
 * were not loaded.
 */
export class WorkflowProjectNotTrustedError extends Error {
	override readonly name = "WorkflowProjectNotTrustedError";
	readonly workflow: string;
	readonly projectDir: string;

	constructor(workflow: string, projectDir: string) {
		super(
			`Workflow "${workflow}" is defined in ${projectDir}, which is not a trusted project, so its workflows are not loaded. ${projectTrustInstruction(projectDir)}, then try again.`,
		);
		this.workflow = workflow;
		this.projectDir = projectDir;
	}
}

/**
 * Asks whether to trust a project folder with the startup trust prompt's question and choices, and
 * saves the answer the way that prompt does. Resolves whether the folder is trusted now.
 */
export function projectTrustPrompt(
	select: (title: string, options: string[]) => Promise<string | undefined>,
): (projectDir: string) => Promise<boolean> {
	return async (projectDir) => {
		const options = getProjectTrustOptions(projectDir, { includeSessionOnly: true });
		const answer = await select(
			formatProjectTrustPrompt(projectDir),
			options.map((option) => option.label),
		);
		const selected = options.find((option) => option.label === answer);
		if (selected === undefined) return false;
		if (selected.updates.length > 0) await new ProjectTrustStore(getAgentDir()).setManyAsync(selected.updates);
		return selected.trusted;
	};
}
