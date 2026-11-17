import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { getAgentDir, sliceHead } from "@bastani/atomic";
import type { StorageSelection } from "@bastani/atomic/storage";
import { openSelectedRunJournal } from "../durable/journal/resolution.js";
import {
	bootTimeoutDrainHost,
	FLEET_DRAIN_TIMEOUT_MS,
	type FleetFence,
	type FleetSnapshot,
	SqlFleetStore,
} from "../durable/journal/sql-fleet.js";
import { readFleetRateUsage } from "../durable/journal/sql-rate-buckets.js";
import type { RunJournal } from "../durable/journal/types.js";
import {
	type FleetAction,
	type FleetHostView,
	type FleetPlan,
	type FleetPolicy,
	type FleetPolicyState,
	fleetTarget,
	INITIAL_FLEET_STATE,
	planFleet,
	resolveFleetPolicy,
} from "./autoscaler.js";
import { elapsedSince, type Instant, instant } from "./elapsed.js";
import { FleetRateCap, type FleetRateCapEstimate, rateCapReason } from "./fleet-rate-cap.js";
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
/**
 * Listings in a row that must omit a drained instance before its drain is forgotten (#4828): an eventually consistent
 * cloud list, or a provisioner that drops an instance in a state it does not map, can omit a running instance once.
 */
export const DRAIN_CLEAR_MISSED_LISTINGS = 3;
/** Longest error text a fleet event keeps. */
const ERROR_TEXT_MAX = 1_024;

