import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { getAgentDir } from "@bastani/atomic";
import type { StorageSelection } from "@bastani/atomic/storage";
import { openSelectedRunJournal } from "../durable/journal/resolution.js";
import { type FleetFence, type FleetSnapshot, SqlFleetStore } from "../durable/journal/sql-fleet.js";
import type { RunJournal } from "../durable/journal/types.js";
import {
	type FleetAction,
	type FleetHostView,
	type FleetPlan,
	type FleetPolicy,
	type FleetPolicyState,
	INITIAL_FLEET_STATE,
	planFleet,
	resolveFleetPolicy,
} from "./autoscaler.js";
import type {
	ProvisionedHost,
	WorkerHostProvisioner,
	WorkflowFleetController,
	WorkflowFleetControllerOptions,
	WorkflowFleetEvent,
	WorkflowFleetFailure,
	WorkflowFleetOptions,
	WorkflowFleetStatus,
} from "./fleet-types.js";
import { HostPollBackoff } from "./host-poll-backoff.js";
import { SharedPoolSetupError, WorkerPlacementConfigError } from "./placement-errors.js";
import { sharedJournalSelection, sharedSelectionProblems } from "./shared-setup.js";

export type {
	ProvisionedHost,
	WorkerFleetPolicyOptions,
	WorkerHostProvisioner,
	WorkflowFleetController,
	WorkflowFleetControllerOptions,
	WorkflowFleetEvent,
	WorkflowFleetFailure,
	WorkflowFleetOptions,
	WorkflowFleetStatus,
} from "./fleet-types.js";

/** How often a fleet controller ticks, unless `tickMs` says otherwise: Buildkite's scaler polls about this often. */
export const DEFAULT_FLEET_TICK_MS = 10_000;
/** The longest one provisioner call may take before it is aborted and counted as a failure. */
const PROVIDER_CALL_TIMEOUT_MS = 120_000;
/** The longest a controller waits after provisioner failures in a row before it tries again. */
const PROVIDER_BACKOFF_MAX_MS = 600_000;
/** The longest the last pass of a stopping root's controller may take. */
const FINAL_PASS_TIMEOUT_MS = 10_000;
/** Longest error text a fleet event keeps. */
const ERROR_TEXT_MAX = 1_024;

function asFailure(error: unknown): WorkflowFleetFailure {
	const name = error instanceof Error ? error.name : "Error";
	const message = error instanceof Error ? error.message : String(error);
	return { name, message: message.length > ERROR_TEXT_MAX ? `${message.slice(0, ERROR_TEXT_MAX)}…` : message };
}

/** A failure as a fleet event records it, for operators to read: `name: message`. */
function eventErrorText(failure: WorkflowFleetFailure): string {
	return `${failure.name}: ${failure.message}`;
}

/** `promise`, or `signal`'s reason once it aborts first: a provider that ignores its signal never holds the controller. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** `options` checked: a provisioner with its three methods, a positive `tickMs`, and the policy's knobs. */
export function checkFleetOptions(options: WorkflowFleetOptions): {
	readonly policy: FleetPolicy;
	readonly tickMs: number;
} {
	const provisioner = options.provisioner as Partial<WorkerHostProvisioner> | undefined;
	if (
		typeof provisioner !== "object" ||
		provisioner === null ||
		typeof provisioner.kind !== "string" ||
		typeof provisioner.list !== "function" ||
		typeof provisioner.scaleTo !== "function" ||
		typeof provisioner.drain !== "function"
	)
		throw new WorkerPlacementConfigError(
			"sdk",
			"provisioner.provisioner",
			"invalid-option",
			"a WorkerHostProvisioner: a kind, and list, scaleTo and drain methods",
		);
	const tickMs = options.tickMs ?? DEFAULT_FLEET_TICK_MS;
	if (!Number.isSafeInteger(tickMs) || tickMs < 1)
		throw new WorkerPlacementConfigError("sdk", "provisioner.tickMs", "invalid-option", "must be a positive integer");
	return { policy: resolveFleetPolicy(options), tickMs };
}

/**
 * Reconciles a fleet of worker hosts with the shared journal's queues (#4768). It ticks every `tickMs`: it takes or
 * renews the journal's controller lease, and only while it holds it lists the provider's hosts, plans with
 * {@link planFleet}, and acts. Every write it makes to the journal is fenced by the lease epoch, so a controller that
 * lost the lease writes nothing. A provisioner or journal failure is recorded, reported and retried with a backoff; it
 * never throws to its owner.
 */
