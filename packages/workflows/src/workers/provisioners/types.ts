/**
 * The options of the command provisioner (#4768), with no runtime dependencies: the SDK's authoring surface imports
 * them. None of them holds a credential: each command uses its own tool's login or environment.
 */

/** A host state, as `list` reports it. */
export type CommandHostState = "pending" | "running" | "draining" | "stopped" | "failed";

/** One command, an executable and its arguments, or several run in order. */
export type CommandSteps = readonly string[] | readonly (readonly string[])[];

/**
 * How to read the JSON the `list` command prints. Paths are dot-separated property names and array indexes, such as
 * `AutoScalingGroups.0.Instances` or `metadata.name`.
 */
export interface CommandListFormat {
	/** Where the array of hosts is. Default: the whole output. */
	readonly items?: string;
	/** Each host's id, a string or a number. Default `id`. */
	readonly id?: string;
	/** Each host's state. Default `state`. */
	readonly state?: string;
	/** When the host entered its state: milliseconds or an ISO 8601 time. Default `since`. */
	readonly since?: string;
	/** The Atomic worker host id, when the provider knows it. Default `hostId`. */
	readonly hostId?: string;
	/**
	 * The provider's states as host states. `null` leaves a host out of the list, for hosts the provider no longer
	 * counts, such as one being deleted. `"*"` covers every other state. Without `states`, each host's state must
	 * already be a host state.
	 */
	readonly states?: Readonly<Record<string, CommandHostState | null>>;
}

/**
 * Three commands of your own, or a preset for a cloud's CLI, each run without a shell. Arguments may hold
 * placeholders, which are also set as environment variables:
 *
 * - `up` adds hosts: `{target}` (`ATOMIC_TARGET`) is the count to reach, `{add}` (`ATOMIC_ADD`) how many that adds. It
 *   runs only when `list` reports fewer than `target` hosts, and with `upEach`, once for each host to add.
 * - `down` removes the host `{id}` (`ATOMIC_PROVIDER_ID`); `{remaining}` (`ATOMIC_REMAINING`) is the count `list`
 *   reported, less one. It runs only for a host `list` reports and that is not draining already.
 * - `list` prints the hosts as JSON, read as `listFormat` says. Several list commands report their hosts together, a
 *   host two of them report counting once.
 *
 * Default `timeoutMs`, for each command: 120000.
 */
export interface CommandProvisionerOptions {
	readonly kind: "command";
	readonly up: CommandSteps;
	readonly upEach?: boolean;
	readonly down: CommandSteps;
	readonly list: CommandSteps;
	readonly listFormat?: CommandListFormat;
	/** How long, in milliseconds, one command may run before it is stopped and counted as a failure. */
	readonly timeoutMs?: number;
}

export type WorkerHostProvisionerConfig = CommandProvisionerOptions;

/**
 * Why a provisioner's command failed: `missing-cli` (not installed or not on `PATH`), `auth` (credentials refused),
 * `exit` (any other non-zero exit), `timeout`, or `malformed` (output that is not what was expected).
 */
export type WorkerProvisionerErrorCode = "missing-cli" | "auth" | "exit" | "timeout" | "malformed";
