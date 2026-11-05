/** Why a session's Intercom project group cannot be named. */
export type ProjectGroupErrorCode = "git-unavailable" | "git-failed";

const SUMMARIES: Readonly<Record<ProjectGroupErrorCode, string>> = {
	"git-unavailable": "Git is needed to name this repository's Intercom project group",
	"git-failed": "Git could not read this repository's origin for its Intercom project group",
};

/**
 * The project group of a Git working tree cannot be named: Git is not installed, or it failed in that directory.
 * A session with multi-node routing on needs it before it joins Intercom, unless it names its group explicitly.
 */
export class ProjectGroupError extends Error {
	override readonly name = "ProjectGroupError" as const;
	readonly code: ProjectGroupErrorCode;
	readonly cwd: string;
	readonly hint: string;
	declare readonly detail?: string;
	readonly retryable = false;

	constructor(
		code: ProjectGroupErrorCode,
		fields: { readonly cwd: string; readonly hint: string; readonly detail?: string; readonly cause?: Error },
	) {
		super(
			`${SUMMARIES[code]}: ${fields.cwd} (${code})${fields.detail === undefined ? "" : `: ${fields.detail}`}. ${fields.hint}`,
			fields.cause === undefined ? undefined : { cause: fields.cause },
		);
		this.code = code;
		this.cwd = fields.cwd;
		this.hint = fields.hint;
		if (fields.detail !== undefined) this.detail = fields.detail;
	}
}

/** Whether `error` is a {@link ProjectGroupError}, also across realms and processes (by `name` and `code`). */
export function isProjectGroupError(error: unknown): error is ProjectGroupError {
	if (error instanceof ProjectGroupError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: unknown; readonly code?: unknown };
	return (
		candidate.name === "ProjectGroupError" &&
		(candidate.code === "git-unavailable" || candidate.code === "git-failed")
	);
}
