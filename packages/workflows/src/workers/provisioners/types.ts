/**
 * The options of the command provisioner (#4768), with no runtime dependencies: the SDK's authoring surface imports
 * them. None of them holds a credential: each command uses its own tool's login or environment, or short-lived tokens
 * Atomic mints for it from a GitHub App whose private key stays in a file.
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
/**
 * A GitHub App the provisioner mints installation tokens from, for `gh`: each token is narrowed to `actions: write` on
 * `repository`, reused until 5 minutes before it expires, and passed to each command as `GH_TOKEN` (for GitHub Enterprise
 * Server, `GH_ENTERPRISE_TOKEN` with `GH_HOST`). Each option this object leaves out is read from its environment
 * variable: `ATOMIC_GITHUB_APP_ID`, `ATOMIC_GITHUB_APP_INSTALLATION_ID`, `ATOMIC_GITHUB_APP_PRIVATE_KEY_FILE`,
 * `ATOMIC_GITHUB_APP_REPOSITORY`, `ATOMIC_GITHUB_HOST` and `ATOMIC_GITHUB_API_URL`.
 */
export interface GitHubAppAuthOptions {
	/** The app's client ID or app ID. */
	readonly appId?: string | number;
	readonly installationId?: string | number;
	/** The app's PEM private key, in a file only its owner can read (mode 600 or 400). Its content is never logged. */
	readonly privateKeyFile?: string;
	/** `owner/name`: the one repository the tokens may dispatch and cancel workflow runs in. */
	readonly repository?: string;
	/** The GitHub host `gh` talks to. Default `github.com`. */
	readonly host?: string;
	/**
	 * The REST API base URL. Default: `https://api.github.com` for github.com, `https://api.<host>` for a GHE.com host, and
	 * `https://<host>/api/v3` for GitHub Enterprise Server.
	 */
	readonly apiUrl?: string;
}

/** Credentials the provisioner mints for its commands. */
export interface CommandProvisionerAuth {
	readonly githubApp: GitHubAppAuthOptions;
}

export interface CommandProvisionerOptions {
	readonly kind: "command";
	readonly up: CommandSteps;
	readonly upEach?: boolean;
	readonly down: CommandSteps;
	readonly list: CommandSteps;
	readonly listFormat?: CommandListFormat;
	/** How long, in milliseconds, one command may run before it is stopped and counted as a failure. */
	readonly timeoutMs?: number;
	/** Credentials to mint for the commands; without it, each command uses its own tool's login. */
	readonly auth?: CommandProvisionerAuth;
}

export type WorkerHostProvisionerConfig = CommandProvisionerOptions;

/**
 * Why a provisioner's command failed: `missing-cli` (not installed or not on `PATH`), `auth` (credentials refused),
 * `exit` (any other non-zero exit), `timeout`, `malformed` (output that is not what was expected), or `unavailable` (the
 * service that mints its credentials could not be reached, or failed).
 */
export type WorkerProvisionerErrorCode = "missing-cli" | "auth" | "exit" | "timeout" | "malformed" | "unavailable";
