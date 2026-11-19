import { isAbsolute, relative, resolve, sep } from "node:path";
import { clickableHintText } from "@bastani/atomic";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { listOpenableCompletedWorkflows } from "../durable/completed-catalog.js";
import { openCompletedDurableWorkflow } from "../durable/completed-inspection.js";
import { formatResumableWorkflowList } from "../durable/resume-catalog.js";
import { isWorkflowRunResumable } from "../durable/resume-eligibility.js";
import { type DurableWorkflowDeleteOutcome, deleteDurableWorkflowIfSafe } from "../durable/retention-policy.js";
import { isSdkReleasedRunAdoptableAsync } from "../durable/sdk-recovery-scope.js";
import { requireStoreDurableBackend } from "../durable/store-backend.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";
import { pathExists } from "../shared/path-exists.js";
import { resolveRunIdTarget } from "../shared/run-id.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import { store as defaultStore, type Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowDefinition } from "../shared/types.js";
import { workflowRunResumeCandidate } from "../shared/workflow-artifacts.js";
import { recordedWorkflowDefinitionSource, workflowSource } from "../shared/workflow-source.js";
import { colorsOff } from "../tui/color-utils.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import { openWorkflowResumeSelector } from "../tui/workflow-resume-selector.js";
import { definitionDigest } from "../workers/definitions.js";
import type { ExtensionAPI, PiCommandContext, PiEventContext } from "./public-types.js";
import type { ExtensionRuntime } from "./runtime.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import type { WorkflowCommandReporter } from "./workflow-command-utils.js";
import { workflowCaller } from "./workflow-instance-owner.js";
import { captureWorkflowOwnerResources, type WorkflowOwnerResources } from "./workflow-owner-resources.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import { projectTrustConfirmation } from "./workflow-project-trust.js";
import { injectWorkflowResumeSummary } from "./workflow-resume-summary.js";
import { overlaySurfaceFromContext } from "./workflow-targets.js";

export interface WorkflowRunControlDeps {
	pi: ExtensionAPI;
	overlay: GraphOverlayPort;
	runtimeForContext: (ctx?: PiCommandContext) => ExtensionRuntime;
	ensureWorkflowResourcesLoaded: () => Promise<void> | void;
	/** Seed lifecycle state before the direct completed-inspection fallback restores history. */
	beforeRestoreCompleted?: (snapshots: readonly RunSnapshot[]) => void;
	owner?: WorkflowOwnerResources;
	isGenerationCurrent?: () => boolean;
}

export const WORKFLOW_DEFINITION_CHANGED_TITLE = "Workflow definition changed since this run started";
export const WORKFLOW_DEFINITION_CHANGED_CONFIRM_LABEL = "resume with the new definition";
export const WORKFLOW_DEFINITION_CHANGED_CANCEL_LABEL = "cancel";
export const WORKFLOW_DEFINITION_CHANGED_INLINE_PROMPT =
	"Workflow definition changed since this run started · enter resume with the new definition · esc cancel";

export function isResumeContextActive(ctx: PiCommandContext, isGenerationCurrent?: () => boolean): boolean {
	if (isGenerationCurrent && !isGenerationCurrent()) return false;
	const commandSignal = (ctx as { readonly signal?: AbortSignal }).signal;
	if (commandSignal?.aborted === true) return false;
	const sessionSignal = ctx.getCurrentSessionSignal?.() ?? ctx.sessionSignal;
	if (sessionSignal?.aborted === true) return false;
	return true;
}

export function cleanEntryChangeReason(reason: string | undefined): string | undefined {
	if (!reason) return undefined;
	const firstLine =
		reason
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0 && !/^at\s+\S.*(?::\d+:\d+\)?|\((?:native|<anonymous>)\))$/.test(line)) ?? "";
	const withoutPrefix = firstLine
		.replace(/^Failed to resume durable workflow [^:]+:\s*/i, "")
		.replace(/^(Error|[A-Z][A-Za-z]*Error):\s*/, "")
		.replace(/\.\s*Its recorded steps and queued children depend on these[\s\S]*$/i, ".")
		.replace(/\.\s*An edited entry module can also be accepted:[\s\S]*$/i, ".")
		.replace(/\.\s*Resume (?:the )?root [\s\S]*$/i, ".")
		.replace(/\s+/g, " ")
		.trim();
	return withoutPrefix || undefined;
}