export class FleetController implements WorkflowFleetController {
	readonly holder = `${hostname()}/${process.pid}/${randomUUID().slice(0, 8)}`;
	private readonly policy: FleetPolicy;
	private readonly tickMs: number;
	private readonly leaseMs: number;
	private readonly abort = new AbortController();
	private readonly backoff: HostPollBackoff;
	private store?: SqlFleetStore;
	private epoch?: number;
	private role: WorkflowFleetStatus["role"] = "starting";
	private state: FleetPolicyState = INITIAL_FLEET_STATE;
	private plan?: FleetPlan;
	private degraded?: NonNullable<WorkflowFleetStatus["degraded"]>;
	private timer?: NodeJS.Timeout;
	private ticking?: Promise<void>;
	/** Aborted when the running tick must stop acting: the lease was lost or may have expired, or the controller stops. */
	private tickAbort = new AbortController();
	/** When, by `Date.now()`, the lease was last taken or renewed, measured before the request. */
	private renewedAt = 0;
	private stopping?: Promise<void>;
	private settleClosed!: () => void;
	readonly closed = new Promise<void>((resolve) => {
		this.settleClosed = resolve;
	});

	constructor(
		private readonly journal: RunJournal,
		private readonly options: WorkflowFleetOptions & {
			readonly onEvent?: (event: WorkflowFleetEvent) => void;
			/** Lets the process exit while only the controller runs, for a controller inside a root. */
			readonly unref?: boolean;
			/** Called once it stopped, such as to close a journal it opened. */
			readonly onClose?: () => Promise<void>;
			/**
			 * When it stops while active, asks every idle host above the target to drain at once, so a root that runs the
			 * only controller does not leave its idle hosts serving after it ends.
			 */
			readonly drainIdleOnStop?: boolean;
		},
	) {
		const checked = checkFleetOptions(options);
		this.policy = checked.policy;
		this.tickMs = checked.tickMs;
		this.leaseMs = 3 * this.tickMs;
		this.backoff = new HostPollBackoff(() => Date.now(), Math.random, {
			firstMs: this.tickMs,
			maxMs: PROVIDER_BACKOFF_MAX_MS,
		});
		this.schedule(0);
	}

	private schedule(delayMs: number): void {
		if (this.stopping !== undefined) return;
		this.timer = setTimeout(() => {
			this.ticking = this.tick().finally(() => {
				this.ticking = undefined;
				this.schedule(this.tickMs);
			});
		}, delayMs);
		if (this.options.unref === true) this.timer.unref();
	}

	private emit(event: WorkflowFleetEvent): void {
		try {
			this.options.onEvent?.(event);
		} catch {
			// A listener's failure is its own.
		}
	}

	status(): WorkflowFleetStatus {
		return {
			role: this.role,
			holder: this.holder,
			provisioner: this.options.provisioner.kind,
			...(this.role === "active" && this.epoch !== undefined ? { epoch: this.epoch } : {}),
			...(this.role === "active" && this.plan !== undefined
				? { target: this.plan.target, live: this.plan.live, pending: this.plan.pending }
				: {}),
			...(this.degraded === undefined ? {} : { degraded: this.degraded }),
		};
	}

	private fail(error: unknown): void {
		const { failures, retryInMs } = this.backoff.failed();
		const failure = asFailure(error);
		this.degraded = { failures, since: this.degraded?.since ?? Date.now(), error: failure };
		this.emit({ kind: "degraded", failures, retryInMs, error: failure });
	}

	private succeeded(): void {
		const failures = this.backoff.succeeded();
		if (failures === 0) return;
		this.degraded = undefined;
		this.emit({ kind: "recovered", failures });
	}

