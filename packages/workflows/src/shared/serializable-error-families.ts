import {
	AgentRehydrateError,
	BackgroundCompactionError,
	DebugError,
	DecisionError,
	deserializeGitHubCopilotError,
	deserializeToolDetachmentError,
	EditToolError,
	GitHubCopilotError,
	GitProvisionError,
	isGitProvisionError,
	isSerializedBackgroundCompactionError,
	LlamaServerError,
	parseSerializedDecisionError,
	rehydrateAgentRehydrateError,
	rehydrateBackgroundCompactionError,
	rehydrateDebugError,
	rehydrateDecisionError,
	rehydrateEditToolError,
	rehydrateGitProvisionError,
	rehydrateLlamaServerError,
	rehydrateSessionStartError,
	rehydrateShellToolError,
	rehydrateStartupBenchmarkError,
	rehydrateTaskEvictedError,
	rehydrateWorkspaceError,
	rehydrateWriteSelectorError,
	type SerializedAgentRehydrateError,
	type SerializedBackgroundCompactionError,
	type SerializedDebugError,
	type SerializedDecisionError,
	type SerializedFileToolError,
	type SerializedGitHubCopilotError,
	type SerializedGitProvisionError,
	type SerializedSessionStartError,
	type SerializedToolDetachmentError,
	type SerializedTypedError,
	type SerializedWorkspaceError,
	SessionStartError,
	ShellToolError,
	StartupBenchmarkError,
	serializeAgentRehydrateError,
	serializeBackgroundCompactionError,
	serializeDebugError,
	serializeDecisionError,
	serializeFileToolError,
	serializeGitHubCopilotError,
	serializeSessionStartError,
	serializeWorkspaceError,
	TaskEvictedError,
	ToolDetachmentError,
	WorkspaceError,
	WriteSelectorError,
} from "@bastani/atomic";
import { deserializeStageWaitError, type SerializedStageWaitError, StageWaitError } from "./stage-wait-errors.js";
import {
	isWorkflowGitRequiredError,
	type SerializedWorkflowGitRequiredError,
	WorkflowGitRequiredError,
} from "./workflow-git-required-error.js";

/**
 * A family's own JSON form of one of its errors: what its `toJSON()` or `serialize…Error()` returns, and what its
 * `deserialize…Error()` or `rehydrate…Error()` reads.
 */
export interface SerializableErrorForm {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly hint?: string;
	readonly retryable?: boolean;
	readonly fields?: object;
}

/**
 * An error family with its own JSON form and rehydration, which the pool's IPC codec carries as an envelope so the
 * error reaches the other side of a worker, coordinator or child-workflow boundary as its own class (#4378). Its
 * causes are left to the codec, which carries each link of a chain as its own family.
 */
export interface SerializableErrorFamily {
	/** Whether an error belongs to the family. */
	readonly is: (error: Error) => boolean;
	/** The family's own JSON form of an error of the family. */
	readonly serialize: (error: Error) => SerializableErrorForm;
	/** The family's own rehydration of `form`, given the error's rehydrated `cause`; undefined when the family refuses it. */
	readonly rehydrate: (form: SerializableErrorForm, cause: Error | undefined) => Error | undefined;
}

function family<E extends Error, F extends SerializableErrorForm>(definition: {
	readonly is: (error: Error) => boolean;
	readonly serialize: (error: E) => F;
	readonly rehydrate: (form: F, cause: Error | undefined) => Error | undefined;
}): SerializableErrorFamily {
	return definition as unknown as SerializableErrorFamily;
}

/** A {@link TaskEvictedError} as JSON: its copy carries `taskId` and `retainedFinishedTasks` as its fields. */
interface SerializedTaskEvictedError extends SerializableErrorForm {
	readonly code: string;
	readonly fields: { readonly taskId: string; readonly retainedFinishedTasks: number };
}

/**
 * Whether an error is an instance of the family's class. A copy that only carries a family's name and code, such as
 * one rebuilt by another version, has none of the class's members its serializer reads, and crosses as a plain error
 * with its name and code.
 */
function instanceOf(type: abstract new (...args: never[]) => Error): (error: Error) => boolean {
	return (error) => error instanceof type;
}

/**
 * A git-required error's JSON form, its cause aside, read from its members, so the copy {@link gitRequiredIdentity}
 * makes crosses again as it arrived.
 */
function gitRequiredForm(error: WorkflowGitRequiredError): SerializedWorkflowGitRequiredError {
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		hint: error.hint,
		retryable: error.retryable,
		fields: error.fields,
	};
}

/**
 * A git-required error whose git cause the codec cut off at its depth bound, which its class cannot be built without:
 * its name, code, message, hint, retryable and fields, which `isWorkflowGitRequiredError` recognizes.
 */
function gitRequiredIdentity(form: SerializedWorkflowGitRequiredError): Error {
	return Object.assign(new Error(form.message), {
		name: form.name,
		code: form.code,
		hint: form.hint,
		retryable: form.retryable,
		fields: form.fields,
	});
}

/**
 * The families with their own JSON form, by the name an envelope gives their family. Team profile errors are storage
 * errors and cross with the storage family.
 */