function asFailure(error: unknown): WorkflowFleetFailure {
	const name = error instanceof Error ? error.name : "Error";
	const message = error instanceof Error ? error.message : String(error);
	return { name, message: message.length > ERROR_TEXT_MAX ? `${sliceHead(message, ERROR_TEXT_MAX)}…` : message };
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
	/**
	 * When the lease was last taken or renewed, measured before the request, on both clocks: neither a step back of the
	 * wall clock nor a suspend of the system makes a controller that may have lost its lease act on (#5058).
	 */
	private renewedAt: Instant = { monotonic: 0, wall: 0 };
	/** Listings in a row that omitted each drained instance, by the drained host id (#4828). */
	private missed = new Map<string, number>();
	private readonly rateCap = new FleetRateCap();
	private rateCapEstimate?: FleetRateCapEstimate;
	private rateCapRecorded?: string;
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
		this.backoff = new HostPollBackoff(() => performance.now(), Math.random, {
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
			...(this.role === "active" && this.rateCapEstimate !== undefined
				? { rateCapHosts: this.rateCapEstimate.hosts }
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
		// A timer aborts the tick once the lease may have lapsed, but a controller whose event loop was blocked, whose VM
		// was paused or whose machine slept runs on before any timer fires: it checks the lease's age itself, right before
		// the call, by the longer of the monotonic and wall clocks (#5072).
		if (elapsedSince(this.renewedAt) >= this.leaseMs - this.tickMs)
			this.tickAbort.abort(new Error("The fleet controller may have lost its lease"));
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
		const asked = instant();
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
			this.missed = new Map();
			this.rateCapRecorded = undefined;
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
			this.rateCap.observe(await readFleetRateUsage(this.journal), snapshot.roots);
			const rate = this.rateCap.estimate(this.policy.workersPerHost);
			this.rateCapEstimate = rate;
			await this.followDrains(fence, listed, snapshot);
			const hosts = joinHosts(listed, snapshot);
			const known = new Set(snapshot.hosts.map((host) => host.host));
			const now = performance.now();
			const plan = planFleet(
				this.policy,
				{
					now,
					roots: snapshot.roots,
					hosts: hosts.map((entry) => entry.view),
					...(rate === undefined ? {} : { rateCapHosts: rate.hosts }),
				},
				this.state,
			);
			this.state = plan.state;
			this.plan = plan;
			await this.recordRateCap(fence, plan, rate, fleetTarget(this.policy, snapshot.roots));
			const ready = snapshot.roots.reduce((total, root) => total + (root.blocked ? 0 : root.ready), 0);
			for (const action of plan.actions) {
				this.tickAbort.signal.throwIfAborted();
				await this.act(action, fence, plan, hosts, ready, known);
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

	private async recordRateCap(
		fence: FleetFence,
		plan: FleetPlan,
		rate: FleetRateCapEstimate | undefined,
		wanted: number,
	): Promise<void> {
		const binding = rate !== undefined && wanted > plan.target;
		const key = binding ? `${rate.scope.scope}:${rate.hosts}` : undefined;
		if (key === this.rateCapRecorded) return;
		if (binding)
			await this.store!.record(fence, {
				kind: "rate-cap",
				target: plan.target,
				live: plan.live,
				reason: rateCapReason(rate, wanted),
			});
		else if (this.rateCapRecorded !== undefined)
			await this.store!.record(fence, {
				kind: "rate-cap",
				target: plan.target,
				live: plan.live,
				reason: "the rate limits no longer hold the fleet below what its queue wants",
			});
		this.rateCapRecorded = key;
	}

	/**
	 * A drain lasts as long as its instance (#4803). Once {@link DRAIN_CLEAR_MISSED_LISTINGS} listings in a row omit the
	 * instance, it is forgotten, since a new instance may reuse its id; one listing that omits it is not enough (#4828).
	 * A host the provider lists on a drained instance under another host id is asked to drain too (#4828).
	 */
	private async followDrains(
		fence: FleetFence,
		listed: readonly ProvisionedHost[],
		snapshot: FleetSnapshot,
	): Promise<void> {
		const store = this.store!;
		const missed = new Map<string, number>();
		for (const drain of snapshot.drains) {
			if (listed.some((provided) => provided.id === drain.providerId)) continue;
			const times = (this.missed.get(drain.host) ?? 0) + 1;
			if (times >= DRAIN_CLEAR_MISSED_LISTINGS) await store.clearDrain(fence, drain.host);
			else missed.set(drain.host, times);
		}
		this.missed = missed;
		for (const provided of listed)
			if (
				provided.hostId !== undefined &&
				snapshot.drains.some((drain) => drain.providerId === provided.id) &&
				!snapshot.drains.some((drain) => drain.host === provided.hostId)
			)
				await store.carryDrain(fence, provided.hostId, provided.id);
	}

	/**
	 * Renews the lease every `tickMs` while a tick acts, which a provider call can take longer than the lease. Aborts
	 * `tick` once another controller holds the lease, or once the lease may have expired because renewals failed: from
	 * then on this controller makes no provider call, so two controllers never act on the fleet at once.
	 */
	private keepLeading(fence: FleetFence, tick: AbortController): NodeJS.Timeout {
		const timer = setInterval(() => {
			if (elapsedSince(this.renewedAt) >= this.leaseMs - this.tickMs) {
				tick.abort(new Error("The fleet controller may have lost its lease"));
				return;
			}
			const asked = instant();
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
		const rate = this.rateCapEstimate;
		const plan = planFleet(
			{ ...this.policy, idleDrainMs: 0 },
			{
				now: performance.now(),
				roots: snapshot.roots,
				hosts: hosts.map((entry) => entry.view),
				...(rate === undefined ? {} : { rateCapHosts: rate.hosts }),
			},
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
		/** The registry hosts of the snapshot the plan was made from. */
		known: ReadonlySet<string> = new Set(),
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
				if (action.reason === "boot-timeout") {
					// The instance is drained before it is checked once more and removed, so a host that registers on it from
					// now on claims nothing. One that registered since the snapshot, reports, or holds a child booted after
					// all, and stays. One that already read the drain finishes it: the planner removes the instance once that
					// host leaves (#5072). The drain that names the removal comes first: once it is written, a removal cut off
					// before its provider call, by a lease that may have lapsed or by a stop, is finished by whichever
					// controller leads next, as {@link joinHosts} says.
					const drained = [
						bootTimeoutDrainHost(action.id),
						...(joined?.hostId === undefined ? [] : [joined.hostId]),
					];
					for (const host of drained) await store.carryDrain(fence, host, action.id);
					const hold = await store.bootHold(action.id, joined?.hostId, known);
					if (hold === "occupied") for (const host of drained) await store.clearDrain(fence, host);
					if (hold !== "free") return;
				}
				// Its drains stay until the provider no longer lists it (#4803): a removal the provider accepted may take
				// minutes, and a worker that restarts on the instance meanwhile must not take children.
				await this.call((signal) => this.options.provisioner.drain(action.id, signal));
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
 * reports (`ATOMIC_PROVIDER_ID`), or whose `hostId` the provider gives. A worker that restarted on the same instance
 * registered again under a new host id (#4803): the live one is its host, and the instance holds the children of all.
 * A worker without a provider id that restarted under a host id the provider does not list matches no instance
 * (#4828): its children count on every drained instance that has no live host, so none it may run on is removed. That
 * holds however long ago it last reported (#5072): a host that stalled still holds its leases until they expire.
 *
 * A drained instance has `drained` once no host on it is in the registry, since a host leaves the registry when its
 * drain ends, or {@link FLEET_DRAIN_TIMEOUT_MS} after its latest drain request: a host that only stopped reporting has
 * not drained (#5072). An instance drained for its boot timeout has `drained` too once no host on it is live or
 * draining, as the removal's own check would find it free: a removal cut off after it wrote the drain is then finished
 * at the next tick, by this controller or the one that takes over, not after the drain timeout.
 */
export function joinHosts(listed: readonly ProvisionedHost[], snapshot: FleetSnapshot): JoinedHost[] {
	let unclaimed = 0;
	for (const [holder, count] of snapshot.leased) {
		const registered = snapshot.hosts.find((host) => host.host === holder);
		if (registered?.providerId === undefined && !listed.some((provided) => provided.hostId === holder))
			unclaimed += count;
	}
	return listed.map((provided) => {
		const matching = snapshot.hosts.filter(
			(host) => host.providerId === provided.id || (provided.hostId !== undefined && host.host === provided.hostId),
		);
		const registered = matching.find((host) => host.live) ?? matching[0];
		const hostId = registered?.host ?? provided.hostId;
		const holders = new Set(matching.map((host) => host.host));
		if (hostId !== undefined) holders.add(hostId);
		const drainHosts = snapshot.drains
			.filter((drain) => drain.providerId === provided.id || (hostId !== undefined && drain.host === hostId))
			.map((drain) => drain.host);
		const drains = snapshot.drains.filter((drain) => drainHosts.includes(drain.host));
		const orphaned = drainHosts.length > 0 && registered?.live !== true ? unclaimed : 0;
		const left = !snapshot.hosts.some((host) => holders.has(host.host));
		const timedOut = drains.length > 0 && Math.min(...drains.map((drain) => drain.agoMs)) >= FLEET_DRAIN_TIMEOUT_MS;
		const bootTimedOut =
			drainHosts.includes(bootTimeoutDrainHost(provided.id)) &&
			matching.every((host) => !host.live && host.draining !== true);
		const leased = [...holders].reduce((total, host) => total + (snapshot.leased.get(host) ?? 0), orphaned);
		return {
			view: {
				id: provided.id,
				state: provided.state,
				since: provided.since,
				registered: registered?.live === true,
				leased,
				draining: drainHosts.length > 0,
				drained: (drainHosts.length > 0 || provided.state === "draining") && (left || timedOut || bootTimedOut),
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
