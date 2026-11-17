import type { ExtensionCommandContext } from "@bastani/atomic";
import {
	availableStoreDurableBackend,
	DurableBackendNotInitializedError,
	requireStoreDurableBackend,
} from "../durable/store-backend.js";
import { toWorkflowPickerRow, workflowResumeSelectorItems } from "../tui/workflow-resume-selector.js";
import type { PiCommandContext, PiEventContext } from "./public-types.js";
import type { PiHostSessionPickerRow } from "./wiring.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import { createWorkflowCommandReporter, type WorkflowCommandReporter } from "./workflow-command-utils.js";
import {
	deleteWorkflowResumeEntry,
	prepareWorkflowResumeCatalog,
	type WorkflowRunControlDeps,
} from "./workflow-durable-resume-command.js";
import { captureWorkflowOwnerResources } from "./workflow-owner-resources.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { collectResumePickerLiveRuns } from "./workflow-resume-picker-rows.js";
import { handleRunControlCommand } from "./workflow-run-control-command.js";

export type WorkflowResumeCommandContext = PiCommandContext | ExtensionCommandContext;

export interface WorkflowResumeProviderDeps extends WorkflowRunControlDeps {
	readonly context: () => PiEventContext | undefined;
}

export interface WorkflowResumeProvider {
	listResumeEntries(target?: string): Promise<readonly PiHostSessionPickerRow[]>;
	resumeFromPicker(target: string, ctx?: WorkflowResumeCommandContext): Promise<void>;
	deleteResumeEntry(runId: string): Promise<void>;
}

function stripWorkflowPathPrefix(value: string): string {
	return value.replace(/^workflow-(?:live|durable|completed):/, "").trim();
}

function mergeCommandContext(
	base: PiEventContext | undefined,
	override: WorkflowResumeCommandContext | undefined,
): PiCommandContext {
	const commandOverride = override as Partial<PiCommandContext> | undefined;
	const baseUi = base?.ui;
	const overrideUi = commandOverride?.ui;
	return {
		...base,
		...commandOverride,
		cwd: commandOverride?.cwd ?? base?.cwd ?? process.cwd(),
		hasUI: commandOverride?.hasUI ?? base?.hasUI,
		hasHumanInput: commandOverride?.hasHumanInput ?? base?.hasHumanInput,
		isPresentationOnly: commandOverride?.isPresentationOnly ?? base?.isPresentationOnly,
		sessionSignal: commandOverride?.sessionSignal ?? base?.sessionSignal,
		getCurrentSessionSignal: commandOverride?.getCurrentSessionSignal ?? base?.getCurrentSessionSignal,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				if (typeof overrideUi?.notify === "function") {
					overrideUi.notify(message, type);
					return;
				}
				baseUi?.notify?.(message, type);
			},
			...baseUi,
			...overrideUi,
		},
	};
}

