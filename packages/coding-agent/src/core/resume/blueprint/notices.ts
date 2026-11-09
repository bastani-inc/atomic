import { type BlueprintBuildOutcome, type BlueprintFailure, SETUP_COMMAND_ALIAS } from "./build.ts";

/** A line a resume shows the user. */
export interface BlueprintNotice {
	readonly type: "info" | "warning";
	readonly message: string;
}

function repositoryFailure(failure: BlueprintFailure): string {
	return `Partial build: ${failure.error.message} The rest of that blueprint did not run; the other blueprints were built.`;
}

function repositoryClause(failure: BlueprintFailure): string {
	const { section, phase } = failure.error.fields as { section?: unknown; phase?: unknown };
	if (section === "post-build") return ", and the repositories were set up before it ran";
	if (
		section === "initialize" ||
		section === "maintenance" ||
		phase === "read-blueprint" ||
		failure.error.code === "blueprint-invalid"
	) {
		return ", but repository setup did not run";
	}
	return ", but repository setup may not have run";
}

function globalFailure(failure: BlueprintFailure): string {
	return `Blueprint build FAILED: ${failure.error.message} The session resumed anyway${repositoryClause(failure)}.`;
}

/**
 * The warnings a build earns: one per blueprint that failed (`Partial build` for a repository or workspace, a
 * prominent `Blueprint build FAILED` for the global blueprint or its post-build), each naming the blueprint and the
 * failing step, plus the deprecation notice when the `resume.setupCommand` alias ran. A build that was skipped or found
 * no blueprint, and one that succeeded, say nothing.
 */
export function blueprintNotices(outcome: BlueprintBuildOutcome, aliasConfigured: boolean): BlueprintNotice[] {
	if (outcome.kind === undefined && outcome.failures.length === 0) return [];
	const notices: BlueprintNotice[] = outcome.failures.map((failure) => ({
		type: "warning",
		message: failure.scope === "global" ? globalFailure(failure) : repositoryFailure(failure),
	}));
	for (const warning of outcome.warnings) {
		notices.push({ type: "warning", message: `Blueprint ${warning.blueprint}: ${warning.message}.` });
	}
	if (aliasConfigured && outcome.kind !== undefined) {
		notices.push({
			type: "warning",
			message: `Deprecation warning: ${SETUP_COMMAND_ALIAS} is deprecated and will be removed in the next release. Move its command into the maintenance section of .atomic/blueprint.yaml.`,
		});
	}
	return notices;
}
