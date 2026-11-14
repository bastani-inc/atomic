// @ts-check
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { StorageConfigError } from "@bastani/atomic/storage";

/**
 * @typedef {"azure-entra" | "aws-iam" | "gcp-iam"} CloudAuth
 * @typedef {{ auth: CloudAuth, host: string, port: number, user: string, timeoutMs?: number }} CloudPasswordOptions
 * @typedef {{ token: string, refreshAt: number }} IssuedToken
 * @typedef {{ name: string, fetch: (timeouts: Timeouts) => Promise<IssuedToken> }} CredentialSource
 * @typedef {{ metadata: number, cli: number }} Timeouts
 */

/** A token is replaced this long before it expires, so a connection never presents one about to lapse. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** `gcloud auth print-access-token` prints no expiry; it never prints a token with under ~4 minutes left. */
const GCLOUD_CACHE_MS = 60_000;
/** An RDS IAM token's lifetime from when the CLI signs it. */
const AWS_TOKEN_LIFETIME_MS = 15 * 60_000;
const DEFAULT_TIMEOUTS = /** @type {Timeouts} */ ({ metadata: 5_000, cli: 30_000 });
/** The longest single line of a CLI's or endpoint's failure text an error carries. */
const DETAIL_LIMIT = 200;

const AZURE_RESOURCE = "https://ossrdbms-aad.database.windows.net";
/**
 * Host and user values the AWS CLI receives as arguments. Excludes whitespace and every shell metacharacter, so
 * the Windows `cmd.exe` launch below cannot misread them, and a leading `-`, so no value parses as an option.
 */
const SAFE_ARGUMENT = /^[A-Za-z0-9_.@+:=/][A-Za-z0-9_.@+:=/-]*$/;

/**
 * A run of text long enough to be a bearer token, SigV4 signature or assertion a CLI might echo in a failure. Words,
 * error codes and short identifiers are shorter.
 */
const CREDENTIAL_SHAPE = /[^\s'"`]{32,}/g;

/**
 * @param {string} reason
 * @param {string} hint
 */
function authError(reason, hint) {
	return new StorageConfigError("sdk", "auth", reason, hint);
}

/** The first line of a failure, length-bounded, with anything shaped like a credential removed. */
function detail(/** @type {string} */ text) {
	const line = text
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find(Boolean);
	if (line === undefined) return "no output";
	const bounded = line.length > DETAIL_LIMIT ? `${line.slice(0, DETAIL_LIMIT)}…` : line;
	return bounded.replace(CREDENTIAL_SHAPE, "[redacted]");
}

/** A non-empty string token, or a failure that does not repeat the output it came from. */
function requireToken(/** @type {string | undefined} */ token, /** @type {string} */ what) {
	if (typeof token !== "string" || !token.trim()) throw new Error(`returned no ${what}`);
	return token.trim();
}

/**
 * Parses JSON output without ever echoing it: the output holds the token.
 * @param {string} text
 * @returns {Record<string, string | number | undefined>}
 */
function parseJson(text) {
	try {
		const value = JSON.parse(text);
		if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
	} catch {}
	throw new Error("returned output that is not a JSON object");
}

/** @param {number} expiresAt */
function refreshBefore(expiresAt) {
	return expiresAt - REFRESH_MARGIN_MS;
}

/** An absolute expiry from `expires_on` (epoch seconds) or `expires_in` (seconds from now). */
function expiryOf(/** @type {Record<string, string | number | undefined>} */ body) {
	const on = Number(body.expires_on);
	if (on > 0) return on * 1000;
	const inSeconds = Number(body.expires_in);
	if (inSeconds > 0) return Date.now() + inSeconds * 1000;
	throw new Error("returned a token without an expiry");
}

/**
 * Requests a token from a metadata or token endpoint.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
async function requestToken(url, init, timeoutMs) {
	let response;
	let text;
	try {
		response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
		text = await response.text();
	} catch (error) {
		const name = /** @type {Error} */ (error).name;
		if (name === "TimeoutError") throw new Error(`timed out after ${timeoutMs} ms`);
		const cause = /** @type {{ cause?: { code?: string } }} */ (error).cause;
		throw new Error(`unreachable (${cause?.code ?? name})`);
	}
	if (!response.ok) {
		let description = "";
		try {
			const body = JSON.parse(text);
			description = String(body.error_description ?? body.error ?? "");
		} catch {}
		throw new Error(`HTTP ${response.status}${description ? `: ${detail(description)}` : ""}`);
	}
	const body = parseJson(text);
	return { token: requireToken(/** @type {string | undefined} */ (body.access_token), "access_token"), expiresAt: expiryOf(body) };
}