export function isEditedEntryModuleRefusal(message: string | undefined): boolean {
	if (!message) return false;
	if (
		/Pool boundary identity conflict: child .+ was queued by an earlier run of root .+ with the entry module of (?:worker|workflow) definition/i.test(
			message,
		)
	) {
		return true;
	}
	const cleaned = cleanEntryChangeReason(message);
	if (!cleaned || /Invalid worker placement configuration/i.test(cleaned)) return false;
	const sinceRoot = /^Since root [^ ]+ started, ?(.+?)\.?$/i.exec(cleaned);
	const clauseList = sinceRoot ? sinceRoot[1]! : cleaned.replace(/\.$/, "");
	const parts = clauseList
		.split(";")
		.map((part) => part.trim())
		.filter(Boolean);
	return (
		parts.length > 0 &&
		parts.every((part) => /^the entry module of (?:worker|workflow) definition .+ was edited\b/i.test(part))
	);
}

async function resolveSavedSourcePath(
	savedPath: string,
	recordedCwd: string | undefined,
	fallbackCwd: string | undefined,
): Promise<string> {
	const baseCwd = recordedCwd ?? fallbackCwd ?? process.cwd();
	if (recordedCwd !== undefined && fallbackCwd !== undefined && fallbackCwd !== recordedCwd) {
		const rel = relative(recordedCwd, resolve(recordedCwd, savedPath));
		if (rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
			const relocated = resolve(fallbackCwd, rel);
			if (await pathExists(relocated)) return relocated;
		}
	}
	return resolve(baseCwd, savedPath);
}

async function resolveWorkflowCandidatePath(
	savedPath: string,
	recordedCwd: string | undefined,
	fallbackCwd: string | undefined,
	registeredDef: WorkflowDefinition | undefined,
): Promise<string> {
	const registeredPath = registeredDef !== undefined ? workflowSource(registeredDef) : undefined;
	if (
		registeredPath !== undefined &&
		(await pathExists(registeredPath)) &&
		(fallbackCwd === undefined || recordedCwd === undefined || fallbackCwd === recordedCwd)
	) {
		return registeredPath;
	}
	const candidatePath = await resolveSavedSourcePath(savedPath, recordedCwd, fallbackCwd);
	if (!(await pathExists(candidatePath)) && registeredPath !== undefined) {
		return registeredPath;
	}
	return candidatePath;
}

export async function findEditedWorkerEntryModuleReason(
	backend: DurableWorkflowBackend | undefined,
	workflowId: string,
	fallbackCwd?: string,
	runtime?: Pick<ExtensionRuntime, "registry">,
): Promise<string | undefined> {
	if (backend === undefined) return undefined;
	const handle = backend.getWorkflow(workflowId);
	if (handle === undefined) return undefined;
	const recordedCwd = handle.workflowCwd ?? handle.invocationCwd;
	const registeredDef = runtime?.registry?.get?.(handle.name);
	const workflowSourceEntry =
		handle.definitionSource ??
		(registeredDef !== undefined ? await recordedWorkflowDefinitionSource(registeredDef) : undefined);
	const descriptions: string[] = [];
	if (workflowSourceEntry !== undefined) {
		try {
			const candidatePath = await resolveWorkflowCandidatePath(
				workflowSourceEntry.path,
				recordedCwd,
				fallbackCwd,
				registeredDef,
			);
			const currentDigest = await definitionDigest(candidatePath);
			if (currentDigest !== workflowSourceEntry.digest) {
				descriptions.push(
					`the entry module of workflow definition ${handle.name} (${workflowSourceEntry.path}) was edited (sha256 ${workflowSourceEntry.digest.slice(0, 12)} to ${currentDigest.slice(0, 12)})`,
				);
			}
		} catch {}
	}
	const definitions = handle.resources?.definitions;
	if (definitions && definitions.length > 0) {
		for (const source of definitions) {
			try {
				const resolvedPath = await resolveSavedSourcePath(source.path, recordedCwd, fallbackCwd);
				const currentDigest = await definitionDigest(resolvedPath);
				if (currentDigest !== source.digest) {
					const name = `${source.path}#${source.exportName || "default"}`;
					descriptions.push(
						`the entry module of worker definition ${name} was edited (sha256 ${source.digest.slice(0, 12)} to ${currentDigest.slice(0, 12)})`,
					);
				}
			} catch {
				return undefined;
			}
		}
	}
	if (descriptions.length === 0) return undefined;
	return `Since root ${handle.workflowId} started, ${descriptions.join("; ")}.`;
}