function sanitizePickerGuidance(message: string): string {
	return message
		.replace(/\/workflow\s+resume\s+([^\s,.;)`"]+)\s+--accept-entry-changes/g, "/resume $1")
		.replace(/--accept-entry-changes/g, "")
		.replace(/\/workflow\s+resume\b/g, "/resume")
		.replace(/\/workflow\s+(?:connect|attach)\b/g, "/workflows");
}

function formatPickerResumeError(targetId: string, message: string): string {
	const sanitized = sanitizePickerGuidance(message);
	const firstLine = sanitized.split("\n")[0]?.trim() ?? sanitized.trim();
	if (
		/^Run not found:/i.test(firstLine) ||
		/^No resumable workflow found for id:/i.test(firstLine) ||
		/^Workflow run .+ was not found\b/i.test(firstLine) ||
		/^No resumable or completed durable workflows found\b/i.test(firstLine)
	) {
		return firstLine === `Run not found: ${targetId}`
			? `Workflow run not found: ${targetId}`
			: `Workflow run not found: ${targetId} (${firstLine})`;
	}
	return sanitized;
}

export function createWorkflowResumeProvider(deps: WorkflowResumeProviderDeps): WorkflowResumeProvider {
	const resolveOwner = () => deps.owner ?? captureWorkflowOwnerResources();
	const ensureResourcesLoaded = async (ctx: PiCommandContext | undefined): Promise<void> => {
		try {
			await deps.ensureWorkflowResourcesLoaded();
		} catch (error) {
			ctx?.ui?.notify?.(formatWorkflowResourceLoadWarning(error), "warning");
		}
	};

	return {
		async listResumeEntries(target?: string): Promise<readonly PiHostSessionPickerRow[]> {
			const owner = resolveOwner();
			const activeCtx = deps.context();
			await ensureResourcesLoaded(activeCtx);
			const runtime = deps.runtimeForContext(activeCtx);
			const cleanTarget =
				target === undefined
					? undefined
					: stripWorkflowPathPrefix(target.trim().split(/\s+/)[0] ?? "") || undefined;
			const catalog = await prepareWorkflowResumeCatalog(runtime, new Set(), cleanTarget);
			const backend = availableStoreDurableBackend(owner.store);
			const shadowDeps = {
				jobs: owner.jobs,
				stageControls: owner.stageControlRegistry,
				toolControls: owner.toolControlRegistry,
				backend,
			};
			const live = collectResumePickerLiveRuns(owner.store, shadowDeps);
			const resumable = catalog.resumable.filter((entry) => !live.suppressedLiveIds.has(entry.workflowId));
			const items = workflowResumeSelectorItems(
				live.liveRuns,
				resumable,
				catalog.completed,
				owner.store.runs(),
				backend,
			);
			return items.map(toWorkflowPickerRow);
		},

		async resumeFromPicker(target: string, rawCtx?: WorkflowResumeCommandContext): Promise<void> {
			const trimmed = target.trim();
			if (!trimmed) {
				throw new Error("Workflow run not found: (empty)");
			}
			const rawTokens = trimmed.split(/\s+/).filter(Boolean);
			if (rawTokens.some((token) => token.startsWith("-"))) {
				throw new Error(
					"Workflow resume does not accept flags; use /resume <id> and confirm any definition change inline.",
				);
			}
			const targetId = stripWorkflowPathPrefix(rawTokens[0]!);
			if (!targetId) {
				throw new Error("Workflow run not found: (empty)");
			}
			const tokens = [targetId, ...rawTokens.slice(1)];
			const owner = resolveOwner();
			const commandCtx = mergeCommandContext(deps.context(), rawCtx);
			const policy = workflowPolicyFromContext(commandCtx);
			const baseReporter = createWorkflowCommandReporter(commandCtx, policy, deps.pi);
			let reportedError: string | undefined;
			const reporter: WorkflowCommandReporter = {
				info(message: string): void {
					baseReporter.info(sanitizePickerGuidance(message));
				},
				error(message: string): void {
					reportedError = message;
				},
			};
			await handleRunControlCommand("resume", tokens, commandCtx, reporter, { ...deps, owner });
			if (reportedError !== undefined) {
				throw new Error(formatPickerResumeError(targetId, reportedError));
			}
		},

		async deleteResumeEntry(runId: string): Promise<void> {
			const cleanId = stripWorkflowPathPrefix(runId);
			if (!cleanId) {
				throw new Error("Workflow run not found: (empty)");
			}
			const owner = resolveOwner();
			const activeCtx = deps.context();
			try {
				requireStoreDurableBackend(owner.store, cleanId);
			} catch (error) {
				if (!(error instanceof DurableBackendNotInitializedError)) throw error;
				await ensureResourcesLoaded(activeCtx);
				await deps.runtimeForContext(activeCtx).prepareDurableResumable(cleanId);
			}
			const outcome = await deleteWorkflowResumeEntry(cleanId, owner.store);
			if (!outcome.ok) {
				throw new Error(sanitizePickerGuidance(outcome.message));
			}
		},
	};
}
