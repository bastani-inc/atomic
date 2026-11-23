// @ts-check
import { createRequire } from "node:module";
import { join } from "node:path";
import { redactSecrets, StorageConfigError } from "@bastani/atomic/storage";

/**
 * @typedef {"azure-entra" | "aws-iam" | "gcp-iam"} CloudAuth
 * @typedef {{ auth: CloudAuth, host: string, port: number, user: string, timeoutMs?: number, searchPaths?: readonly string[] }} CloudPasswordOptions
 * @typedef {{ token: string, refreshAt: number }} IssuedToken
 * The parts of each cloud SDK this module uses. The SDKs are optional peer dependencies, so their own types may be
 * absent where this package is type-checked.
 * @typedef {{ token: string, expiresOnTimestamp: number }} AzureAccessToken
 * @typedef {{ getToken(scope: string, options: { abortSignal: AbortSignal }): Promise<AzureAccessToken | null> }} AzureCredential
 * @typedef {{ DefaultAzureCredential: new () => AzureCredential }} AzureIdentityModule
 * @typedef {{ hostname: string, port: number, username: string, region?: string }} RdsSignerConfig
 * @typedef {{ Signer: new (config: RdsSignerConfig) => { getAuthToken(): Promise<string> } }} RdsSignerModule
 * @typedef {{ GoogleAuth: new (options: { scopes: string[] }) => { getAccessToken(): Promise<string | null | undefined> } }} GoogleAuthModule
 */

/**
 * The SDK each cloud signs in with, and the version the adapter is tested with. Each is an optional peer dependency:
 * only the one the configured `auth` names is needed, and it is imported only when that `auth` is used.
 */
export const CLOUD_AUTH_PACKAGES = /** @type {const} */ ({
	"azure-entra": { name: "@azure/identity", version: "4.14.1" },
	"aws-iam": { name: "@aws-sdk/rds-signer", version: "3.1169.0" },
	"gcp-iam": { name: "google-auth-library", version: "11.3.4" },
});

/** An Azure token is replaced this long before it expires, so a connection never presents one about to lapse. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/**
 * How long one token request may take. pg gives a new connection 10 seconds in all, password included, so a slower
 * answer would arrive after the connection already failed.
 */
const DEFAULT_TIMEOUT_MS = 8_000;
/** The longest part of an SDK's failure message an error carries. */
const DETAIL_LIMIT = 300;
/** A run of characters long enough to be a token, signature or key an SDK might quote in a failure. */
const CREDENTIAL_SHAPE = /[\w+=.-]{32,}/g;
const AZURE_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";
const GCP_SCOPE = "https://www.googleapis.com/auth/sqlservice.login";

/**
 * @param {string} reason
 * @param {string} hint
 */
function authError(reason, hint) {
	return new StorageConfigError("sdk", "auth", reason, hint);
}