function isResumePromptTheme(
	theme: object,
): theme is { readonly fg: (color: "warning" | "dim", text: string) => string } {
	return typeof Reflect.get(theme, "fg") === "function";
}

function renderWorkflowDefinitionChangedPrompt(width: number, theme: object): string[] {
	const fg = isResumePromptTheme(theme) && !colorsOff() ? theme.fg.bind(theme) : undefined;
	const pad = width > 4 ? "  " : "";
	const inner = Math.max(1, width - pad.length);
	const hint = ` · enter ${WORKFLOW_DEFINITION_CHANGED_CONFIRM_LABEL} · esc ${WORKFLOW_DEFINITION_CHANGED_CANCEL_LABEL}`;
	const styled = fg
		? `${fg("warning", WORKFLOW_DEFINITION_CHANGED_TITLE)}${fg("dim", clickableHintText(hint))}`
		: clickableHintText(WORKFLOW_DEFINITION_CHANGED_INLINE_PROMPT);
	return wrapTextWithAnsi(styled, inner).map((line) => truncateToWidth(`${pad}${line}`, Math.max(1, width), ""));
}

export async function confirmEditedWorkflowDefinition(
	ctx: PiCommandContext,
	_reason?: string,
	isGenerationCurrent?: () => boolean,
): Promise<"confirmed" | "cancelled" | "unavailable"> {
	const policy = workflowPolicyFromContext(ctx);
	if (!policy.allowHumanInput || ctx.hasUI === false) return "unavailable";
	if (!isResumeContextActive(ctx, isGenerationCurrent)) return "cancelled";
	const commandSignal = (ctx as { readonly signal?: AbortSignal }).signal;
	const sessionSignal = ctx.getCurrentSessionSignal?.() ?? ctx.sessionSignal;
	const signals = [commandSignal, sessionSignal].filter((sig): sig is AbortSignal => sig !== undefined);
	const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

	if (typeof ctx.ui?.custom === "function") {
		const confirmed = await ctx.ui.custom(
			(_tui, theme, _keybindings, done) => {
				const promptTheme = typeof theme === "object" && theme !== null ? theme : {};
				let settled = false;
				const finish = (value: boolean): void => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					done(value);
				};
				const onAbort = (): void => finish(false);
				if (signal?.aborted) {
					finish(false);
				} else {
					signal?.addEventListener("abort", onAbort, { once: true });
				}
				let focused = false;
				return {
					capturesViewportInput: true,
					get focused() {
						return focused;
					},
					set focused(value: boolean) {
						focused = value;
					},
					render: (width: number) => renderWorkflowDefinitionChangedPrompt(width, promptTheme),
					invalidate: () => undefined,
					handleInput: (data: string) => {
						if (!isResumeContextActive(ctx, isGenerationCurrent)) finish(false);
						else if (matchesKey(data, "enter")) finish(true);
						else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) finish(false);
						return true;
					},
					dispose: () => {
						signal?.removeEventListener("abort", onAbort);
					},
				};
			},
			{
				overlay: false,
				purpose: "prompt",
				...(signal ? { signal } : {}),
			},
		);
		if (confirmed !== true || !isResumeContextActive(ctx, isGenerationCurrent)) return "cancelled";
		return "confirmed";
	}
	if (typeof ctx.ui?.confirm === "function") {
		const confirmed = await Promise.resolve(
			ctx.ui.confirm(WORKFLOW_DEFINITION_CHANGED_TITLE, WORKFLOW_DEFINITION_CHANGED_INLINE_PROMPT),
		).catch(() => false);
		if (confirmed !== true || !isResumeContextActive(ctx, isGenerationCurrent)) return "cancelled";
		return "confirmed";
	}
	return "unavailable";
}

