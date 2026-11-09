import type {
	findResumeError,
	isResumeCatalogTimeoutError,
	isResumeCatalogUnavailableError,
	isResumeError,
	isResumeNotFoundError,
	isResumePreconditionError,
	isResumeSetupHookError,
	isRetryableResumeError,
	ResumeCatalogTimeoutError,
	ResumeCatalogTimeoutErrorCode,
	ResumeCatalogUnavailableError,
	ResumeCatalogUnavailableErrorCode,
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
	ResumeSetupHookError,
	ResumeSetupHookErrorCode,
	ResumeSubject,
	RunResumeSetupOptions,
	rehydrateResumeError,
	restoreRunWorktree,
	SerializedResumeError,
	serializeResumeError,
} from "../../src/index.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Condition extends true> = Condition;

export type ResumeErrorCodeRootExport = Assert<
	Equal<
		ResumeErrorCode,
		| "not-found"
		| "preconditions-unmet"
		| "setup-hook-failed"
		| "setup-hook-timed-out"
		| "catalog-unavailable"
		| "catalog-timeout"
	>
>;
export type ResumeCodesByClassRootExport = Assert<
	Equal<
		[
			ResumeNotFoundErrorCode,
			ResumePreconditionErrorCode,
			ResumeSetupHookErrorCode,
			ResumeCatalogUnavailableErrorCode,
			ResumeCatalogTimeoutErrorCode,
		],
		[
			"not-found",
			"preconditions-unmet",
			"setup-hook-failed" | "setup-hook-timed-out",
			"catalog-unavailable",
			"catalog-timeout",
		]
	>
>;
export type ResumeErrorNameRootExport = Assert<
	Equal<
		ResumeErrorName,
		| "ResumeError"
		| "ResumeNotFoundError"
		| "ResumePreconditionError"
		| "ResumeSetupHookError"
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
		| "adapter-not-installed"
		| "credential-missing"
		| "credential-unreadable"
		| "git-unavailable"
		| "setup-hook-missing"
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
export type ResumeSetupHookErrorFieldsRootExport = Assert<
	Equal<
		Pick<
			ResumeSetupHookError,
			| "name"
			| "code"
			| "hook"
			| "worktree"
			| "envHash"
			| "exitStatus"
			| "signal"
			| "logPath"
			| "timeoutMs"
			| "elapsedMs"
			| "phase"
		>,
		{
			readonly name: "ResumeSetupHookError";
			readonly code: ResumeSetupHookErrorCode;
			readonly hook: string;
			readonly worktree: string;
			readonly envHash: string;
			readonly exitStatus: number | null;
			readonly signal: string | null;
			readonly logPath: string;
			readonly timeoutMs: number;
			readonly elapsedMs: number;
			readonly phase: "setup-hook";
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
			typeof isResumeSetupHookError,
			typeof isResumeCatalogUnavailableError,
			typeof isResumeCatalogTimeoutError,
			typeof isRetryableResumeError,
		],
		[
			(value: unknown) => value is ResumeError,
			(value: unknown) => value is ResumeNotFoundError,
			(value: unknown) => value is ResumePreconditionError,
			(value: unknown) => value is ResumeSetupHookError,
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
		{ readonly signal?: AbortSignal; readonly io?: RunResumeSetupOptions["io"]; readonly agentDir?: string }
	>
>;
export type RestoreRunWorktreeRootExport = Assert<
	Equal<
		typeof restoreRunWorktree,
		(envHash: string | undefined, restore: () => Promise<string>, options?: RunResumeSetupOptions) => Promise<string>
	>
>;