	/**
	 * One provisioner call, aborted when the controller stops, the tick lost its lease, or the call takes too long. An
	 * abort stops the controller acting on the call; a request the provider already received may still complete.
	 */
	private call<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		this.tickAbort.signal.throwIfAborted();
		const signal = AbortSignal.any([
			this.abort.signal,
			this.tickAbort.signal,
			AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
		]);
		return untilAborted(
			Promise.resolve().then(() => run(signal)),
			signal,
		);
	}

	/** Takes or renews the lease; returns the fence while this controller holds it. */
	private async lead(): Promise<FleetFence | undefined> {
		this.store ??= await SqlFleetStore.open(this.journal);
		const asked = Date.now();
		const lease = await this.store.acquire(this.holder, this.epoch, this.leaseMs);
		if (lease.held) this.renewedAt = asked;
		if (!lease.held) {
			if (this.role !== "standby") this.emit({ kind: "standby", holder: lease.holder });
			this.role = "standby";
			this.epoch = undefined;
			this.plan = undefined;
			return undefined;
		}
		const fence = { holder: this.holder, epoch: lease.epoch };
		if (this.epoch !== lease.epoch) {
			// A controller that takes over plans afresh: the last holder's idle and boot timers were its own.
			this.state = INITIAL_FLEET_STATE;
			this.epoch = lease.epoch;
			this.role = "active";
			this.emit({ kind: "active", epoch: lease.epoch });
			await this.store.record(fence, { kind: "active", reason: `${this.holder} took the controller lease` });
		}
		return fence;
	}

	private async tick(): Promise<void> {
		let fence: FleetFence | undefined;
		try {
			fence = await this.lead();
		} catch (error) {
			// The journal is unreachable: nothing to act on; the lease is retried next tick.
			this.fail(error);
			return;
		}
		if (fence === undefined || !this.backoff.due() || this.stopping !== undefined) return;
		const store = this.store!;
		this.tickAbort = new AbortController();
		const renewal = this.keepLeading(fence, this.tickAbort);
		try {
			const listed = await this.call((signal) => this.options.provisioner.list(signal));
			const snapshot = await store.snapshot();
			const hosts = joinHosts(listed, snapshot);
			const now = Date.now();
			const plan = planFleet(
				this.policy,
				{ now, roots: snapshot.roots, hosts: hosts.map((entry) => entry.view) },
				this.state,
			);
			this.state = plan.state;
			this.plan = plan;
			const ready = snapshot.roots.reduce((total, root) => total + (root.blocked ? 0 : root.ready), 0);
			for (const action of plan.actions) {
				this.tickAbort.signal.throwIfAborted();
				await this.act(action, fence, plan, hosts, ready);
			}
			this.succeeded();
		} catch (error) {
			// A tick that lost its lease or was stopped acts no further; the next tick finds out which.
			if (this.stopping !== undefined || this.tickAbort.signal.aborted) return;
			const failure = asFailure(error);
			await store
				.record(fence, {
					kind: "error",
					...(this.plan === undefined ? {} : { target: this.plan.target, live: this.plan.live }),
					reason: `${this.options.provisioner.kind} provisioner or journal call failed`,
					error: eventErrorText(failure),
				})
				.catch(() => {});
			this.fail(error);
		} finally {
			clearInterval(renewal);
		}
	}

	/**
	 * Renews the lease every `tickMs` while a tick acts, which a provider call can take longer than the lease. Aborts
	 * `tick` once another controller holds the lease, or once the lease may have expired because renewals failed: from
	 * then on this controller makes no provider call, so two controllers never act on the fleet at once.
	 */
	private keepLeading(fence: FleetFence, tick: AbortController): NodeJS.Timeout {
		const timer = setInterval(() => {
			if (Date.now() - this.renewedAt >= this.leaseMs - this.tickMs) {
				tick.abort(new Error("The fleet controller may have lost its lease"));
				return;
			}
			const asked = Date.now();
			void this.store!.acquire(this.holder, fence.epoch, this.leaseMs).then(
				(lease) => {
					if (lease.held && lease.epoch === fence.epoch) this.renewedAt = asked;
					else tick.abort(new Error("The fleet controller lost its lease"));
				},
				() => {
					// A renewal that failed is retried at the next interval, until the lease may have expired.
				},
			);
		}, this.tickMs);
		timer.unref();
		return timer;
	}

	/**
	 * The last pass of a stopping root's controller: every idle host above the fleet's target, by the queues as they are
	 * now, is asked to drain at once, whatever `idleDrainMs` says. Hosts that hold work are left serving.
	 */
	private async drainIdle(fence: FleetFence, signal: AbortSignal): Promise<void> {
		const store = this.store!;
		const listed = await untilAborted(
			Promise.resolve().then(() => this.options.provisioner.list(signal)),
			signal,
		);
		const snapshot = await store.snapshot();
		const hosts = joinHosts(listed, snapshot);
		const plan = planFleet(
			{ ...this.policy, idleDrainMs: 0 },
			{ now: Date.now(), roots: snapshot.roots, hosts: hosts.map((entry) => entry.view) },
			this.state,
		);
		for (const action of plan.actions)
			if (action.kind === "mark-draining" && !signal.aborted) await this.act(action, fence, plan, hosts, 0);
	}

	private async act(
		action: FleetAction,
		fence: FleetFence,
		plan: FleetPlan,
		hosts: readonly JoinedHost[],
		ready: number,
	): Promise<void> {
		const store = this.store!;
		const joined = action.kind === "scale-up" ? undefined : hosts.find((entry) => entry.view.id === action.id);
		switch (action.kind) {
			case "scale-up":
				await this.call((signal) => this.options.provisioner.scaleTo(action.desired, signal));
				this.emit({ kind: "scale-up", target: action.target, desired: action.desired, live: plan.live });
				await store.record(fence, {
					kind: "scale-up",
					target: action.target,
					live: plan.live,
					reason: `${ready} ready, ${plan.live} live and ${plan.pending} pending hosts: scaleTo(${action.desired})`,
				});
				return;
			case "mark-draining": {
				const host = joined?.hostId;
				if (host === undefined || !(await store.requestDrain(fence, host, action.id))) return;
				this.emit({ kind: "drain-requested", id: action.id, host });
				await store.record(fence, {
					kind: "drain",
					target: plan.target,
					live: plan.live,
					reason: `${action.id} (${host}) idle, above the target of ${plan.target}`,
				});
				return;
			}
			case "remove":
				await this.call((signal) => this.options.provisioner.drain(action.id, signal));
				for (const host of joined?.drainHosts ?? []) await store.clearDrain(fence, host);
				this.emit({ kind: "removed", id: action.id, reason: action.reason });
				await store.record(fence, {
					kind: "remove",
					target: plan.target,
					live: plan.live,
					reason: `${action.id}: ${action.reason}`,
				});
				return;
		}
	}

	stop(): Promise<void> {
		this.stopping ??= (async () => {
			clearTimeout(this.timer);
			this.tickAbort.abort(new Error("The fleet controller stopped"));
			await this.ticking;
			const epoch = this.epoch;
			if (this.options.drainIdleOnStop === true && this.store !== undefined && epoch !== undefined) {
				// The whole pass, its journal reads and writes included, is bounded: a root's close never waits on it longer.
				const deadline = AbortSignal.timeout(FINAL_PASS_TIMEOUT_MS);
				await untilAborted(this.drainIdle({ holder: this.holder, epoch }, deadline), deadline).catch(() => {});
			}
			this.abort.abort(new Error("The fleet controller stopped"));
			if (this.store !== undefined && epoch !== undefined)
				await this.store.release({ holder: this.holder, epoch }).catch(() => {});
			this.role = "stopped";
			await this.options.onClose?.().catch(() => {});
			this.settleClosed();
		})();
		return this.stopping;
	}
}

