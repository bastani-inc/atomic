import type { AgentTool } from "@bastani/atomic-agent-core";
import { asyncScope } from "../async-scope.ts";

/**
 * How a tool call is ordered against the other calls of the same assistant message.
 * - "shared": may overlap other shared calls; waits for the latest earlier exclusive call (default)
 * - "exclusive": waits for every earlier call; later calls wait for it
 * - function: resolved per call from its prepared arguments; a throwing resolver means "exclusive"
 */
export type ToolConcurrencyMode = "shared" | "exclusive";
export type ToolConcurrency<TArgs = Record<string, unknown>> =
	| ToolConcurrencyMode
	| ((args: Partial<TArgs>) => ToolConcurrencyMode);

export function resolveToolConcurrency<TArgs>(
	concurrency: ToolConcurrency<TArgs> | undefined,
	args: Partial<TArgs>,
): ToolConcurrencyMode {
	if (typeof concurrency !== "function") return concurrency ?? "shared";
	try {
		return concurrency(args);
	} catch {
		return "exclusive";
	}
}

/**
 * Orders tool executions in the order they start. The agent loop starts a batch's calls in
 * assistant-message order, so an exclusive call observes every earlier call's effects and no
 * later call observes the state from before it.
 */
export class ToolExecutionScheduler {
	#lastExclusive: Promise<void> | undefined;
	readonly #sharedSinceExclusive = new Set<Promise<void>>();
	readonly #scope = asyncScope<{
		mode: ToolConcurrencyMode;
		active: boolean;
		children?: ToolExecutionScheduler;
	}>();

	/** Runs `run` synchronously when nothing earlier blocks it, so its abort listeners attach immediately. */
	schedule<T>(mode: ToolConcurrencyMode, run: () => Promise<T>): Promise<T> {
		const parent = this.#scope.getStore();
		if (parent?.active) {
			if (parent.mode === "shared" && mode === "exclusive") {
				return Promise.reject(
					new Error("Nested exclusive tools require the orchestrating tool to declare concurrency: 'exclusive'"),
				);
			}
			parent.children ??= new ToolExecutionScheduler();
			return parent.children.schedule(mode, run);
		}
		const blockers =
			mode === "exclusive"
				? [...(this.#lastExclusive ? [this.#lastExclusive] : []), ...this.#sharedSinceExclusive]
				: this.#lastExclusive
					? [this.#lastExclusive]
					: [];
		const execute = () => {
			const scope = { mode, active: true };
			return this.#scope.run(scope, async () => {
				try {
					return await run();
				} finally {
					scope.active = false;
				}
			});
		};
		const task = blockers.length === 0 ? invoke(execute) : Promise.all(blockers).then(execute);
		const settled = task.then(
			() => undefined,
			() => undefined,
		);
		if (mode === "exclusive") {
			this.#lastExclusive = settled;
			this.#sharedSinceExclusive.clear();
			void settled.then(() => {
				if (this.#lastExclusive === settled) this.#lastExclusive = undefined;
			});
		} else {
			this.#sharedSinceExclusive.add(settled);
			void settled.then(() => this.#sharedSinceExclusive.delete(settled));
		}
		return task;
	}
}

function invoke<T>(run: () => Promise<T>): Promise<T> {
	try {
		return run();
	} catch (error) {
		return Promise.reject(error);
	}
}

/**
 * Route a tool's executions through a session scheduler according to its declared concurrency. A call whose turn is
 * interrupted before it starts rejects at once and never runs: an earlier call that runs on, such as one that detached
 * from its run, does not hold the interrupted turn (#5486).
 */
export function scheduleToolExecution(
	tool: AgentTool,
	scheduler: ToolExecutionScheduler,
	abortError?: () => Error,
): AgentTool {
	const aborted = (): Error => abortError?.() ?? new Error("Operation aborted");
	return {
		...tool,
		execute: (...args: Parameters<AgentTool["execute"]>) => {
			const signal = args[2];
			let started = false;
			const scheduled = scheduler.schedule(
				resolveToolConcurrency(tool.concurrency, args[1] as Record<string, unknown>),
				() => {
					if (signal?.aborted) throw aborted();
					started = true;
					return tool.execute(...args);
				},
			);
			return signal === undefined || started
				? scheduled
				: startedOrInterrupted(scheduled, signal, () => started, aborted);
		},
	};
}

/**
 * `scheduled`, unless the turn is interrupted while the call still waits for its place: then a rejection at once. The
 * call keeps its place in line and, once it gets there, throws without running, so the order of later calls holds.
 */
function startedOrInterrupted<T>(
	scheduled: Promise<T>,
	signal: AbortSignal,
	started: () => boolean,
	aborted: () => Error,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const interrupt = (): void => {
			if (!started()) reject(aborted());
		};
		if (signal.aborted) interrupt();
		else signal.addEventListener("abort", interrupt, { once: true });
		void scheduled.then(resolve, reject).finally(() => signal.removeEventListener("abort", interrupt));
	});
}
