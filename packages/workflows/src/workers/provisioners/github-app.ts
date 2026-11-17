/**
 * GitHub App credentials for the command provisioner (#4768), as actions-runner-controller and
 * actions/create-github-app-token do it: `@octokit/auth-app` signs the app JWT and mints an installation token narrowed
 * to `actions: write` on one repository, which each `gh` command gets in its own environment. This module only checks the
 * options, reads the private key from a file only its owner can read, reuses each token until 5 minutes before it
 * expires, bounds the request, and turns its failures into {@link WorkerProvisionerError}s that never carry the key, the
 * JWT or a token. `@octokit/auth-app` is loaded only when a provisioner has `auth.githubApp`.
 */

import { createPrivateKey } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { sliceHead } from "@bastani/atomic";
import { redactSecrets, WorkerProvisionerError } from "./cli.js";
import type { GitHubAppAuthOptions } from "./types.js";

/** A token is minted afresh once it has less than this left. */
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;
/** Most characters of GitHub's error message an error keeps. */
const MAX_DETAIL_CHARS = 300;
/** Statuses that say the app, its installation, its key or what it asked for was refused. */
const REFUSED = new Set([401, 403, 404, 422]);

const ENV = {
	appId: "ATOMIC_GITHUB_APP_ID",
	installationId: "ATOMIC_GITHUB_APP_INSTALLATION_ID",
	privateKeyFile: "ATOMIC_GITHUB_APP_PRIVATE_KEY_FILE",
	repository: "ATOMIC_GITHUB_APP_REPOSITORY",
	host: "ATOMIC_GITHUB_HOST",
	apiUrl: "ATOMIC_GITHUB_API_URL",
} as const;

/** A GitHub App's checked settings. */
export interface GitHubAppSettings {
	readonly appId: string;
	readonly installationId: number;
	readonly privateKeyFile: string;
	readonly owner: string;
	readonly repository: string;
	readonly host: string;
	readonly apiUrl: string;
}

function invalid(hint: string): TypeError {
	return new TypeError(`Invalid command provisioner options: auth.githubApp.${hint}`);
}

/**
 * The settings of `options`, each one it leaves out read from its environment variable; throws a `TypeError` naming the
 * option at fault.
 */
export function resolveGitHubApp(options: GitHubAppAuthOptions): GitHubAppSettings {
	const value = (name: keyof typeof ENV): string | number | undefined => {
		const given = options[name];
		if (given !== undefined) return given;
		const fromEnv = process.env[ENV[name]];
		return fromEnv === undefined || fromEnv === "" ? undefined : fromEnv;
	};
	const required = (name: keyof typeof ENV): string | number => {
		const found = value(name);
		if (found === undefined) throw invalid(`${name} is required: set it, or ${ENV[name]}.`);
		return found;
	};
	const appId = required("appId");
	if (
		!(typeof appId === "string" && appId.trim() !== "") &&
		!(typeof appId === "number" && Number.isSafeInteger(appId) && appId > 0)
	)
		throw invalid("appId must be a non-empty string or a positive integer.");
	const installationId = required("installationId");
	const installation =
		typeof installationId === "string" && /^\d+$/.test(installationId) ? Number(installationId) : installationId;
	if (typeof installation !== "number" || !Number.isSafeInteger(installation) || installation < 1)
		throw invalid("installationId must be a positive integer.");
	const privateKeyFile = required("privateKeyFile");
	if (typeof privateKeyFile !== "string" || privateKeyFile === "")
		throw invalid("privateKeyFile must be a non-empty string.");
	const repository = required("repository");
	const [owner, name, ...rest] = typeof repository === "string" ? repository.split("/") : [];
	if (
		owner === undefined ||
		name === undefined ||
		rest.length > 0 ||
		!/^[\w.-]+$/.test(owner) ||
		!/^[\w.-]+$/.test(name)
	)
		throw invalid("repository must be owner/name.");
	const host = value("host") ?? "github.com";
	if (typeof host !== "string" || !/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host))
		throw invalid("host must be a host name, such as github.com.");
	const apiUrl = value("apiUrl") ?? defaultApiUrl(host);
	// The app's JWT and its tokens cross this connection: plain HTTP only to this machine.
	if (
		typeof apiUrl !== "string" ||
		!/^(?:https:\/\/[^/]|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$))/.test(apiUrl)
	)
		throw invalid("apiUrl must be an https URL, or http on localhost.");
	let base = apiUrl;
	while (base.endsWith("/")) base = base.slice(0, -1);
	return {
		appId: String(appId),
		installationId: installation,
		privateKeyFile: resolve(privateKeyFile),
		owner,
		repository: name,
		host,
		apiUrl: base,
	};
}

/** The REST API of `host`: github.com's, a GHE.com subdomain's, or a GitHub Enterprise Server's. */
function defaultApiUrl(host: string): string {
	if (host === "github.com") return "https://api.github.com";
	if (host.replace(/:\d+$/, "").endsWith(".ghe.com")) return `https://api.${host}`;
	return `https://${host}/api/v3`;
}

