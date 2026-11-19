import type { ExtensionCommandContext } from "./extensions/context-types.ts";
import type { HostSessionPickerRow } from "./extensions/ui-types.js";
import { type WorkflowRunControl, WorkflowRunControlUnavailableError } from "./extensions/workflow-run-control.js";

import { type HostSessionPickerRowCandidate, parseHostSessionPickerRows } from "./host-session-picker-rows.ts";

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