export const SERIALIZABLE_ERROR_FAMILIES = {
	"stage-wait": family<StageWaitError, SerializedStageWaitError>({
		is: instanceOf(StageWaitError),
		serialize: (error) => error.toJSON(),
		rehydrate: deserializeStageWaitError,
	}),
	"tool-detachment": family<ToolDetachmentError, SerializedToolDetachmentError>({
		is: instanceOf(ToolDetachmentError),
		serialize: (error) => error.toJSON(),
		rehydrate: deserializeToolDetachmentError,
	}),
	"git-provision": family<GitProvisionError, SerializedGitProvisionError>({
		is: instanceOf(GitProvisionError),
		serialize: (error) => error.toJSON(),
		rehydrate: rehydrateGitProvisionError,
	}),
	"git-required": family<WorkflowGitRequiredError, SerializedWorkflowGitRequiredError>({
		is: isWorkflowGitRequiredError,
		serialize: gitRequiredForm,
		rehydrate: (form, cause) =>
			isGitProvisionError(cause) ? new WorkflowGitRequiredError(form.fields, cause) : gitRequiredIdentity(form),
	}),
	workspace: family<WorkspaceError, SerializedWorkspaceError>({
		is: instanceOf(WorkspaceError),
		serialize: serializeWorkspaceError,
		rehydrate: rehydrateWorkspaceError,
	}),
	"session-start": family<SessionStartError, SerializedSessionStartError>({
		is: instanceOf(SessionStartError),
		serialize: serializeSessionStartError,
		rehydrate: rehydrateSessionStartError,
	}),
	decision: family<DecisionError, SerializedDecisionError>({
		is: instanceOf(DecisionError),
		serialize: (error) => serializeDecisionError(error),
		rehydrate: (form) => {
			const valid = parseSerializedDecisionError(form);
			return valid === undefined ? undefined : rehydrateDecisionError(valid);
		},
	}),
	"task-evicted": family<TaskEvictedError, SerializedTaskEvictedError>({
		is: instanceOf(TaskEvictedError),
		serialize: (error) => ({
			name: error.name,
			code: error.code,
			message: error.message,
			hint: error.hint,
			retryable: error.retryable,
			fields: { taskId: error.taskId, retainedFinishedTasks: error.retainedFinishedTasks },
		}),
		rehydrate: (form) => rehydrateTaskEvictedError({ ...form.fields, name: form.name, code: form.code }),
	}),
	"agent-rehydrate": family<AgentRehydrateError, SerializedAgentRehydrateError>({
		is: instanceOf(AgentRehydrateError),
		serialize: serializeAgentRehydrateError,
		rehydrate: rehydrateAgentRehydrateError,
	}),
	"background-compaction": family<BackgroundCompactionError, SerializedBackgroundCompactionError>({
		is: instanceOf(BackgroundCompactionError),
		serialize: serializeBackgroundCompactionError,
		rehydrate: (form) =>
			isSerializedBackgroundCompactionError(form) ? rehydrateBackgroundCompactionError(form) : undefined,
	}),
	"github-copilot": family<GitHubCopilotError, SerializedGitHubCopilotError>({
		is: instanceOf(GitHubCopilotError),
		serialize: serializeGitHubCopilotError,
		rehydrate: deserializeGitHubCopilotError,
	}),
	debug: family<DebugError, SerializedDebugError>({
		is: instanceOf(DebugError),
		serialize: (error) => serializeDebugError(error),
		rehydrate: rehydrateDebugError,
	}),
	"edit-tool": family<EditToolError, SerializedFileToolError>({
		is: instanceOf(EditToolError),
		serialize: serializeFileToolError,
		rehydrate: rehydrateEditToolError,
	}),
	"write-selector": family<WriteSelectorError, SerializedFileToolError>({
		is: instanceOf(WriteSelectorError),
		serialize: serializeFileToolError,
		rehydrate: rehydrateWriteSelectorError,
	}),
	"shell-tool": family<ShellToolError, SerializedTypedError>({
		is: instanceOf(ShellToolError),
		serialize: (error) => error.toJSON(),
		rehydrate: rehydrateShellToolError,
	}),
	"llama-server": family<LlamaServerError, SerializedTypedError>({
		is: instanceOf(LlamaServerError),
		serialize: (error) => error.toJSON(),
		rehydrate: rehydrateLlamaServerError,
	}),
	"startup-benchmark": family<StartupBenchmarkError, SerializedTypedError>({
		is: instanceOf(StartupBenchmarkError),
		serialize: (error) => error.toJSON(),
		rehydrate: rehydrateStartupBenchmarkError,
	}),
} as const satisfies Readonly<Record<string, SerializableErrorFamily>>;

/** The name an envelope gives a family with its own JSON form. */
export type SerializableErrorFamilyName = keyof typeof SERIALIZABLE_ERROR_FAMILIES;

const FAMILY_NAMES = Object.keys(SERIALIZABLE_ERROR_FAMILIES) as SerializableErrorFamilyName[];

/** Whether an envelope's family is one with its own JSON form. */
export function isSerializableErrorFamilyName(family: string | undefined): family is SerializableErrorFamilyName {
	return family !== undefined && Object.hasOwn(SERIALIZABLE_ERROR_FAMILIES, family);
}

/** The family with its own JSON form that `error` belongs to, if any. */
export function serializableErrorFamilyOf(error: Error): SerializableErrorFamilyName | undefined {
	return FAMILY_NAMES.find((name) => SERIALIZABLE_ERROR_FAMILIES[name].is(error));
}