/** The variables `gh` reads its token and host from, for `host`. */
function ghEnv(host: string, token: string): Record<string, string> {
	if (host === "github.com") return { GH_TOKEN: token };
	if (host.replace(/:\d+$/, "").endsWith(".ghe.com")) return { GH_TOKEN: token, GH_HOST: host };
	return { GH_ENTERPRISE_TOKEN: token, GH_HOST: host };
}

/** The private key in `file`, after checking that only its owner can read it. Its content never reaches an error. */
async function readPrivateKey(file: string): Promise<string> {
	const refused = (reason: string) =>
		new WorkerProvisionerError("auth", `The GitHub App private key file ${file} ${reason}.`);
	let pem: string;
	try {
		if (process.platform !== "win32" && ((await stat(file)).mode & 0o077) !== 0)
			throw refused("is readable by other users; restrict it with chmod 600");
		pem = await readFile(file, "utf8");
	} catch (error) {
		if (error instanceof WorkerProvisionerError) throw error;
		throw refused(`cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
	}
	try {
		createPrivateKey(pem);
	} catch {
		throw refused("is not a PEM private key");
	}
	return pem;
}

/** `promise`, or the reason of `signal` as soon as it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: Error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** What `@octokit/request` rejects with: a `RequestError` with GitHub's response, or a network failure. */
interface RequestFailure extends Error {
	readonly status?: number;
	readonly response?: { readonly data?: { readonly message?: string } | string };
}

/**
 * Mints a GitHub App's installation tokens for the provisioner's commands. `env` resolves the variables that carry the
 * current token, minting one when it has none with more than 5 minutes left. A request outlives no `timeoutMs`; the
 * caller's signal rejects its call at once.
 */
export class GitHubAppCredentials {
	/** The last token, served until 5 minutes before it expires. */
	private current?: { readonly token: string; readonly refreshAt: number };
	private readonly url: string;

	constructor(
		private readonly app: GitHubAppSettings,
		private readonly timeoutMs: number,
	) {
		this.url = `${app.apiUrl}/app/installations/${app.installationId}/access_tokens`;
	}

	async env(signal: AbortSignal): Promise<Record<string, string>> {
		signal.throwIfAborted();
		return ghEnv(this.app.host, await untilAborted(this.token(), signal));
	}

	private async token(): Promise<string> {
		if (this.current !== undefined && Date.now() < this.current.refreshAt) return this.current.token;
		const privateKey = await readPrivateKey(this.app.privateKeyFile);
		const [{ createAppAuth }, { request }] = await Promise.all([
			import("@octokit/auth-app"),
			import("@octokit/request"),
		]);
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const auth = createAppAuth({
			appId: this.app.appId,
			privateKey,
			installationId: this.app.installationId,
			request: request.defaults({
				baseUrl: this.app.apiUrl,
				headers: { "user-agent": "atomic-worker-controller", "x-github-api-version": "2022-11-28" },
				request: { signal: timeout },
			}),
		});
		let minted: { readonly token?: string; readonly expiresAt?: string };
		try {
			minted = await auth({
				type: "installation",
				repositoryNames: [this.app.repository],
				permissions: { actions: "write" },
			});
		} catch (error) {
			throw this.failure(error as RequestFailure, timeout);
		}
		const expiry = Date.parse(minted.expiresAt ?? "");
		if (typeof minted.token !== "string" || minted.token === "" || !Number.isFinite(expiry))
			throw new WorkerProvisionerError(
				"malformed",
				`the GitHub App token request to ${this.url} did not return a token and its expiry.`,
			);
		this.current = { token: minted.token, refreshAt: expiry - REFRESH_BEFORE_EXPIRY_MS };
		return minted.token;
	}

	/** `error` as a {@link WorkerProvisionerError} that names the request and GitHub's message, and nothing secret. */
	private failure(error: RequestFailure, timeout: AbortSignal): WorkerProvisionerError {
		if (timeout.aborted)
			return new WorkerProvisionerError(
				"timeout",
				`the GitHub App token request to ${this.url} did not finish within ${this.timeoutMs} ms and was stopped.`,
			);
		const data = error.response?.data;
		const detail = (text: string) => {
			const redacted = redactSecrets(text, [], {});
			return redacted.length > MAX_DETAIL_CHARS ? `${sliceHead(redacted, MAX_DETAIL_CHARS)}…` : redacted;
		};
		if (error.response === undefined || error.status === undefined)
			return new WorkerProvisionerError(
				"unavailable",
				`the GitHub App token request to ${this.url} failed: ${detail(error.message)}`,
			);
		// GitHub's own explanation, when its reply has one: shown, never inspected.
		const said = typeof data === "object" && typeof data.message === "string" ? [data.message] : [];
		return new WorkerProvisionerError(
			REFUSED.has(error.status) ? "auth" : "unavailable",
			[`the GitHub App token request to ${this.url} failed: HTTP ${error.status}`, ...said.map(detail)].join(": "),
		);
	}
}