export interface WorkflowResumeCatalog {
	readonly resumable: readonly ResumableWorkflowEntry[];
	readonly completed: readonly ResumableWorkflowEntry[];
}

export const ACCEPT_ENTRY_CHANGES_FLAG = "--accept-entry-changes";

export interface DurableResumeCommandOptions {
	readonly acceptEntryChanges?: boolean;
}

export interface WorkflowResumeTarget {
	readonly kind: "live" | "durable" | "completed";
	readonly workflowId: string;
	readonly name: string;
}

export type WorkflowResumeTargetResolution =
	| WorkflowResumeTarget
	| { readonly kind: "malformed"; readonly message: string }
	| { readonly kind: "ambiguous"; readonly message: string }
	| { readonly kind: "not_found" };

export function stageScopedDurableResumeMessage(workflowId: string): string {
	return `Stage-scoped resume is not supported for durable workflow ${workflowId}. Omit the stage selector to resume the whole run.`;
}

export async function prepareWorkflowResumeCatalog(
	runtime: ExtensionRuntime,
	suppressedLiveIds: ReadonlySet<string>,
	target?: string,
): Promise<WorkflowResumeCatalog> {
	const cleanTarget =
		target === undefined
			? undefined
			: target
					.replace(/^workflow-(?:live|durable|completed):/, "")
					.trim()
					.split(/\s+/)[0] || undefined;
	const shared = await runtime.prepareDurableCatalog?.();
	let prepared = shared?.resumable ?? (await runtime.prepareDurableResumable(cleanTarget));
	if (cleanTarget !== undefined && shared !== undefined) {
		const matchedInShared = resolveRunIdTarget(
			cleanTarget,
			[...shared.resumable, ...shared.completed].map((entry) => entry.workflowId),
		);
		if (matchedInShared.kind === "not_found") {
			const targeted = await runtime.prepareDurableResumable(cleanTarget);
			const byId = new Map(prepared.map((entry) => [entry.workflowId, entry]));
			for (const entry of targeted) byId.set(entry.workflowId, entry);
			prepared = [...byId.values()];
		}
	}
	const fallbackBackend = shared === undefined && cleanTarget === undefined ? runtime.durableBackend() : undefined;
	const activeBackend = (): DurableWorkflowBackend | undefined => {
		try {
			return runtime.durableBackend();
		} catch {
			return fallbackBackend;
		}
	};
	const isDisplayLoadable = (entry: ResumableWorkflowEntry): boolean => {
		const backend = activeBackend();
		return backend === undefined || backend.isWorkflowLoadable(entry.workflowId);
	};
	const matchedTargetId =
		cleanTarget === undefined
			? undefined
			: (() => {
					const resolution = resolveRunIdTarget(
						cleanTarget,
						prepared.map((entry) => entry.workflowId),
					);
					return resolution.kind === "exact" || resolution.kind === "unique_prefix" ? resolution.runId : undefined;
				})();
	// The durable catalog is already produced by `listResumableWorkflows()`, which
	// applies `isDurableWorkflowResumable`; re-filtering here would only drop rows
	// a hydrating backend has not yet materialized.
	const resumable = filterSelectorDurableEntries(runtime, prepared, matchedTargetId).filter(
		(entry) => !suppressedLiveIds.has(entry.workflowId) && isDisplayLoadable(entry),
	);
	const completed =
		shared?.completed ??
		(runtime.prepareCompletedDurable !== undefined
			? await runtime.prepareCompletedDurable()
			: await listOpenableCompletedWorkflows(activeBackend() ?? runtime.durableBackend()));
	return {
		resumable,
		completed: completed.filter((entry) => isDisplayLoadable(entry)),
	};
}

