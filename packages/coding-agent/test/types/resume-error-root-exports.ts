import type {
	ActionFetcher,
	BlueprintBuildConfig,
	BlueprintBuildFailedError,
	BlueprintBuildFailedErrorCode,
	BlueprintBuildOutcome,
	BlueprintBuildPhase,
	BlueprintError,
	BlueprintErrorCode,
	BlueprintErrorFields,
	BlueprintErrorName,
	BlueprintFailure,
	BlueprintInvalidError,
	BlueprintInvalidErrorCode,
	BlueprintInvalidReason,
	BlueprintLayer,
	BlueprintNotice,
	BlueprintPlatform,
	BlueprintScope,
	BlueprintSection,
	BlueprintStepFailedError,
	BlueprintStepFailedErrorCode,
	BlueprintStepTimedOutError,
	BlueprintStepTimedOutErrorCode,
	BlueprintUsesUnsupportedError,
	BlueprintUsesUnsupportedErrorCode,
	BlueprintUsesUnsupportedReason,
	BlueprintWarning,
	findBlueprintError,
	findResumeError,
	isBlueprintBuildFailedError,
	isBlueprintError,
	isBlueprintInvalidError,
	isBlueprintStepFailedError,
	isBlueprintStepTimedOutError,
	isBlueprintUsesUnsupportedError,
	isResumeCatalogTimeoutError,
	isResumeCatalogUnavailableError,
	isResumeError,
	isResumeNotFoundError,
	isResumePreconditionError,
	isRetryableResumeError,
	ParsedBlueprint,
	parseBlueprint,
	ResumeCatalogTimeoutError,
	ResumeCatalogTimeoutErrorCode,
	ResumeCatalogUnavailableError,
	ResumeCatalogUnavailableErrorCode,
	ResumedBlueprints,
	ResumeEntryPoint,
	ResumeError,
	ResumeErrorCode,
	ResumeErrorFields,
	ResumeErrorName,
	ResumeNotFoundError,
	ResumeNotFoundErrorCode,
	ResumeNotFoundReason,
	ResumePreconditionError,
	ResumePreconditionErrorCode,
	ResumePreconditionProblem,
	ResumePreconditionProblemCode,
	ResumeSubject,
	RunResumeSetupOptions,
	RunWorktreeTarget,
	rehydrateBlueprintError,
	rehydrateResumeError,
	renderBlueprintContext,
	restoreRunWorktree,
	SerializedBlueprintError,
	SerializedResumeError,
	SetUpBlueprintsOptions,
	serializeBlueprintError,
	serializeResumeError,
	setUpResumedBlueprints,
} from "../../src/index.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Condition extends true> = Condition;

export type ResumeErrorCodeRootExport = Assert<
	Equal<ResumeErrorCode, "not-found" | "preconditions-unmet" | "catalog-unavailable" | "catalog-timeout">
>;
export type ResumeCodesByClassRootExport = Assert<
	Equal<
		[
			ResumeNotFoundErrorCode,
			ResumePreconditionErrorCode,
			ResumeCatalogUnavailableErrorCode,
			ResumeCatalogTimeoutErrorCode,
		],
		["not-found", "preconditions-unmet", "catalog-unavailable", "catalog-timeout"]
	>
>;
export type ResumeErrorNameRootExport = Assert<
	Equal<
		ResumeErrorName,
		| "ResumeError"
		| "ResumeNotFoundError"
		| "ResumePreconditionError"
		| "ResumeCatalogUnavailableError"
		| "ResumeCatalogTimeoutError"
	>
>;
export type ResumeEntryPointRootExport = Assert<
	Equal<ResumeEntryPoint, "cli" | "switch-session" | "create-agent-session" | "workflow-resume" | "rehydrate">
>;
export type ResumeSubjectRootExport = Assert<Equal<ResumeSubject, "session" | "run">>;
export type ResumeNotFoundReasonRootExport = Assert<
	Equal<ResumeNotFoundReason, "local-storage-not-joined" | "shared-miss">
>;
export type ResumePreconditionProblemCodeRootExport = Assert<
	Equal<
		ResumePreconditionProblemCode,
		"adapter-not-installed" | "credential-missing" | "credential-unreadable" | "git-unavailable"
	>
>;
export type ResumePreconditionProblemRootExport = Assert<
	Equal<
		ResumePreconditionProblem,
		{
			readonly code: ResumePreconditionProblemCode;
			readonly subject: string;
			readonly why: string;
			readonly fix: string;
			readonly checkout?: string;
		}
	>