export interface JoinedHost {
	readonly view: FleetHostView;
	/** The worker host id it registered with, when known. */
	readonly hostId?: string;
	/** The drain requests that name it. */
	readonly drainHosts: readonly string[];
}

/**
 * The provider's hosts joined with the journal's registry: a registered host matches the provider host whose id it
 * reports (`ATOMIC_WORKER_PROVIDER_ID`), or whose `hostId` the provider gives.
 */
export function joinHosts(listed: readonly ProvisionedHost[], snapshot: FleetSnapshot): JoinedHost[] {
	return listed.map((provided) => {
		const registered = snapshot.hosts.find(
			(host) => host.providerId === provided.id || (provided.hostId !== undefined && host.host === provided.hostId),
		);
		const hostId = registered?.host ?? provided.hostId;
		const drainHosts = snapshot.drains
			.filter((drain) => drain.providerId === provided.id || (hostId !== undefined && drain.host === hostId))
			.map((drain) => drain.host);
		return {
			view: {
				id: provided.id,
				state: provided.state,
				since: provided.since,
				registered: registered?.live === true,
				leased: hostId === undefined ? 0 : (snapshot.leased.get(hostId) ?? 0),
				draining: drainHosts.length > 0,
			},
			...(hostId === undefined ? {} : { hostId }),
			drainHosts,
		};
	});
}

/**
 * Starts a fleet controller on a shared journal (#4768): it adds worker hosts through `provisioner` when the queues of
 * the journal's shared roots grow, and drains and removes hosts that sat idle. Run one per fleet, on any machine that
 * opens the journal, or several: one is active at a time, through the journal's controller lease, and another takes
 * over when it stops. The journal's setup is checked as `startWorkflowWorkerHost` checks it.
 */
export async function startWorkflowFleetController(
	options: WorkflowFleetControllerOptions,
): Promise<WorkflowFleetController> {
	checkFleetOptions(options);
	const agentDir = options.agentDir ?? getAgentDir();
	const selection = sharedJournalSelection(options.journal, { agentDir });
	const [first, ...rest] = await sharedSelectionProblems(selection, agentDir);
	if (first !== undefined) throw new SharedPoolSetupError("worker-host", [first, ...rest]);
	const journal = await openSelectedRunJournal(selection as Extract<StorageSelection, { kind: "adapter" }>, agentDir);
	return new FleetController(journal, { ...options, onClose: () => journal.close() });
}