export function deleteWorkflowResumeEntry(
	workflowId: string,
	store: Store = defaultStore,
): Promise<DurableWorkflowDeleteOutcome> {
	return deleteDurableWorkflowIfSafe(requireStoreDurableBackend(store, workflowId), workflowId, (candidateId) => {
		const run = store.run(candidateId);
		return (
			run !== undefined &&
			run.status !== "completed" &&
			(run.endedAt === undefined || run.status === "paused" || run.exitReason === "quit")
		);
	});
}

export async function handleDurableResume(
	target: string | undefined,
	ctx: PiCommandContext,
	reporter: WorkflowCommandReporter,
	deps: WorkflowRunControlDeps,
	preparedCatalog?: WorkflowResumeCatalog,
	resumeOptions: DurableResumeCommandOptions = {},
): Promise<boolean> {
	const owner = deps.owner ?? captureWorkflowOwnerResources();
	deps = { ...deps, owner };
	const print = (message: string): void => reporter.info(message);
	const fail = (message: string): void => reporter.error(message);
	try {
		await deps.ensureWorkflowResourcesLoaded();
	} catch (error) {
		ctx.ui?.notify(formatWorkflowResourceLoadWarning(error), "warning");
	}
	const runtime = deps.runtimeForContext(ctx);
	const policy = workflowPolicyFromContext(ctx);
	const catalog = preparedCatalog ?? (await prepareWorkflowResumeCatalog(runtime, new Set(), target));
	const allOpenable = [...catalog.resumable, ...catalog.completed];

	if (target !== undefined) {
		const resolved = resolveWorkflowResumeTarget(
			target,
			[],
			catalog.resumable,
			// Reuse the catalog prepared above instead of re-enumerating the durable
			// directory a second time for the same command invocation.
			catalog.completed,
		);
		if (resolved.kind === "malformed" || resolved.kind === "ambiguous") {
			fail(resolved.message);
			return true;
		}
		if (resolved.kind === "completed") {
			return openCompletedTarget(resolved.workflowId, catalog.completed, ctx, reporter, deps, runtime);
		}
		if (resolved.kind === "durable") {
			return await resumeDurableTarget(resolved.workflowId, ctx, reporter, deps, runtime, resumeOptions);
		}

		const completedAttempt = await openCompleted(
			runtime,
			target,
			catalog.completed,
			deps.beforeRestoreCompleted,
			owner.store,
		);
		if (!completedAttempt.ok && completedAttempt.reason !== "not_found") {
			fail(completedAttempt.message);
			return true;
		}
		return await resumeDurableTarget(target, ctx, reporter, deps, runtime, resumeOptions, allOpenable);
	}

	if (allOpenable.length === 0) {
		fail(
			"No resumable or completed durable workflows found. Usage: /resume <id> (or /resume for sessions and workflow runs).",
		);
		return true;
	}
	if (!policy.allowInputPicker) {
		const instruction = catalog.completed.length === 0 ? "Resume with" : "Resume/open with";
		print(`${formatResumableWorkflowList(allOpenable)}\n\n${instruction}: /resume <id>`);
		return true;
	}
	let picked: Awaited<ReturnType<typeof openWorkflowResumeSelector>>;
	try {
		picked = await openWorkflowResumeSelector(
			ctx.ui,
			[],
			// Catalog already prepared above; resolve it immediately with no rescan.
			() => Promise.resolve({ durable: catalog.resumable, completed: catalog.completed }),
			{ deleteWorkflow: (workflowId) => deleteWorkflowResumeEntry(workflowId, owner.store) },
		);
	} catch (error) {
		// No fallback: a host without the session-picker capability fails the
		// resume command with one actionable message.
		fail(error instanceof Error ? error.message : String(error));
		return true;
	}
	if (picked.result.kind === "durable") {
		return resumeDurableTarget(picked.result.workflowId, ctx, reporter, deps, runtime, resumeOptions);
	}
	if (picked.result.kind === "completed") {
		return openCompletedTarget(picked.result.workflowId, catalog.completed, ctx, reporter, deps, runtime);
	}
	return true;
}