>;

export type ResumeErrorBaseRootExport = Assert<
	Equal<
		Pick<ResumeError, "name" | "code" | "hint" | "retryable" | "fields">,
		{
			readonly name: ResumeErrorName;
			readonly code: ResumeErrorCode;
			readonly hint: string;
			readonly retryable: boolean;
			readonly fields: ResumeErrorFields;
		}
	>
>;
export type ResumePreconditionErrorFieldsRootExport = Assert<
	Equal<
		Pick<ResumePreconditionError, "name" | "code" | "entryPoint" | "problems">,
		{
			readonly name: "ResumePreconditionError";
			readonly code: "preconditions-unmet";
			readonly entryPoint: ResumeEntryPoint;
			readonly problems: readonly ResumePreconditionProblem[];
		}
	>
>;
export type ResumeNotFoundErrorFieldsRootExport = Assert<
	Equal<
		Pick<ResumeNotFoundError, "name" | "code" | "subject" | "id" | "reason" | "storage">,
		{
			readonly name: "ResumeNotFoundError";
			readonly code: "not-found";
			readonly subject: "session";
			readonly id: string;
			readonly reason: ResumeNotFoundReason;
			readonly storage: string;
		}
	>
>;
export type ResumeCatalogErrorFieldsRootExport = Assert<
	Equal<
		[
			Pick<ResumeCatalogUnavailableError, "name" | "code" | "retryable" | "subject" | "id" | "storage" | "phase">,
			Pick<
				ResumeCatalogTimeoutError,
				"name" | "code" | "retryable" | "subject" | "id" | "storage" | "phase" | "timeoutMs" | "elapsedMs"
			>,
		],
		[
			{
				readonly name: "ResumeCatalogUnavailableError";
				readonly code: "catalog-unavailable";
				readonly retryable: true;
				readonly subject: ResumeSubject;
				readonly id: string | null;
				readonly storage: string;
				readonly phase: "catalog-lookup";
			},
			{
				readonly name: "ResumeCatalogTimeoutError";
				readonly code: "catalog-timeout";
				readonly retryable: true;
				readonly subject: ResumeSubject;
				readonly id: string | null;
				readonly storage: string;
				readonly phase: "catalog-lookup";
				readonly timeoutMs: number;
				readonly elapsedMs: number;
			},
		]
	>
>;

export type ResumeGuardsRootExport = Assert<
	Equal<
		[
			typeof isResumeError,
			typeof isResumeNotFoundError,
			typeof isResumePreconditionError,
			typeof isResumeCatalogUnavailableError,
			typeof isResumeCatalogTimeoutError,
			typeof isRetryableResumeError,
		],
		[
			(value: unknown) => value is ResumeError,
			(value: unknown) => value is ResumeNotFoundError,
			(value: unknown) => value is ResumePreconditionError,
			(value: unknown) => value is ResumeCatalogUnavailableError,
			(value: unknown) => value is ResumeCatalogTimeoutError,
			(error: unknown) => boolean,
		]
	>
>;
export type FindResumeErrorRootExport = Assert<
	Equal<
		typeof findResumeError,
		<T extends ResumeError>(error: unknown, guard?: (value: unknown) => value is T) => T | undefined
	>
>;
export type ResumeSerializationRootExport = Assert<
	Equal<
		[typeof serializeResumeError, typeof rehydrateResumeError],
		[(error: ResumeError) => SerializedResumeError, (form: SerializedResumeError, cause?: Error) => ResumeError]
	>
>;
export type SerializedResumeErrorRootExport = Assert<
	Equal<
		Omit<SerializedResumeError, "cause">,
		{
			readonly name: string;
			readonly code: string;
			readonly message: string;
			readonly hint: string;
			readonly retryable: boolean;
			readonly fields: ResumeErrorFields;
		}
	>
>;

export type RunResumeSetupOptionsRootExport = Assert<
	Equal<
		RunResumeSetupOptions,
		{
			readonly signal?: AbortSignal;
			readonly io?: RunResumeSetupOptions["io"];
			readonly agentDir?: string;
			readonly onNotices?: (notices: readonly BlueprintNotice[]) => void;
		}
	>
>;
export type RunWorktreeTargetRootExport = Assert<
	Equal<RunWorktreeTarget, { readonly root: string; readonly remotes: readonly string[] }>
