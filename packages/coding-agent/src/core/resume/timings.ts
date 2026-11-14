import { asyncScope } from "../async-scope.ts";
import { failureDebugFields, reportDebug } from "../debug.ts";
import type { SessionManager } from "../session-manager.ts";
import type { BlueprintSection } from "./blueprint/errors.ts";

/** The custom entry type a resume records its {@link ResumeTimings} under. */
export const RESUME_TIMINGS_TYPE = "resume_timings";

/** A part of restoring one checkout, in the order a restore runs them. */
export type RestorePhase = "fetch" | "reconstruct" | "materialize" | "lfs" | "verify" | "publish" | "seed";
/** How a checkout came to be where the session continues. */
export type CheckoutRestoreMode = "fresh" | "claimed" | "in-place" | "degraded";
/** How the commit a restore checks out reached the object store: it was there, or was fetched, or came from the bundle. */
export type RestoreFetchMode = "none" | "shallow" | "full" | "bundle";
/** How a blueprint step ended. */
export type BlueprintStepExit = "ok" | "failed" | "timed-out";

export interface CheckoutRestoreTimings {
	readonly root: string;
	readonly mode: CheckoutRestoreMode;
	readonly fetch: RestoreFetchMode;
	/** The whole restore of this checkout, phases and what runs between them. */
	readonly ms: number;
	readonly phases: Readonly<Partial<Record<RestorePhase, number>>>;
}

export interface BlueprintStepTiming {
	readonly section: BlueprintSection;
	readonly name: string;
	readonly ms: number;
	readonly exit: BlueprintStepExit;
}

/** Where one resume's time went. Every duration is in whole milliseconds. */
export interface ResumeTimings {
	readonly version: 1;
	/** When the resume started: when the process launched, for a resume `atomic --session` started. */
	readonly startedAt: string;
	readonly restores: readonly CheckoutRestoreTimings[];
	readonly blueprint: readonly BlueprintStepTiming[];
	/** From `startedAt` until the session was ready for its first prompt. */
	readonly firstPromptReadyMs: number | null;
	/** From `startedAt` until the blueprint build's last step finished; null when the resume ran no step. */
	readonly blueprintReadyMs: number | null;
}

const PHASE_ORDER: readonly RestorePhase[] = [
	"fetch",
	"reconstruct",
	"materialize",
	"lfs",
	"verify",
	"publish",
	"seed",
];

interface CheckoutTimer {
	fetch: RestoreFetchMode;
	readonly phases: Map<RestorePhase, number>;
}

const currentResume = asyncScope<ResumeTimingsRecorder>();
const currentCheckout = asyncScope<CheckoutTimer>();

/**
 * Collects the timings of one resume. Code that runs inside {@link ResumeTimingsRecorder.run} reports to it through
 * {@link timeCheckoutRestore}, {@link timeRestorePhase}, {@link noteRestoreFetch} and {@link recordBlueprintStep};
 * outside a run those only run what they wrap.
 */
export class ResumeTimingsRecorder {
	private readonly origin: number;
	private readonly restores: CheckoutRestoreTimings[] = [];
	private readonly steps: BlueprintStepTiming[] = [];
	private blueprintReady: number | undefined;

	/** `origin` is when the resume started on the `performance.now()` clock: 0 is when the process launched. */
	constructor(origin = performance.now()) {
		this.origin = origin;
	}

	/** Runs `action` with this recorder receiving what the code it calls reports. */
	run<T>(action: () => Promise<T>): Promise<T> {
		return currentResume.run(this, action);
	}

	/** Whether the resume restored a checkout or ran a blueprint step. */
	get recordedWork(): boolean {
		return this.restores.length > 0 || this.steps.length > 0;
	}

	addRestore(restore: CheckoutRestoreTimings): void {
		this.restores.push(restore);
	}

	/** Records a step that just finished; the build counts as settled when its last step finished. */
	addBlueprintStep(step: BlueprintStepTiming): void {
		this.steps.push(step);
		this.blueprintReady = performance.now();
	}

	/** The timings so far, with the session ready for its first prompt now. */
	finish(): ResumeTimings {
		const since = (time: number) => Math.max(0, Math.floor(time - this.origin));
		return {
			version: 1,
			startedAt: new Date(performance.timeOrigin + this.origin).toISOString(),
			restores: [...this.restores],
			blueprint: [...this.steps],
			firstPromptReadyMs: since(performance.now()),
			blueprintReadyMs: this.blueprintReady === undefined ? null : since(this.blueprintReady),
		};
	}
}

/**
 * Times the restore of the checkout recorded at `root`, with the phases {@link timeRestorePhase} reports inside it.
 * `modeOf` says how the checkout was restored, or undefined when it was not, which records nothing; a restore that
 * throws records nothing either.
 */