function filterSelectorDurableEntries(
	runtime: ExtensionRuntime,
	entries: readonly ResumableWorkflowEntry[],
	targetedRunId?: string,
): readonly ResumableWorkflowEntry[] {
	const registry = runtime.registry as { has(name: string): boolean } | undefined;
	if (registry === undefined) return entries;
	return entries.filter((entry) => {
		if (targetedRunId !== undefined && entry.workflowId === targetedRunId) return true;
		const requiresDefinition = entry.status === "running" || entry.status === "failed" || entry.status === "blocked";
		return !requiresDefinition || registry.has(entry.name);
	});
}

export function resolveWorkflowResumeTarget(
	target: string,
	liveRuns: readonly RunSnapshot[],
	resumable: readonly ResumableWorkflowEntry[],
	completed: readonly ResumableWorkflowEntry[],
	sessionRuns?: readonly RunSnapshot[],
	backend?: DurableWorkflowBackend,
): WorkflowResumeTargetResolution {
	const targets = new Map<string, WorkflowResumeTarget>();
	for (const entry of resumable) {
		targets.set(entry.workflowId, { kind: "durable", workflowId: entry.workflowId, name: entry.name });
	}
	for (const entry of completed) {
		if (!targets.has(entry.workflowId)) {
			targets.set(entry.workflowId, { kind: "completed", workflowId: entry.workflowId, name: entry.name });
		}
	}
	// Nested children stay reachable by exact id; prefix resume uses the top-level namespace.
	for (const run of topLevelWorkflowRuns(liveRuns).filter((live) =>
		isExplicitResumeCandidate(live, sessionRuns, backend),
	)) {
		targets.set(run.id, {
			kind: run.status === "completed" ? "completed" : "live",
			workflowId: run.id,
			name: run.name,
		});
	}
	const resolution = resolveRunIdTarget(target, targets.keys());
	if (resolution.kind === "malformed" || resolution.kind === "ambiguous" || resolution.kind === "not_found") {
		return resolution;
	}
	return targets.get(resolution.runId) ?? { kind: "not_found" };
}

function isExplicitResumeCandidate(
	run: RunSnapshot,
	sessionRuns: readonly RunSnapshot[] | undefined,
	backend?: DurableWorkflowBackend,
): boolean {
	if (run.status === "completed") return true;
	return (
		isWorkflowRunResumable(workflowRunResumeCandidate(run, sessionRuns, backend)) ||
		(run.endedAt === undefined && run.status === "running")
	);
}

/** A run released by its previous session moves to the session resuming it; every other run keeps its owner. */
async function releasedRunAdoption(
	workflowId: string,
	ctx: PiEventContext,
	runtime: ExtensionRuntime,
): Promise<{ readonly modelOwner?: string }> {
	const handle = runtime.durableBackend().getLoadableWorkflow(workflowId);
	return handle !== undefined && (await isSdkReleasedRunAdoptableAsync(handle, ctx.cwd))
		? { modelOwner: workflowCaller(ctx) }
		: {};
}

