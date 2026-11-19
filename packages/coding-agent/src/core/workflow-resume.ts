import type { ExtensionCommandContext } from "./extensions/context-types.ts";
import type { HostSessionPickerRow } from "./extensions/ui-types.js";
import { type WorkflowRunControl, WorkflowRunControlUnavailableError } from "./extensions/workflow-run-control.js";

export type HostSessionPickerRowCandidate =
	| HostSessionPickerRow
	| boolean
	| number
	| string
	| null
	| undefined
	| readonly HostSessionPickerRowCandidate[]
	| { readonly [key: string]: HostSessionPickerRowCandidate };

const SESSION_PICKER_MESSAGE_COLORS = ["success", "warning", "accent", "error"] as const;

function isCandidateObject(
	value: HostSessionPickerRowCandidate,
): value is { readonly [key: string]: HostSessionPickerRowCandidate } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHostSessionPickerRow(value: HostSessionPickerRowCandidate): HostSessionPickerRow | undefined {
	if (!isCandidateObject(value)) return undefined;
	const {
		path,
		id,
		cwd,
		createdAt,
		modifiedAt,
		messageCount,
		firstMessage,
		summary,
		allMessagesText,
		name,
		messageColor,
		title,
		detail,
		canDelete,
		resumeSelection,
	} = value;
	if (
		typeof path !== "string" ||
		typeof id !== "string" ||
		typeof cwd !== "string" ||
		typeof createdAt !== "number" ||
		!Number.isFinite(createdAt) ||
		typeof modifiedAt !== "number" ||
		!Number.isFinite(modifiedAt) ||
		typeof messageCount !== "number" ||
		!Number.isFinite(messageCount) ||
		typeof firstMessage !== "string"
	)
		return undefined;
	if (summary !== undefined && typeof summary !== "string") return undefined;
	if (allMessagesText !== undefined && typeof allMessagesText !== "string") return undefined;
	if (name !== undefined && typeof name !== "string") return undefined;
	if (title !== undefined && typeof title !== "string") return undefined;
	if (detail !== undefined && typeof detail !== "string") return undefined;
	if (canDelete !== undefined && typeof canDelete !== "boolean") return undefined;
	let selection: HostSessionPickerRow["resumeSelection"];
	if (resumeSelection !== undefined) {
		if (!isCandidateObject(resumeSelection)) return undefined;
		const { updatedAt } = resumeSelection;
		if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined;
		selection = { updatedAt };
	}
	if (
		messageColor !== undefined &&
		(typeof messageColor !== "string" ||
			!SESSION_PICKER_MESSAGE_COLORS.includes(messageColor as (typeof SESSION_PICKER_MESSAGE_COLORS)[number]))
	)
		return undefined;
	return {
		path,
		id,
		cwd,
		createdAt,
		modifiedAt,
		messageCount,
		firstMessage,
		...(summary !== undefined ? { summary } : {}),
		...(allMessagesText !== undefined ? { allMessagesText } : {}),
		...(name !== undefined ? { name } : {}),
		...(messageColor !== undefined
			? { messageColor: messageColor as (typeof SESSION_PICKER_MESSAGE_COLORS)[number] }
			: {}),
		...(title !== undefined ? { title } : {}),
		...(detail !== undefined ? { detail } : {}),
		...(canDelete !== undefined ? { canDelete } : {}),
		...(selection === undefined ? {} : { resumeSelection: selection }),
	};
}

export function parseHostSessionPickerRows(value: HostSessionPickerRowCandidate): HostSessionPickerRow[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const rows: HostSessionPickerRow[] = [];
	for (const entry of value) {
		const row = parseHostSessionPickerRow(entry);
		if (!row) return undefined;
		rows.push(row);
	}
	return rows;
}

export function validateWorkflowResumeEntries(value: HostSessionPickerRowCandidate): readonly HostSessionPickerRow[] {
	const rows = parseHostSessionPickerRows(value);
	if (!rows) {
		throw new Error("Invalid workflow resume catalog: expected an array of valid HostSessionPickerRow entries.");
	}
	return rows;
}

export interface WorkflowResumeExtensionRunner {
	getWorkflowRunControl(): WorkflowRunControl | undefined;
	createCommandContext(): ExtensionCommandContext;
}

export interface WorkflowResumeSession {
	readonly extensionRunner?: WorkflowResumeExtensionRunner;
}

export async function listWorkflowResumeEntries(
	session: WorkflowResumeSession,
	target?: string,
): Promise<readonly HostSessionPickerRow[]> {
	const control = session.extensionRunner?.getWorkflowRunControl();
	if (typeof control?.listResumeEntries !== "function") return [];
	return validateWorkflowResumeEntries(await control.listResumeEntries(target));
}

export async function resumeWorkflowFromPicker(
	session: WorkflowResumeSession,
	target: string,
	selection?: HostSessionPickerRow["resumeSelection"],
): Promise<boolean> {
	const runner = session.extensionRunner;
	const control = runner?.getWorkflowRunControl();
	if (!runner || typeof control?.resumeFromPicker !== "function") return false;
	await control.resumeFromPicker(target, runner.createCommandContext(), selection);
	return true;
}

export async function deleteWorkflowFromPicker(session: WorkflowResumeSession, runId: string): Promise<void> {
	const control = session.extensionRunner?.getWorkflowRunControl();
	if (typeof control?.deleteResumeEntry !== "function") {
		throw new WorkflowRunControlUnavailableError("Workflow run deletion is unavailable for this session.", {
			runId,
		});
	}
	await control.deleteResumeEntry(runId);
}
