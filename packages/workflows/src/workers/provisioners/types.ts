/**
 * The options of the built-in worker host provisioners (#4768), with no runtime dependencies: the SDK's authoring
 * surface imports them. None of them holds a credential: each provisioner's CLI uses its own login or environment.
 */

interface ProvisionerCallOptions {
	/** How long, in milliseconds, one CLI call may run before it is stopped and counted as a failure. */
	readonly timeoutMs?: number;
}

/**
 * An Azure Virtual Machine Scale Set whose instances start `atomic worker start`, driven through `az vmss`. A host's
 * provider id is its instance id. Default `timeoutMs`: 60000.
 */
export interface AzureVmssProvisionerOptions extends ProvisionerCallOptions {
	readonly kind: "azure-vmss";
	readonly resourceGroup: string;
	/** The scale set's name. */
	readonly name: string;
	/** The subscription's id or name. Default: the one `az account show` selects. */
	readonly subscription?: string;
}

/**
 * A Kubernetes Deployment or StatefulSet of `atomic worker start` pods, driven through `kubectl`. A host's provider id
 * is its pod name. Give exactly one of `deployment` and `statefulSet`. Default `timeoutMs`: 30000.
 */
export interface KubernetesProvisionerOptions extends ProvisionerCallOptions {
	readonly kind: "kubernetes";
	readonly namespace: string;
	readonly deployment?: string;
	/** A StatefulSet removes only its highest-numbered pod, so only that pod is removed once it drained. */
	readonly statefulSet?: string;
	/** The label selector of the workload's pods, such as `app=atomic-worker`. */
	readonly selector: string;
	/** The kubeconfig context. Default: the current one. */
	readonly context?: string;
}

/**
 * Three commands of your own, each an executable and its arguments, run without a shell. `up` makes the count of hosts
 * the value of `ATOMIC_TARGET`; `down` removes the host whose id is `ATOMIC_PROVIDER_ID`, and must succeed for an id
 * that is already gone; `list` prints a JSON array of `{ id, state, since?, hostId? }`. Default `timeoutMs`: 120000.
 */
export interface CommandProvisionerOptions extends ProvisionerCallOptions {
	readonly kind: "command";
	readonly up: readonly string[];
	readonly down: readonly string[];
	readonly list: readonly string[];
}

export type WorkerHostProvisionerConfig =
	| AzureVmssProvisionerOptions
	| KubernetesProvisionerOptions
	| CommandProvisionerOptions;

/**
 * Why a provisioner's CLI call failed: `missing-cli` (not installed or not on `PATH`), `auth` (credentials refused),
 * `exit` (any other non-zero exit), `timeout`, or `malformed` (output that is not what the CLI documents).
 */
export type WorkerProvisionerErrorCode = "missing-cli" | "auth" | "exit" | "timeout" | "malformed";