function crossProjectConfirmation(
	ctx: PiEventContext,
	isGenerationCurrent?: () => boolean,
): {
	confirmCrossProjectFork?: (cwd: string) => Promise<boolean>;
	confirmProjectTrust?: (projectDir: string) => Promise<boolean>;
	forkModelOwner?: string;
} {
	const confirm = ctx.ui.confirm;
	const policy = workflowPolicyFromContext(ctx);
	return policy.allowInputPicker && confirm !== undefined
		? {
				forkModelOwner: workflowCaller(ctx),
				confirmCrossProjectFork: async (cwd) => {
					if (!isResumeContextActive(ctx, isGenerationCurrent)) return false;
					const confirmed = await confirm(
						"Resume workflow",
						`Workflow run found in different project: ${cwd}. Fork it into the current directory?`,
					);
					return confirmed === true && isResumeContextActive(ctx, isGenerationCurrent);
				},
				...projectTrustConfirmation(ctx, policy),
			}
		: {};
}

async function resumeDurableTarget(
	workflowId: string,
	ctx: PiCommandContext,
	reporter: WorkflowCommandReporter,
	deps: WorkflowRunControlDeps,
	runtime: ExtensionRuntime,
	resumeOptions: DurableResumeCommandOptions,
	fallbackOpenable: readonly ResumableWorkflowEntry[] = [],
): Promise<boolean> {
	if (!isResumeContextActive(ctx, deps.isGenerationCurrent)) return true;
	let effectiveOptions: DurableResumeCommandOptions = resumeOptions;
	const backend = (() => {
		try {
			return runtime.durableBackend();
		} catch {
			return undefined;
		}
	})();
	if (effectiveOptions.acceptEntryChanges !== true) {
		const precheckReason = await findEditedWorkerEntryModuleReason(backend, workflowId, ctx.cwd, runtime);
		if (precheckReason !== undefined) {
			const decision = await confirmEditedWorkflowDefinition(ctx, precheckReason, deps.isGenerationCurrent);
			if (decision === "unavailable") {
				reporter.error(precheckReason);
				return true;
			}
			if (decision === "cancelled") {
				if (isResumeContextActive(ctx, deps.isGenerationCurrent)) {
					reporter.info("Workflow resume cancelled.");
				}
				return true;
			}
			effectiveOptions = { ...effectiveOptions, acceptEntryChanges: true };
		}
	}
	if (!isResumeContextActive(ctx, deps.isGenerationCurrent)) return true;
	const adoption = await releasedRunAdoption(workflowId, ctx, runtime);
	if (!isResumeContextActive(ctx, deps.isGenerationCurrent)) return true;
	const runResume = (opts: DurableResumeCommandOptions) =>
		runtime.resumeDurableWorkflow(workflowId, {
			policy: workflowPolicyFromContext(ctx),
			actor: "user",
			...crossProjectConfirmation(ctx, deps.isGenerationCurrent),
			onBeforeResume: (runId, forkedFrom) =>
				injectWorkflowResumeSummary(deps.pi, ctx, runId, undefined, forkedFrom, runtime.durableBackend()),
			...adoption,
			...opts,
		});
	let result = await runResume(effectiveOptions);
	if (!result.ok && effectiveOptions.acceptEntryChanges !== true && isEditedEntryModuleRefusal(result.message)) {
		const decision = await confirmEditedWorkflowDefinition(ctx, result.message, deps.isGenerationCurrent);
		if (decision === "unavailable") {
			reporter.error(result.message);
			return true;
		}
		if (decision === "cancelled") {
			if (isResumeContextActive(ctx, deps.isGenerationCurrent)) {
				reporter.info("Workflow resume cancelled.");
			}
			return true;
		}
		if (!isResumeContextActive(ctx, deps.isGenerationCurrent)) return true;
		result = await runResume({ ...effectiveOptions, acceptEntryChanges: true });
	}
	if (!result.ok) {
		reporter.error(
			fallbackOpenable.length === 0
				? result.message
				: `${result.message}\n\n${formatResumableWorkflowList(fallbackOpenable)}`,
		);
	} else {
		reporter.info(result.message);
		if (workflowPolicyFromContext(ctx).allowInputPicker) {
			deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
		}
	}
	return true;
}