/**
 * Runs a platform CLI with an argument array. On Windows `az` and `gcloud` are `.cmd` scripts, which only `cmd.exe`
 * runs; every argument has passed {@link SAFE_ARGUMENT} or is a constant, so the command line has no metacharacter.
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function runCli(command, args, timeoutMs) {
	return new Promise((resolve, reject) => {
		const windows = process.platform === "win32";
		// Settled by its own timer: on Windows, killing `cmd.exe` leaves the CLI holding the pipes `execFile` waits on.
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`timed out after ${timeoutMs} ms`));
		}, timeoutMs);
		const child = execFile(
			windows ? process.env.ComSpec || "cmd.exe" : command,
			windows ? ["/d", "/s", "/c", `"${[command, ...args].join(" ")}"`] : args,
			{ windowsHide: true, windowsVerbatimArguments: windows, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				clearTimeout(timer);
				if (!error) return resolve(stdout);
				const failure = /** @type {NodeJS.ErrnoException} */ (error);
				if (failure.code === "ENOENT") return reject(new Error(`\`${command}\` was not found on PATH`));
				// `cmd.exe` reports a missing command as exit 1 with this text.
				if (/is not recognized as an internal or external command/.test(stderr))
					return reject(new Error(`\`${command}\` was not found on PATH`));
				reject(new Error(`exited with code ${failure.code}: ${detail(stderr)}`));
			},
		);
	});
}

/** @returns {CredentialSource[]} */
function azureSources() {
	/** @type {CredentialSource[]} */
	const sources = [];
	const { AZURE_FEDERATED_TOKEN_FILE, AZURE_CLIENT_ID, AZURE_TENANT_ID, IDENTITY_ENDPOINT, IDENTITY_HEADER } = process.env;
	if (AZURE_FEDERATED_TOKEN_FILE && AZURE_CLIENT_ID && AZURE_TENANT_ID) {
		sources.push({
			name: "workload identity",
			async fetch(timeouts) {
				const assertion = (await readFile(AZURE_FEDERATED_TOKEN_FILE, "utf8")).trim();
				const authority = (process.env.AZURE_AUTHORITY_HOST || "https://login.microsoftonline.com/").replace(/\/+$/, "");
				const { token, expiresAt } = await requestToken(
					`${authority}/${encodeURIComponent(AZURE_TENANT_ID)}/oauth2/v2.0/token`,
					{
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							client_id: AZURE_CLIENT_ID,
							client_assertion: assertion,
							client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
							grant_type: "client_credentials",
							scope: `${AZURE_RESOURCE}/.default`,
						}).toString(),
					},
					timeouts.metadata,
				);
				return { token, refreshAt: refreshBefore(expiresAt) };
			},
		});
	} else if (IDENTITY_ENDPOINT && IDENTITY_HEADER) {
		sources.push({
			name: "managed identity",
			async fetch(timeouts) {
				const url = new URL(IDENTITY_ENDPOINT);
				url.searchParams.set("api-version", "2019-08-01");
				url.searchParams.set("resource", AZURE_RESOURCE);
				if (AZURE_CLIENT_ID) url.searchParams.set("client_id", AZURE_CLIENT_ID);
				const { token, expiresAt } = await requestToken(
					url.href,
					{ headers: { "x-identity-header": IDENTITY_HEADER } },
					timeouts.metadata,
				);
				return { token, refreshAt: refreshBefore(expiresAt) };
			},
		});
	} else {
		sources.push({
			name: "managed identity (IMDS)",
			async fetch(timeouts) {
				const host = (process.env.AZURE_POD_IDENTITY_AUTHORITY_HOST || "http://169.254.169.254").replace(/\/+$/, "");
				const url = new URL(`${host}/metadata/identity/oauth2/token`);
				url.searchParams.set("api-version", "2018-02-01");
				url.searchParams.set("resource", AZURE_RESOURCE);
				if (AZURE_CLIENT_ID) url.searchParams.set("client_id", AZURE_CLIENT_ID);
				const { token, expiresAt } = await requestToken(url.href, { headers: { metadata: "true" } }, timeouts.metadata);
				return { token, refreshAt: refreshBefore(expiresAt) };
			},
		});
	}
	sources.push({
		name: "az CLI",
		async fetch(timeouts) {
			const body = parseJson(
				await runCli("az", ["account", "get-access-token", "--resource-type", "oss-rdbms", "--output", "json"], timeouts.cli),
			);
			const token = requireToken(/** @type {string | undefined} */ (body.accessToken), "accessToken");
			// `expires_on` (epoch seconds) since az 2.54; older versions print only a local-time `expiresOn`.
			const on = Number(body.expires_on);
			const expiresAt = on > 0 ? on * 1000 : Date.parse(String(body.expiresOn).replace(" ", "T"));
			if (!Number.isFinite(expiresAt)) throw new Error("returned a token without an expiry");
			return { token, refreshAt: refreshBefore(expiresAt) };
		},
	});
	return sources;
}

