/**
 * The public types of fleet autoscaling (#4768), with no runtime dependencies: the SDK's authoring surface imports them.
 */

import type { SharedJournalSelection } from "./worker-host-types.js";

/** A host as its provider reports it. */
export interface ProvisionedHost {
	/** The provider's id of the host: a VM instance id, a pod name, or whatever a custom provider uses. */
	readonly id: string;
	/**
	 * The Atomic worker host id it registered with, when the provider knows it. A host started with the environment
	 * variable `ATOMIC_WORKER_PROVIDER_ID` set to `id` registers it itself, which is the usual way to match the two.
	 */
	readonly hostId?: string;
	readonly state: "pending" | "running" | "draining" | "stopped" | "failed";
	/** When the host entered `state`, by `Date.now()`. */
	readonly since: number;
}

/**
 * What a fleet controller needs from a cloud, a cluster or a script to add and remove worker hosts (#4768). Each method
 * takes an `AbortSignal` that fires when the controller stops or the call took too long; a call that rejects is recorded
 * and retried after a backoff, and never fails or blocks a workflow run. Credentials stay in the provider's own chain:
 * nothing a provider is given or returns is written to the journal except host ids, states and error messages, so
 * error messages must not carry secrets.
 */
export interface WorkerHostProvisioner {
	/** What the provider is, for status and events: `"azure-vmss"`, `"kubernetes"`, `"command"`, or a custom name. */
	readonly kind: string;
	/** Every host this provider manages, in any state. Returns an empty list, never rejects, when there is none. */
	list(signal: AbortSignal): Promise<readonly ProvisionedHost[]>;
	/**
	 * Makes the number of hosts the provider runs `target`, counting every host `list` reports that `drain` has not
	 * removed, draining ones included. Idempotent, and may return before the new hosts boot. The controller calls it only
	 * to add hosts, never with fewer than the hosts it runs, so a provider never chooses a host to remove itself.
	 */
	scaleTo(target: number, signal: AbortSignal): Promise<void>;
	/**
	 * Removes one host, which already drained or never registered, and lowers the provider's count by one. Idempotent:
	 * an unknown or already removed id is a no-op.
	 */
	drain(id: string, signal: AbortSignal): Promise<void>;
}

/** The knobs of a fleet's policy, as an SDK caller or `atomic worker controller` gives them. Every field is optional. */
export interface WorkerFleetPolicyOptions {
	/** Hosts the fleet keeps however idle it is. Default 0. */
	readonly minHosts?: number;
	/** Hosts the fleet never exceeds, however deep the queue. Default 10. */
	readonly maxHosts?: number;
	/** Children one host runs at once: the `--slots` its hosts start with. Default 4. */
	readonly workersPerHost?: number;
	/** Ready children the fleet tolerates waiting before it adds hosts. Default: `workersPerHost`. */
	readonly scaleUpQueueDepth?: number;
	/** How long, in milliseconds, the queue must stay deeper than `scaleUpQueueDepth` before hosts are added. Default 20000. */
	readonly scaleUpDelayMs?: number;
	/** How long, in milliseconds, a host must hold no child before it is drained and removed. Default 300000. */
	readonly idleDrainMs?: number;
	/** How long, in milliseconds, a new host may take to register before it is removed and replaced. Default 600000. */
	readonly bootTimeoutMs?: number;
}

/** A fleet's provisioner and its policy: what `workers.provisioner` and `startWorkflowFleetController` take (#4768). */
export interface WorkflowFleetOptions extends WorkerFleetPolicyOptions {
	readonly provisioner: WorkerHostProvisioner;
	/** How often, in milliseconds, the controller looks at the queues and the provider. Default 10000. */
	readonly tickMs?: number;
}

/** A failure the controller recorded instead of throwing. */
export interface WorkflowFleetFailure {
	readonly name: string;
	readonly message: string;
}

/**
 * What a fleet controller reports as it happens (#4768). `active` and `standby` follow the controller lease: one
 * controller of a journal is active at a time, and a standby one takes over once the active one stops renewing it.
 * `scale-up`, `drain-requested` and `removed` are its decisions. `degraded` is a provisioner or journal call that
 * failed: the fleet keeps its hosts, and the controller tries again after `retryInMs`; `recovered` follows the first
 * tick that succeeded after it.
 */
export type WorkflowFleetEvent =
	| { readonly kind: "active"; readonly epoch: number }
	| { readonly kind: "standby"; readonly holder: string }
	| { readonly kind: "scale-up"; readonly target: number; readonly desired: number; readonly live: number }
	| { readonly kind: "drain-requested"; readonly id: string; readonly host: string }
	| { readonly kind: "removed"; readonly id: string; readonly reason: string }
	| {
			readonly kind: "degraded";
			readonly failures: number;
			readonly retryInMs: number;
			readonly error: WorkflowFleetFailure;
	  }
	| { readonly kind: "recovered"; readonly failures: number };

export interface WorkflowFleetStatus {
	/** `active` while it holds the controller lease, `standby` while another controller does. */
	readonly role: "starting" | "active" | "standby" | "stopped";
	/** This controller's lease holder id. */
	readonly holder: string;
	readonly provisioner: string;
	/** The lease epoch it holds while active. */
	readonly epoch?: number;
	/** The last tick's plan, while active. */
	readonly target?: number;
	readonly live?: number;
	readonly pending?: number;
	/** Set while its provisioner or journal calls fail. */
	readonly degraded?: { readonly failures: number; readonly since: number; readonly error: WorkflowFleetFailure };
}

export interface WorkflowFleetController {
	readonly holder: string;
	status(): WorkflowFleetStatus;
	/** Stops ticking, gives the controller lease up so another controller takes over at once, and closes. */
	stop(): Promise<void>;
	/** Settles once the controller stopped. Never rejects. */
	readonly closed: Promise<void>;
}

export interface WorkflowFleetControllerOptions extends WorkflowFleetOptions {
	/** The shared journal. Default: the journal this machine selects for workflow runs. */
	readonly journal?: SharedJournalSelection;
	readonly agentDir?: string;
	readonly onEvent?: (event: WorkflowFleetEvent) => void;
}