export async function resumeFailedRunWithConfirmation(
	stageRunId: string,
	stageId: string | undefined,
	ctx: PiCommandContext,
	reporter: WorkflowCommandReporter,
	deps: WorkflowRunControlDeps,
	runtime: ExtensionRuntime,
	resumeOptions: DurableResumeCommandOptions = {},
): Promise<boolean> {
	if (!isResumeContextActive(ctx, deps.isGenerationCurrent)) return true;
	const policy = workflowPolicyFromContext(ctx);
	let effectiveOptions: DurableResumeCommandOptions = resumeOptions;
	const backend = (() => {
		try {
			return runtime.durableBackend();
		} catch {
			return undefined;
		}
	})();
	if (effectiveOptions.acceptEntryChanges !== true) {
		const precheckReason = await findEditedWorkerEntryModuleReason(backend, stageRunId, ctx.cwd, runtime);
		if (precheckReason !== undefined) {
			const decision = await confirmEditedWorkflowDefinition(ctx, precheckReason, deps.isGenerationCurrent);
			if (decision === "unavailable") {
				reporter.error(precheckReason);
				return true;
			}
			if (decision === "cancelled") {
				if (isResumeContextActive(ctx, deps.isGenerationCurrent)) {
					reporter.info("Workflow resume cancelled.");
				}
				return true;
			}
			effectiveOptions = { ...effectiveOptions, acceptEntryChanges: true };
		}
	}
	if (!isResumeContextActive(ctx, deps.isGenerationCurrent)) return true;
	let continuation = await runtime.resumeFailedRun(stageRunId, stageId, {
		policy,
		actor: "user",
		...effectiveOptions,
	});
	if (
		!continuation.ok &&
		effectiveOptions.acceptEntryChanges !== true &&
		isEditedEntryModuleRefusal(continuation.message)
	) {
		const decision = await confirmEditedWorkflowDefinition(ctx, continuation.message, deps.isGenerationCurrent);
		if (decision === "unavailable") {
			reporter.error(continuation.message);
			return true;
		}
		if (decision === "cancelled") {
			if (isResumeContextActive(ctx, deps.isGenerationCurrent)) {
				reporter.info("Workflow resume cancelled.");
			}
			return true;
		}
		if (!isResumeContextActive(ctx, deps.isGenerationCurrent)) return true;
		continuation = await runtime.resumeFailedRun(stageRunId, stageId, {
			policy,
			actor: "user",
			...effectiveOptions,
			acceptEntryChanges: true,
		});
	}
	continuation.ok ? reporter.info(continuation.message) : reporter.error(continuation.message);
	return true;
}

async function openCompletedTarget(
	workflowId: string,
	catalog: readonly ResumableWorkflowEntry[],
	ctx: PiCommandContext,
	reporter: WorkflowCommandReporter,
	deps: WorkflowRunControlDeps,
	runtime: ExtensionRuntime,
): Promise<boolean> {
	const result = await openCompleted(runtime, workflowId, catalog, deps.beforeRestoreCompleted, deps.owner?.store);
	if (!result.ok) reporter.error(result.message);
	else {
		reporter.info(result.message);
		if (workflowPolicyFromContext(ctx).allowInputPicker) {
			deps.overlay.open(result.runId, overlaySurfaceFromContext(ctx));
		}
	}
	return true;
}

function openCompleted(
	runtime: ExtensionRuntime,
	workflowId: string,
	catalog: readonly ResumableWorkflowEntry[],
	beforeRestoreCompleted?: (snapshots: readonly RunSnapshot[]) => void,
	store: Store = defaultStore,
) {
	return (
		runtime.openCompletedDurableWorkflow?.(workflowId, catalog) ??
		openCompletedDurableWorkflow(
			workflowId,
			{
				durableBackend: runtime.durableBackend(),
				store,
				beforeRestore: beforeRestoreCompleted,
			},
			catalog,
		)
	);
}