export async function timeCheckoutRestore<T>(
	root: string,
	restore: () => Promise<T>,
	modeOf: (result: T) => CheckoutRestoreMode | undefined,
): Promise<T> {
	const recorder = currentResume.getStore();
	if (recorder === undefined) return restore();
	const timer: CheckoutTimer = { fetch: "none", phases: new Map() };
	const started = performance.now();
	const result = await currentCheckout.run(timer, restore);
	const mode = modeOf(result);
	if (mode !== undefined) {
		const phases: Partial<Record<RestorePhase, number>> = {};
		for (const [phase, ms] of timer.phases) phases[phase] = Math.floor(ms);
		recorder.addRestore({ root, mode, fetch: timer.fetch, ms: Math.floor(performance.now() - started), phases });
	}
	return result;
}

/** Runs `action` as `phase` of the checkout restore it is part of; a phase that runs again adds to its time. */
export async function timeRestorePhase<T>(phase: RestorePhase, action: () => Promise<T>): Promise<T> {
	const timer = currentCheckout.getStore();
	if (timer === undefined) return action();
	const started = performance.now();
	try {
		return await action();
	} finally {
		timer.phases.set(phase, (timer.phases.get(phase) ?? 0) + performance.now() - started);
	}
}

/** Records how the checkout restore this runs in got its commit. */
export function noteRestoreFetch(mode: RestoreFetchMode): void {
	const timer = currentCheckout.getStore();
	if (timer !== undefined) timer.fetch = mode;
}

/** Records a blueprint step that finished during the resume this runs in. */
export function recordBlueprintStep(step: BlueprintStepTiming): void {
	currentResume.getStore()?.addBlueprintStep(step);
}

/**
 * Appends `timings` to `session` as one {@link RESUME_TIMINGS_TYPE} custom entry. A failure to write it is only
 * debug-logged: timings never stop a resume.
 */
export async function recordResumeTimings(
	session: Pick<SessionManager, "appendCustomEntry">,
	timings: ResumeTimings,
): Promise<void> {
	try {
		await session.appendCustomEntry(RESUME_TIMINGS_TYPE, timings);
	} catch (error) {
		reportDebug("storage", "resume-timings-not-recorded", failureDebugFields(error));
	}
}

/** Whether `value` is timings this version writes: entries of another version are not read. */
function isResumeTimings(value: unknown): value is ResumeTimings {
	const timings = value as Partial<Record<keyof ResumeTimings, unknown>> | null | undefined;
	return timings?.version === 1 && Array.isArray(timings.restores) && Array.isArray(timings.blueprint);
}

/** The timings of the latest resume recorded on the session's active branch, if any. */
export function latestResumeTimings(session: Pick<SessionManager, "getBranch">): ResumeTimings | undefined {
	const branch = session.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "custom" && entry.customType === RESUME_TIMINGS_TYPE) {
			return isResumeTimings(entry.data) ? entry.data : undefined;
		}
	}
	return undefined;
}

function seconds(ms: number): string {
	return (ms / 1000).toFixed(1);
}

/**
 * `timings` as lines for people: one per restored checkout with its phases, one for the blueprint steps, and when the
 * session was ready, as in `restored /repo in 18.5 s (fetch 9.9 full, verify 0.2)`.
 */
export function formatResumeTimings(timings: ResumeTimings): string[] {
	const lines: string[] = [];
	for (const restore of timings.restores) {
		const phases = PHASE_ORDER.flatMap((phase) => {
			const ms = restore.phases[phase];
			if (ms === undefined) return [];
			const label = phase === "lfs" ? "LFS" : phase;
			return [`${label} ${seconds(ms)}${phase === "fetch" && restore.fetch !== "none" ? ` ${restore.fetch}` : ""}`];
		});
		const mode = restore.mode === "fresh" ? "" : ` (${restore.mode})`;
		lines.push(
			`restored ${restore.root}${mode} in ${seconds(restore.ms)} s${phases.length > 0 ? ` (${phases.join(", ")})` : ""}`,
		);
	}
	if (timings.blueprint.length > 0) {
		const total = timings.blueprint.reduce((sum, step) => sum + step.ms, 0);
		const steps = timings.blueprint.map(
			(step) => `${step.name} ${seconds(step.ms)}${step.exit === "ok" ? "" : ` ${step.exit}`}`,
		);
		lines.push(`blueprint ${seconds(total)} s (${steps.join(", ")})`);
	}
	if (timings.firstPromptReadyMs !== null) lines.push(`ready after ${seconds(timings.firstPromptReadyMs)} s`);
	return lines;
}