>;
export type RestoreRunWorktreeRootExport = Assert<
	Equal<
		typeof restoreRunWorktree,
		(
			remotes: readonly string[] | undefined,
			restore: () => Promise<string>,
			options?: RunResumeSetupOptions,
		) => Promise<string>
	>
>;

export type BlueprintErrorCodeRootExport = Assert<
	Equal<
		BlueprintErrorCode,
		| "blueprint-invalid"
		| "blueprint-step-failed"
		| "blueprint-step-timed-out"
		| "blueprint-uses-unsupported"
		| "blueprint-build-failed"
	>
>;
export type BlueprintCodesByClassRootExport = Assert<
	Equal<
		[
			BlueprintInvalidErrorCode,
			BlueprintStepFailedErrorCode,
			BlueprintStepTimedOutErrorCode,
			BlueprintUsesUnsupportedErrorCode,
			BlueprintBuildFailedErrorCode,
		],
		[
			"blueprint-invalid",
			"blueprint-step-failed",
			"blueprint-step-timed-out",
			"blueprint-uses-unsupported",
			"blueprint-build-failed",
		]
	>
>;
export type BlueprintErrorNameRootExport = Assert<
	Equal<
		BlueprintErrorName,
		| "BlueprintError"
		| "BlueprintInvalidError"
		| "BlueprintStepFailedError"
		| "BlueprintStepTimedOutError"
		| "BlueprintUsesUnsupportedError"
		| "BlueprintBuildFailedError"
	>
>;
export type BlueprintScopeAndSectionRootExport = Assert<
	Equal<
		[BlueprintScope, BlueprintSection, BlueprintBuildPhase],
		[
			"global" | "repository" | "workspace",
			"initialize" | "maintenance" | "post-build",
			"read-blueprint" | "ledger" | "environment" | "unknown",
		]
	>
>;
export type BlueprintInvalidReasonRootExport = Assert<
	Equal<
		BlueprintInvalidReason,
		| "yaml-syntax"
		| "not-a-mapping"
		| "invalid-shell"
		| "invalid-field"
		| "uses-in-maintenance"
		| "run-and-uses"
		| "missing-run-or-uses"
		| "with-without-uses"
		| "invalid-uses-reference"
		| "duplicate-platform"
		| "nested-includes"
		| "include-parent-path"
		| "duplicate-include"
		| "post-build-not-global"
	>
>;
export type BlueprintUsesUnsupportedReasonRootExport = Assert<
	Equal<
		BlueprintUsesUnsupportedReason,
		| "docker-action"
		| "unknown-action-type"
		| "action-not-found"
		| "action-fetch-failed"
		| "action-metadata-invalid"
		| "node-unavailable"
		| "required-input-missing"
		| "unsupported-expression"
	>
>;
export type BlueprintErrorBaseRootExport = Assert<
	Equal<
		Pick<BlueprintError, "name" | "code" | "hint" | "retryable" | "fields">,
		{
			readonly name: BlueprintErrorName;
			readonly code: BlueprintErrorCode;
			readonly hint: string;
			readonly retryable: boolean;
			readonly fields: BlueprintErrorFields;
		}
	>
>;
export type BlueprintInvalidErrorFieldsRootExport = Assert<
	Equal<
		Pick<BlueprintInvalidError, "name" | "code" | "blueprint" | "scope" | "reason" | "rule" | "subject">,
		{
			readonly name: "BlueprintInvalidError";
			readonly code: "blueprint-invalid";
			readonly blueprint: string;
			readonly scope: BlueprintScope;
			readonly reason: BlueprintInvalidReason;
			readonly rule: string;
			readonly subject: string | null;
		}
	>
>;
export type BlueprintStepErrorFieldsRootExport = Assert<
	Equal<
		[
			Pick<
				BlueprintStepFailedError,
				"name" | "code" | "blueprint" | "scope" | "section" | "index" | "step" | "exitStatus" | "signal" | "logPath"
			>,
			Pick<
				BlueprintStepTimedOutError,
				| "name"
				| "code"
				| "blueprint"
				| "scope"
				| "section"
				| "index"
				| "step"
				| "logPath"
				| "timeoutMs"
				| "elapsedMs"
				| "phase"
			>,
		],
		[
			{
				readonly name: "BlueprintStepFailedError";
				readonly code: "blueprint-step-failed";
				readonly blueprint: string;
				readonly scope: BlueprintScope;
				readonly section: BlueprintSection;
				readonly index: number;
				readonly step: string;
				readonly exitStatus: number | null;
				readonly signal: string | null;
				readonly logPath: string | null;
			},
			{
				readonly name: "BlueprintStepTimedOutError";
				readonly code: "blueprint-step-timed-out";
				readonly blueprint: string;
				readonly scope: BlueprintScope;
				readonly section: BlueprintSection;
				readonly index: number;
				readonly step: string;
				readonly logPath: string;
				readonly timeoutMs: number;
				readonly elapsedMs: number;
				readonly phase: BlueprintSection;
			},
		]
	>