/** Whether `error` says a module was not found, as `import()` and `require()` report it. */
function isNotFound(/** @type {unknown} */ error) {
	const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
	return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/**
 * Imports `auth`'s SDK, or explains how to install it. It is found beside the adapter first, then in each of
 * `searchPaths`, an npm prefix such as the one `atomic install npm:<package>` installs user packages into (#5218): an
 * adapter installed from a local path resolves only its own `node_modules`, where `atomic install` puts nothing.
 * @param {CloudAuth} auth
 * @param {readonly string[]} searchPaths
 */
async function loadSdk(auth, searchPaths) {
	const { name, version } = CLOUD_AUTH_PACKAGES[auth];
	try {
		return await import(name);
	} catch (error) {
		/** @type {unknown} */
		let failure = error;
		if (isNotFound(error))
			for (const prefix of searchPaths) {
				try {
					return createRequire(join(prefix, "package.json"))(name);
				} catch (fallback) {
					if (!isNotFound(fallback)) {
						failure = fallback;
						break;
					}
				}
			}
		const cause = /** @type {NodeJS.ErrnoException} */ (failure);
		throw authError(
			"auth-unavailable",
			`${auth} auth needs the optional package ${name}, which could not be loaded (${cause.code ?? cause.message}). ` +
				`Install it beside the adapter with \`atomic install npm:${name}@${version}\`, or \`npm install ${name}@${version}\` in an SDK project`,
		);
	}
}

/**
 * The client `create` builds from `auth`'s SDK, made on first use and kept for the provider's life, so it keeps what
 * it cached and learned about which credential source works. A failed load is tried again next time.
 * @template T
 * @param {CloudAuth} auth
 * @param {(sdk: any) => T} create
 * @param {readonly string[]} searchPaths
 * @returns {() => Promise<T>}
 */
function lazyClient(auth, create, searchPaths) {
	/** @type {Promise<T> | undefined} */
	let client;
	return () => {
		if (client === undefined) {
			const current = loadSdk(auth, searchPaths)
				.then(create)
				.catch((error) => {
					if (client === current) client = undefined;
					throw error;
				});
			client = current;
		}
		return client;
	};
}

/**
 * The token-fetching function of `auth`. Each fetch gets an abort signal that fires when it runs out of time.
 * @param {CloudPasswordOptions} options
 * @returns {(signal: AbortSignal) => Promise<IssuedToken>}
 */
function tokenSource({ auth, host, port, user, searchPaths = [] }) {
	if (auth === "azure-entra") {
		const credential = lazyClient(
			auth,
			(/** @type {AzureIdentityModule} */ sdk) => new sdk.DefaultAzureCredential(),
			searchPaths,
		);
		return async (signal) => {
			const issued = await (await credential()).getToken(AZURE_SCOPE, { abortSignal: signal });
			if (!issued?.token) throw new Error("returned no token");
			// The Azure CLI and developer CLI sources run a process for every request, so tokens are reused here.
			return { token: issued.token, refreshAt: issued.expiresOnTimestamp - REFRESH_MARGIN_MS };
		};
	}
	if (auth === "aws-iam") {
		// A token is signed for the database's region; an RDS endpoint names it, and the SDK's own configuration may not.
		const region = host.match(/\.([a-z]{2}(?:-[a-z]+)+-\d+)\.rds\.amazonaws\.com(?:\.cn)?$/)?.[1];
		const signer = lazyClient(
			auth,
			(/** @type {RdsSignerModule} */ sdk) =>
				new sdk.Signer({ hostname: host, port, username: user, ...(region === undefined ? {} : { region }) }),
			searchPaths,
		);
		return async () => {
			const token = await (await signer()).getAuthToken();
			if (!token) throw new Error("returned no token");
			// Signing is local once the SDK holds credentials, which it caches and refreshes, so nothing is reused here.
			return { token, refreshAt: 0 };
		};
	}
	const client = lazyClient(
		auth,
		(/** @type {GoogleAuthModule} */ sdk) => new sdk.GoogleAuth({ scopes: [GCP_SCOPE] }),
		searchPaths,
	);
	return async () => {
		const token = await (await client()).getAccessToken();
		if (!token) throw new Error("returned no token");
		// google-auth-library caches the token and refreshes it before it expires, so nothing is reused here.
		return { token, refreshAt: 0 };
	};
}

/** What to do when the SDK found no credentials. */
const HINTS = /** @type {Record<CloudAuth, string>} */ ({
	"azure-entra":
		"Run where DefaultAzureCredential finds an identity (managed identity, AKS workload identity, AZURE_* variables, or `az login`), and grant it a database role",
	"aws-iam":
		"Give the AWS SDK credentials (instance profile, IRSA, AWS_* variables or a profile) allowed `rds-db:connect` for this user",
	"gcp-iam":
		"Run where Application Default Credentials find a service account that is a Cloud SQL IAM user, or run `gcloud auth application-default login`",
});

/**
 * A password reader for `pg` that returns a cloud IAM token for each new connection, from the cloud's own SDK.
 * Tokens live only in memory; concurrent connections share one request, and each request is bounded by
 * `timeoutMs`. Every failure is a `StorageConfigError` with reason `auth-unavailable`, without a token in it.
 * @param {CloudPasswordOptions} options
 * @returns {(() => Promise<string>) & { invalidate(): void }}
 */
export function createCloudPasswordProvider(options) {
	const { auth, host, user } = options;
	for (const [name, value] of [
		["host", host],
		["user", user],
	])
		if (!value) throw authError("invalid-auth-target", `${auth} auth needs a ${name} in the URL`);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchToken = tokenSource(options);
	/** Every token issued, so a later failure that quotes one cannot show it. */
	const issuedTokens = new Set();

	/** @type {IssuedToken | undefined} */
	let cached;
	/** @type {Promise<string> | undefined} */
	let pending;

	async function refresh() {
		const controller = new AbortController();
		/** @type {NodeJS.Timeout | undefined} */
		let timer;
		const deadline = new Promise((_resolve, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error(`timed out after ${timeoutMs} ms`));
			}, timeoutMs);
		});
		try {
			const issued = await Promise.race([fetchToken(controller.signal), deadline]);
			issuedTokens.add(issued.token);
			cached = issued;
			return issued.token;
		} catch (error) {
			if (error instanceof StorageConfigError) throw error;
			const message = String(/** @type {Error} */ (error)?.message ?? error)
				.replace(/\s+/g, " ")
				.trim();
			const bounded = message.length > DETAIL_LIMIT ? `${message.slice(0, DETAIL_LIMIT)}…` : message;
			const detail = redactSecrets(issuedTokens)(bounded).replace(CREDENTIAL_SHAPE, "[redacted]");
			throw authError("auth-unavailable", `${auth} found no token (${detail || "no reason given"}). ${HINTS[auth]}`);
		} finally {
			clearTimeout(timer);
		}
	}

	const read = async () => {
		if (cached !== undefined && Date.now() < cached.refreshAt) return cached.token;
		pending ??= refresh().finally(() => {
			pending = undefined;
		});
		return pending;
	};
	// A token the server refused, such as one reused past its expiry by a clock that runs behind, is never used again
	// (#5218).
	return Object.assign(read, {
		invalidate() {
			cached = undefined;
		},
	});
}