/**
 * @param {string} host
 * @param {number} port
 * @param {string} user
 * @returns {CredentialSource[]}
 */
function awsSources(host, port, user) {
	for (const [name, value] of [
		["host", host],
		["user", user],
	])
		if (!SAFE_ARGUMENT.test(value))
			throw authError(
				"invalid-auth-target",
				`The aws-iam token needs a ${name} without spaces, quotes or shell metacharacters, not starting with "-"`,
			);
	const args = ["rds", "generate-db-auth-token", "--hostname", host, "--port", String(port), "--username", user];
	// A token is signed for the database's region; an RDS endpoint names it, and the CLI's own configuration may not.
	const region = host.match(/\.([a-z]{2}(?:-[a-z]+)+-\d+)\.rds\.amazonaws\.com(?:\.cn)?$/)?.[1];
	if (region !== undefined) args.push("--region", region);
	return [
		{
			name: "aws CLI",
			async fetch(timeouts) {
				const token = requireToken((await runCli("aws", args, timeouts.cli)).split(/\r?\n/)[0], "token");
				return { token, refreshAt: refreshBefore(Date.now() + AWS_TOKEN_LIFETIME_MS) };
			},
		},
	];
}

/** @returns {CredentialSource[]} */
function gcpSources() {
	return [
		{
			name: "metadata server",
			async fetch(timeouts) {
				const host = process.env.GCE_METADATA_HOST || "metadata.google.internal";
				const { token, expiresAt } = await requestToken(
					`http://${host}/computeMetadata/v1/instance/service-accounts/default/token`,
					{ headers: { "metadata-flavor": "Google" } },
					timeouts.metadata,
				);
				return { token, refreshAt: refreshBefore(expiresAt) };
			},
		},
		{
			name: "gcloud CLI",
			async fetch(timeouts) {
				const token = requireToken((await runCli("gcloud", ["auth", "print-access-token"], timeouts.cli)).trim(), "token");
				return { token, refreshAt: Date.now() + GCLOUD_CACHE_MS };
			},
		},
	];
}

/** What to do when no source returned a token. */
const HINTS = /** @type {Record<CloudAuth, string>} */ ({
	"azure-entra":
		"Run on an Azure host with a managed identity or AKS workload identity, or sign in with `az login`, and grant that principal a database role",
	"aws-iam":
		"Install the AWS CLI v2 and give it credentials (instance profile, IRSA, AWS_* variables or a profile) allowed `rds-db:connect` for this user",
	"gcp-iam":
		"Run on Google Cloud with a service account that is a Cloud SQL IAM user, or sign in with `gcloud auth login`",
});

/**
 * A password reader for `pg` that returns a cloud IAM token for each new connection. Tokens live only in memory and
 * are reused until 5 minutes before they expire; concurrent connections share one fetch. Every failure is a
 * `StorageConfigError` whose reason is `auth-unavailable` and whose message names each source tried, never a token.
 * @param {CloudPasswordOptions} options
 * @returns {() => Promise<string>}
 */
export function createCloudPasswordProvider(options) {
	const { auth, host, port, user, timeoutMs } = options;
	const timeouts =
		timeoutMs === undefined ? DEFAULT_TIMEOUTS : { metadata: Math.min(timeoutMs, DEFAULT_TIMEOUTS.metadata), cli: timeoutMs };
	const sources = auth === "azure-entra" ? azureSources() : auth === "aws-iam" ? awsSources(host, port, user) : gcpSources();

	/** @type {IssuedToken | undefined} */
	let cached;
	/** @type {Promise<string> | undefined} */
	let pending;

	async function fetchToken() {
		const failures = [];
		for (const source of sources) {
			try {
				const issued = await source.fetch(timeouts);
				cached = issued;
				return issued.token;
			} catch (error) {
				failures.push(`${source.name}: ${/** @type {Error} */ (error).message}`);
			}
		}
		throw authError("auth-unavailable", `${auth} found no token (${failures.join("; ")}). ${HINTS[auth]}`);
	}

	return async () => {
		if (cached !== undefined && Date.now() < cached.refreshAt) return cached.token;
		pending ??= fetchToken().finally(() => {
			pending = undefined;
		});
		return pending;
	};
}
