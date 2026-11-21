/**
 * Pure rules for a session's project trust while Atomic runs: what a runtime starts a session with, when the
 * "project is not trusted" warning shows, and which decisions an interactive host carries into a restarted engine.
 */

/** The trust decisions a process made in this session, and whether one is still to be made. */
export interface SessionProjectTrust {
	/**
	 * True while a deferred startup decision is still to be made. The settings read the project untrusted until then, so
	 * that only what the decision needs loads, which is not a decision.
	 */
	readonly pending: boolean;
	/**
	 * While `pending`: whether the project's own resources may load already (see pendingProjectResourcesTrusted). They
	 * wait while the project's decision can still come out untrusted, or if the host does not report this value.
	 */
	readonly resourcesTrusted?: boolean;
	/** Ends a decision that was still to be made but will not be: startup failed before it could make it. */
	abandon(): void;
	/**
	 * Project decisions made in this session, by session directory: by the prompt, an extension or a saved decision.
	 * They are never written to trust.json.
	 */
	readonly decisions: ReadonlyMap<string, boolean>;
	/** Decisions about `-e` extension sources' own project resources, by source path. Never written to trust.json. */
	readonly extensionSourceDecisions: ReadonlyMap<string, boolean>;
}

/**
 * The trust decisions of a host session that an interactive host hands to an engine it starts to replace one that
 * stopped, so the new engine does not ask again.
 */
export interface SessionTrustDecisions {
	/** Project folders, by session directory. */
	readonly projects: Readonly<Record<string, boolean>>;
	/** `-e` extension sources, by source path. */
	readonly extensionSources: Readonly<Record<string, boolean>>;
}

/**
 * What an interactive host found at startup when it checked, before any extension ran, whether an extension could answer
 * `project_trust` for its folder ahead of a saved decision. An engine the host starts for that folder uses it instead of
 * checking again, so the host and the engine decide with the same extensions.
 */
export interface StartupExtensionCheck {
	/** The folder the host started in. */
	readonly cwd: string;
	readonly extensionsCanDecide: boolean;
}

/** What a runtime starts a session with before, or instead of, deciding its project's trust. */
export interface StartupProjectTrust {
	/** Whether the session starts trusted. */
	readonly trusted: boolean;
	/** Whether the trust still has to be decided: by extensions, the saved decision, `defaultProjectTrust` or the prompt. */
	readonly decide: boolean;
}

/**
 * The trust a runtime starts a session in a project with. `--approve` or `--no-approve` decides. Otherwise a decision
 * made earlier in this session stands, including one carried into an engine started to replace one that stopped, so the
 * user is not asked twice. Otherwise the session starts with the saved decision, or trusted when the project has nothing
 * that needs trust, and a project with trust inputs is decided.
 */
export function startupProjectTrust(input: {
	readonly override: boolean | undefined;
	readonly sessionDecision: boolean | undefined;
	readonly saved: boolean | null;
	readonly hasTrustInputs: boolean;
}): StartupProjectTrust {
	return {
		trusted: input.override ?? input.sessionDecision ?? input.saved ?? !input.hasTrustInputs,
		decide: input.override === undefined && input.sessionDecision === undefined && input.hasTrustInputs,
	};
}

/**
 * Whether startup may use a project's own settings and resources before any extension code has run: to choose the
 * session store, migrate the project's settings, build a restored worktree or draw the first frame. `--approve` or
 * `--no-approve` decides, and a folder with nothing that needs trust is trusted. Otherwise a saved "Trust" (or
 * `defaultProjectTrust: "always"` without a saved decision) counts only when no extension that loads before the
 * decision could answer `project_trust` ahead of it: a handler can still decline the folder (#5693).
 */
export function projectTrustedBeforeExtensions(input: {
	readonly override: boolean | undefined;
	readonly hasTrustInputs: boolean;
	readonly saved: boolean | null;
	readonly defaultProjectTrust: "always" | "ask" | "never";
	/** Whether an extension that loads before the decision could register a `project_trust` handler. */
	readonly extensionsCanDecide: boolean;
}): boolean {
	if (input.override !== undefined) return input.override;
	if (!input.hasTrustInputs) return true;
	const savedPositive = input.saved ?? input.defaultProjectTrust === "always";
	return savedPositive && !input.extensionsCanDecide;
}

/**
 * While a deferred startup decision is still to be made, whether the project's own resources may load already. Each
 * source of resources follows its own decision, so other open questions, such as an `-e` source's, do not hold the
 * project back. A project with no decision to make keeps the trust it started with: `--approve` or `--no-approve`, a
 * decision made earlier in this session, or nothing that needs trust. A project that has been decided follows its
 * decision. Before that, a project_trust hook answers ahead of the saved decision, so only a saved "trust" that no hook
 * could overturn is certain. Anything else can still come out untrusted, and the project's resources wait for it.
 */
export function pendingProjectResourcesTrusted(input: {
	/** startupProjectTrust's `decide`: the project's decision is made during this startup. */
	readonly decide: boolean;
	/** startupProjectTrust's `trusted`: the trust the session started with. */
	readonly startedTrusted: boolean;
	/** The decision this startup made for the project, once made. */
	readonly decided: boolean | undefined;
	readonly saved: boolean | null;
	readonly hasTrustHook: boolean;
}): boolean {
	if (!input.decide) return input.startedTrusted;
	if (input.decided !== undefined) return input.decided;
	return input.saved === true && !input.hasTrustHook;
}

/**
 * Whether to warn that the project's resources are ignored: the session's decision is made, it is untrusted, and the
 * project has resources that need trust. A decision still to be made is neither trusted nor untrusted.
 */
export function projectTrustWarningVisible(state: {
	readonly trusted: boolean;
	readonly pending: boolean;
	readonly requiresTrust: boolean;
}): boolean {
	return !state.trusted && !state.pending && state.requiresTrust;
}

/**
 * The decisions an interactive host knows, updated with those its engine reports. Only boolean decisions are taken.
 * An engine started by the host holds every decision the host carried into it, so its report is the newer one.
 */
export function mergeProjectTrustDecisions(
	known: ReadonlyMap<string, boolean>,
	reported: Readonly<Record<string, unknown>> | undefined,
): Map<string, boolean> {
	const merged = new Map(known);
	for (const [cwd, trusted] of Object.entries(reported ?? {})) {
		if (typeof trusted === "boolean") merged.set(cwd, trusted);
	}
	return merged;
}

/** The session decisions an interactive host knows, updated with the ones its engine reports. */
export function mergeSessionTrustDecisions(known: SessionTrustDecisions, reported: unknown): SessionTrustDecisions {
	const report = (typeof reported === "object" && reported !== null ? reported : {}) as Record<string, unknown>;
	const field = (name: string): Readonly<Record<string, unknown>> | undefined => {
		const value = report[name];
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	};
	return {
		projects: Object.fromEntries(
			mergeProjectTrustDecisions(new Map(Object.entries(known.projects)), field("projects")),
		),
		extensionSources: Object.fromEntries(
			mergeProjectTrustDecisions(new Map(Object.entries(known.extensionSources)), field("extensionSources")),
		),
	};
}