>;
export type BlueprintOtherErrorFieldsRootExport = Assert<
	Equal<
		[
			Pick<BlueprintUsesUnsupportedError, "name" | "code" | "uses" | "reason" | "detail" | "logPath">,
			Pick<BlueprintBuildFailedError, "name" | "code" | "phase" | "detail">,
		],
		[
			{
				readonly name: "BlueprintUsesUnsupportedError";
				readonly code: "blueprint-uses-unsupported";
				readonly uses: string;
				readonly reason: BlueprintUsesUnsupportedReason;
				readonly detail: string;
				readonly logPath: string;
			},
			{
				readonly name: "BlueprintBuildFailedError";
				readonly code: "blueprint-build-failed";
				readonly phase: BlueprintBuildPhase;
				readonly detail: string;
			},
		]
	>
>;
export type BlueprintGuardsRootExport = Assert<
	Equal<
		[
			typeof isBlueprintError,
			typeof isBlueprintInvalidError,
			typeof isBlueprintStepFailedError,
			typeof isBlueprintStepTimedOutError,
			typeof isBlueprintUsesUnsupportedError,
			typeof isBlueprintBuildFailedError,
		],
		[
			(value: unknown) => value is BlueprintError,
			(value: unknown) => value is BlueprintInvalidError,
			(value: unknown) => value is BlueprintStepFailedError,
			(value: unknown) => value is BlueprintStepTimedOutError,
			(value: unknown) => value is BlueprintUsesUnsupportedError,
			(value: unknown) => value is BlueprintBuildFailedError,
		]
	>
>;
export type FindBlueprintErrorRootExport = Assert<
	Equal<
		typeof findBlueprintError,
		<T extends BlueprintError>(error: unknown, guard?: (value: unknown) => value is T) => T | undefined
	>
>;
export type BlueprintSerializationRootExport = Assert<
	Equal<
		[typeof serializeBlueprintError, typeof rehydrateBlueprintError],
		[
			(error: BlueprintError) => SerializedBlueprintError,
			(form: SerializedBlueprintError, cause?: Error) => BlueprintError,
		]
	>
>;
export type SerializedBlueprintErrorRootExport = Assert<
	Equal<
		Omit<SerializedBlueprintError, "cause">,
		{
			readonly name: string;
			readonly code: string;
			readonly message: string;
			readonly hint: string;
			readonly retryable: boolean;
			readonly fields: BlueprintErrorFields;
		}
	>
>;

export type BlueprintBuildConfigRootExport = Assert<
	Equal<
		BlueprintBuildConfig,
		{
			readonly agentDir: string;
			readonly storeDir: string;
			readonly trusted: (worktree: string) => boolean;
			readonly setupCommand?: string;
			readonly platform?: BlueprintPlatform;
			readonly homeDir?: string;
			readonly now?: () => number;
			readonly stepTimeoutMs?: number;
			readonly fullBuildMaxAgeMs?: number;
			readonly environment?: NodeJS.ProcessEnv;
			readonly fetchAction?: ActionFetcher;
		}
	>
>;
export type BlueprintBuildOutcomeRootExport = Assert<
	Equal<
		BlueprintBuildOutcome,
		{
			readonly status: "none" | "skipped" | "success" | "partial" | "failed";
			readonly kind: "full" | "differential" | undefined;
			readonly layers: readonly BlueprintLayer[];
			readonly failures: readonly BlueprintFailure[];
			readonly warnings: readonly BlueprintWarning[];
			readonly removed: readonly string[];
		}
	>
>;
export type SetUpResumedBlueprintsRootExport = Assert<
	Equal<typeof setUpResumedBlueprints, (options: SetUpBlueprintsOptions) => Promise<ResumedBlueprints>>
>;
export type RenderBlueprintContextRootExport = Assert<
	Equal<typeof renderBlueprintContext, (layers: readonly BlueprintLayer[]) => string | undefined>
>;
export type ParseBlueprintRootExport = Assert<
	Equal<typeof parseBlueprint, (source: string, location: { path: string; scope: BlueprintScope }) => ParsedBlueprint>
>;
