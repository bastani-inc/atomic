// @ts-check
import { connect as connectNet, isIP } from "node:net";
import { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";

/**
 * How the adapter reaches PostgreSQL through an HTTP proxy (#5473): which connections a proxy applies to, the `CONNECT`
 * tunnel each of them is opened through, and the stream pg is given for it. PostgreSQL's own protocol, TLS included,
 * then runs inside the tunnel with the real server, so the proxy passes only the bytes the server would see.
 */

/**
 * How long a proxy may take to accept the connection and answer its tunnel request: less than the adapter's 10 s bound
 * for a whole connection, so a silent proxy is named as the reason rather than a connection timeout.
 */
export const PROXY_ANSWER_TIMEOUT_MS = 8_000;
/** The most bytes all proxy responses may take through the blank line ending the final headers. */
const MAX_PROXY_ANSWER_BYTES = 16 * 1024;
/** The most characters of a proxy's status text a failure repeats. */
const MAX_REASON_LENGTH = 80;

/**
 * The codes of a certificate TLS verification refused, which it refuses the same way on every attempt, so a connection
 * that fails with one is never retried (#6074): the host name check's code and Node's X509 certificate error codes,
 * which Bun's `node:tls` reports too, except `OUT_OF_MEM`, which says nothing about the certificate. The adapter
 * refuses a server's certificate with them, and an https proxy's.
 * @type {ReadonlySet<string>}
 */
export const TLS_VERIFICATION_CODES = new Set([
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_CRL",
	"UNABLE_TO_DECRYPT_CERT_SIGNATURE",
	"UNABLE_TO_DECRYPT_CRL_SIGNATURE",
	"UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
	"CERT_SIGNATURE_FAILURE",
	"CRL_SIGNATURE_FAILURE",
	"CERT_NOT_YET_VALID",
	"CERT_HAS_EXPIRED",
	"CRL_NOT_YET_VALID",
	"CRL_HAS_EXPIRED",
	"ERROR_IN_CERT_NOT_BEFORE_FIELD",
	"ERROR_IN_CERT_NOT_AFTER_FIELD",
	"ERROR_IN_CRL_LAST_UPDATE_FIELD",
	"ERROR_IN_CRL_NEXT_UPDATE_FIELD",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"CERT_CHAIN_TOO_LONG",
	"CERT_REVOKED",
	"INVALID_CA",
	"PATH_LENGTH_EXCEEDED",
	"INVALID_PURPOSE",
	"CERT_UNTRUSTED",
	"CERT_REJECTED",
	"HOSTNAME_MISMATCH",
]);

/**
 * Node and Bun report a verification result outside their table as `UNSPECIFIED`, with OpenSSL's reason for it, such as
 * "key usage does not include certificate signing" for a root that may not sign certificates (#6112). These are those
 * reasons that describe the certificate, lowercase, from OpenSSL 3 and BoringSSL. `UNSPECIFIED` with any other message,
 * such as OpenSSL's own failures or an error that did not come from TLS at all, is not a refused certificate. Atomic's
 * model requests hold the same list (`packages/ai/src/utils/tls-certificate.ts`).
 * @type {readonly string[]}
 */
export const UNSPECIFIED_CERTIFICATE_REASONS = [
	"authority and issuer serial number mismatch",
	"authority and subject key identifier mismatch",
	"authority key identifier marked critical",
	"basic constraints of ca cert not marked critical",
	"ca cert does not include key usage extension",
	"ca certificate key too weak",
	"ca signature digest algorithm too weak",
	"cannot find certificate signature algorithm",
	"cert info signature and signature algorithm mismatch",
	"certificate public key has explicit ecc parameters",
	"certificate transparency required, but no valid scts found",
	"crl path validation error",
	"different crl scope",
	"ee certificate key too weak",
	"email address mismatch",
	"empty subject alternative name extension",
	"excluded subtree violation",
	"invalid non-ca certificate (has ca markings)",
	"invalid or inconsistent certificate extension",
	"invalid or inconsistent certificate policy extension",
	"ip address mismatch",
	"issuer certificate doesn't have a public key",
	"issuer has name constraints but leaf has no sans",
	"issuer name empty",
	"key usage does not include certificate signing",
	"key usage does not include crl signing",
	"key usage does not include digital signature",
	"key usage keycertsign invalid for non-ca cert",
	"missing authority key identifier",
	"missing subject key identifier",
	"name constraints minimum and maximum not supported",
	"no explicit policy",
	"no matching dane tlsa records",
	"ocsp unknown cert",
	"ocsp verification failed",
	"ocsp verification needed",
	"path length given without key usage keycertsign",
	"path length invalid for non-ca cert",
	"path loop",
	"permitted subtree violation",
	"proxy certificates not allowed, please set the appropriate flag",
	"proxy path length constraint exceeded",
	"proxy subject name violation",
	"raw public key untrusted, no trusted keys configured",
	"rfc 3779 resource not subset of parent's resources",
	"subject empty and subject alt name extension not critical",
	"subject issuer mismatch",
	"subject key identifier marked critical",
	"subject name empty",
	"subject signature algorithm and issuer public key algorithm mismatch",
	"suite b: cannot sign p-384 with p-256",
	"suite b: certificate version invalid",
	"suite b: curve not allowed for this los",
	"suite b: invalid ecc curve",
	"suite b: invalid public key algorithm",
	"suite b: invalid signature algorithm",
	"unable to get crl issuer certificate",
	"unhandled critical crl extension",
	"unhandled critical extension",
	"unsupported extension feature",
	"unsupported name constraint type",
	"unsupported or invalid name constraint syntax",
	"unsupported or invalid name syntax",
	"using cert extension requires at least x509v3",
];

/**
 * Whether TLS verification refused a certificate with `code`, whose message is `reason`: a code in
 * `TLS_VERIFICATION_CODES`, or `UNSPECIFIED` with a reason in `UNSPECIFIED_CERTIFICATE_REASONS`.
 * @param {string} code
 * @param {string} reason
 */
export function isRefusedCertificate(code, reason) {
	if (TLS_VERIFICATION_CODES.has(code)) return true;
	if (code !== "UNSPECIFIED") return false;
	const text = reason.toLowerCase();
	return UNSPECIFIED_CERTIFICATE_REASONS.some((known) => text.startsWith(known));
}

/**
 * @typedef {{ readonly host: string, readonly port: number }} ProxyTarget
 * @typedef {{ readonly [name: string]: string | undefined }} ProxyEnvironment
 * @typedef {{
 *   readonly protocol: "http:" | "https:",
 *   readonly host: string,
 *   readonly port: number,
 *   readonly label: string,
 *   readonly authorization?: string,
 * }} HttpProxy
 * @typedef {(target: ProxyTarget) => import("node:stream").Duplex | Promise<import("node:stream").Duplex>} PostgresSocketFactory
 * @typedef {{ readonly kind: "direct" } | { readonly kind: "proxy", readonly proxy: HttpProxy }} PostgresTransport
 */

/**
 * Why a proxy setting cannot be used: a value that is not a URL, or one whose scheme is not `http:` or `https:`.
 * `subject` names where the setting came from, never its value, which can hold credentials.
 */
export class ProxySettingError extends Error {
	/**
	 * @param {string} subject
	 * @param {string} problem
	 */
	constructor(subject, problem) {
		super(`${subject} ${problem}`);
		this.name = "ProxySettingError";
	}
}

/** `host` as the proxy rules compare it: lowercase, without IPv6 brackets or a trailing dot. */
function normalizedHost(/** @type {string} */ host) {
	let name = host.replace(/^\[(.+)\]$/, "$1").toLowerCase();
	if (name.length > 1 && name.endsWith(".")) name = name.slice(0, -1);
	return name;
}

/**
 * The entries of a `NO_PROXY` value, read as Atomic's HTTPS clients (Undici's `EnvHttpProxyAgent`) read them: separated
 * by commas or white space; each a host name, an IPv4 address, a bare or bracketed IPv6 address, or `*`, with an
 * optional `:port`; a leading `.` or `*.` makes it match subdomains, and `*.` excludes the domain itself.
 * @param {string} value
 * @returns {{ hostname: string, port: number, wildcard: boolean }[]}
 */
function noProxyEntries(value) {
	/** @type {{ hostname: string, port: number, wildcard: boolean }[]} */
	const entries = [];
	for (const entry of value.split(/[,\s]/)) {
		if (entry === "") continue;
		let hostname;
		let port;
		const bracketed = /^\[(.+)\]:(\d+)$/.exec(entry);
		if (bracketed !== null) {
			hostname = /** @type {string} */ (bracketed[1]);
			port = Number.parseInt(/** @type {string} */ (bracketed[2]), 10);
		} else {
			const unbracketed = entry.replace(/^\[(.+)\]$/, "$1");
			const colons = (unbracketed.match(/:/g) ?? []).length;
			const parsed = colons === 1 ? /^(.+):(\d+)$/.exec(unbracketed) : null;
			hostname = parsed === null ? unbracketed : /** @type {string} */ (parsed[1]);
			port = parsed === null ? 0 : Number.parseInt(/** @type {string} */ (parsed[2]), 10);
		}
		entries.push({
			hostname: hostname
				.replace(/^\*?\./, "")
				.replace(/^(.+)\.$/, "$1")
				.toLowerCase(),
			port,
			wildcard: entry.startsWith("*"),
		});
	}
	return entries;
}

/**
 * Whether a `NO_PROXY` value exempts `host` on `port`, as Atomic's HTTPS clients decide it: an entry with a port matches
 * that port only; `*` matches every host; a host name matches itself and its subdomains, and `*.name` only subdomains.
 * @param {string} host
 * @param {number} port
 * @param {string} value
 */
export function noProxyMatches(host, port, value) {
	const name = normalizedHost(host);
	for (const entry of noProxyEntries(value)) {
		if (entry.port !== 0 && entry.port !== port) continue;
		if (entry.hostname === "*") return true;
		if (!entry.wildcard && name === entry.hostname) return true;
		if (name.endsWith(`.${entry.hostname}`)) return true;
	}
	return false;
}

/**
 * The environment's proxy for a connection to PostgreSQL, and the variable it came from, or undefined when none is set:
 * `https_proxy` (else `HTTPS_PROXY`) as for any HTTPS request, then `all_proxy` (else `ALL_PROXY`) when it names an
 * HTTP proxy, then `http_proxy` (else `HTTP_PROXY`), which Atomic's HTTPS clients also fall back to. A lowercase variable
 * wins over its uppercase form even when empty, as there; an empty value sets no proxy.
 * @param {ProxyEnvironment} env
 * @returns {{ readonly variable: string, readonly value: string } | undefined}
 */
export function proxySetting(env) {
	for (const [lower, upper] of [
		["https_proxy", "HTTPS_PROXY"],
		["all_proxy", "ALL_PROXY"],
		["http_proxy", "HTTP_PROXY"],
	]) {
		const variable = env[/** @type {string} */ (lower)] !== undefined ? lower : upper;
		const value = env[/** @type {string} */ (variable)]?.trim() ?? "";
		if (value === "") continue;
		// ALL_PROXY often names a SOCKS proxy for other tools; only an HTTP one can carry a tunnel here.
		if (lower === "all_proxy" && !/^(?:https?:\/\/|[^:/]+(?::\d+)?\/?$)/i.test(value)) continue;
		return { variable: /** @type {string} */ (variable), value };
	}
	return undefined;
}

/**
 * The proxy a setting names: an `http:` or `https:` URL, or a bare `host:port`, read as `http:`. Credentials in it are
 * sent as `Proxy-Authorization: Basic`, and left out of `label`, the form failures name the proxy by.
 * @param {string} value
 * @param {string} subject Where the value came from, as a failure names it.
 * @returns {HttpProxy}
 */
export function parseProxy(value, subject) {
	/** @type {URL} */
	let url;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
	} catch {
		throw new ProxySettingError(subject, "is not a proxy URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new ProxySettingError(
			subject,
			`names a ${url.protocol} proxy; PostgreSQL connections can only be tunnelled through an http:// or https:// proxy`,
		);
	if (url.hostname === "") throw new ProxySettingError(subject, "names no proxy host");
	const protocol = /** @type {"http:" | "https:"} */ (url.protocol);
	const port = url.port === "" ? (protocol === "https:" ? 443 : 80) : Number(url.port);
	const host = url.hostname.replace(/^\[(.+)\]$/, "$1");
	const label = `${protocol}//${url.host}`;
	if (url.username === "" && url.password === "") return { protocol, host, port, label };
	/** @type {string} */
	let credentials;
	try {
		credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
	} catch {
		throw new ProxySettingError(subject, "has credentials that are not valid percent-encoding");
	}
	return {
		protocol,
		host,
		port,
		label,
		authorization: `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`,
	};
}

/**
 * `host` in the canonical form a URL gives an address, such as `127.0.0.1` for `127.1` and `::1` for
 * `0:0:0:0:0:0:0:1`, which name the same address to the resolver; a name, or a host a URL cannot hold, as it is.
 */
function canonicalHost(/** @type {string} */ host) {
	try {
		return normalizedHost(new URL(`http://${host.includes(":") ? `[${host}]` : host}/`).hostname);
	} catch {
		return host;
	}
}

/**
 * Whether `host` is this machine: a socket directory, a loopback name or a loopback address, in any spelling a URL or
 * the resolver reads as one, such as `127.1`, `localhost.` or `::ffff:127.0.0.1`.
 */
export function isLocalTarget(/** @type {string} */ host) {
	const name = normalizedHost(host);
	if (name === "" || name.startsWith("/")) return true;
	const canonical = canonicalHost(name);
	return (
		canonical === "localhost" ||
		canonical === "::1" ||
		/^127(?:\.\d{1,3}){3}$/.test(canonical) ||
		// An IPv4-mapped IPv6 address of 127.0.0.0/8, which a URL writes as `::ffff:7fxx:xxxx`.
		/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(canonical)
	);
}

/**
 * How a connection to `target` is opened (#5473): through the proxy `option` names (`"none"` for a direct connection),
 * else through the environment's proxy unless `NO_PROXY` exempts the target; a socket directory and a loopback target
 * are reached directly whatever the environment says, as a proxy elsewhere could not reach them.
 * @param {ProxyTarget} target
 * @param {ProxyEnvironment} env
 * @param {string} [option]
 * @returns {PostgresTransport}
 */
export function postgresTransport(target, env, option) {
	if (option !== undefined) {
		if (option.trim().toLowerCase() === "none") return { kind: "direct" };
		return { kind: "proxy", proxy: parseProxy(option.trim(), "The proxy option") };
	}
	if (isLocalTarget(target.host)) return { kind: "direct" };
	const setting = proxySetting(env);
	if (setting === undefined) return { kind: "direct" };
	const noProxy = env.no_proxy ?? env.NO_PROXY ?? "";
	// Matched against the host's canonical form, as Atomic's HTTPS clients match a URL's host: `10.1` is `10.0.0.1`.
	if (noProxyMatches(canonicalHost(target.host), target.port, noProxy)) return { kind: "direct" };
	return { kind: "proxy", proxy: parseProxy(setting.value, setting.variable) };
}

/** `host:port` as a tunnel request names it, with an IPv6 address in brackets. */
export function authorityOf(/** @type {ProxyTarget} */ target) {
	const host = target.host.replace(/^\[(.+)\]$/, "$1");
	return `${isIP(host) === 6 ? `[${host}]` : host}:${target.port}`;
}

/**
 * A tunnel a proxy did not open: `permanent` when the proxy refused it (a 4xx answer, an answer that is not HTTP, or an
 * https proxy whose certificate was not accepted), which asking again would not change; otherwise the proxy or what it
 * connects to could not be reached for now. The message names the proxy without its credentials, and the target.
 */
export class ProxyTunnelError extends Error {
	/**
	 * @param {"proxy-refused" | "proxy-auth-required" | "proxy-upstream" | "proxy-protocol" | "proxy-closed" | "proxy-unreachable" | "proxy-timeout"} code
	 * @param {string} message
	 * @param {{ proxy: string, target: string, permanent: boolean, status?: number, cause?: unknown }} details
	 */
	constructor(code, message, details) {
		super(message, details.cause === undefined ? undefined : { cause: details.cause });
		this.name = "ProxyTunnelError";
		this.code = code;
		this.proxy = details.proxy;
		this.target = details.target;
		this.permanent = details.permanent;
		if (details.status !== undefined) this.status = details.status;
	}
}

/** A proxy's status text, as a failure may repeat it: printable ASCII, bounded. */
function reasonText(/** @type {string} */ text) {
	return text.replace(/[^\x20-\x7e]/g, "").trim().slice(0, MAX_REASON_LENGTH);
}

/**
 * How a failure names the certificate TLS verification refused with `cause`, or undefined: its code, and for
 * `UNSPECIFIED`, which says nothing on its own, the reason too.
 */
function tlsVerificationCode(/** @type {unknown} */ cause) {
	const { code, message } = /** @type {{ code?: unknown, message?: unknown }} */ (cause ?? {});
	const reason = typeof message === "string" ? message.trim() : "";
	if (typeof code !== "string" || !isRefusedCertificate(code, reason)) return undefined;
	return code === "UNSPECIFIED" && reason !== "" ? `${code}: ${reason}` : code;
}

/**
 * Opens a connection to `proxy` and asks it, with `CONNECT`, for a tunnel to `target`. Resolves with the connection
 * once the proxy answers 2xx, carrying only the target's bytes from then on; rejects with a `ProxyTunnelError` when the
 * proxy cannot be reached, refuses, does not answer HTTP, or does not answer within `timeoutMs`.
 * @param {HttpProxy} proxy
 * @param {ProxyTarget} target
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<import("node:net").Socket>}
 */
export function openProxyTunnel(proxy, target, options = {}) {
	const timeoutMs = options.timeoutMs ?? PROXY_ANSWER_TIMEOUT_MS;
	const authority = authorityOf(target);
	return new Promise((resolve, reject) => {
		const socket =
			proxy.protocol === "https:"
				? connectTls({
						host: proxy.host,
						port: proxy.port,
						...(isIP(proxy.host) === 0 ? { servername: proxy.host } : {}),
						ALPNProtocols: ["http/1.1"],
					})
				: connectNet({ host: proxy.host, port: proxy.port });
		let connected = false;
		let settled = false;
		let answerBytes = 0;
		let line = "";
		let afterCR = false;
		/** @type {RegExpExecArray | null} */
		let status = null;
		/**
		 * @param {ConstructorParameters<typeof ProxyTunnelError>[0]} code
		 * @param {string} message
		 * @param {boolean} permanent
		 * @param {{ status?: number, cause?: unknown }} [extra]
		 */
		const fail = (code, message, permanent, extra = {}) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			reject(new ProxyTunnelError(code, message, { proxy: proxy.label, target: authority, permanent, ...extra }));
		};
		const timer = setTimeout(
			() =>
				connected
					? fail(
							"proxy-timeout",
							`the proxy ${proxy.label} did not answer the tunnel request to ${authority} within ${timeoutMs} ms`,
							false,
						)
					: // No connection to the proxy at all, as at an address that drops packets: nothing was asked yet.
						fail(
							"proxy-unreachable",
							`the proxy ${proxy.label} could not be reached for the tunnel to ${authority} (no connection within ${timeoutMs} ms)`,
							false,
						),
			timeoutMs,
		);
		socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", () => {
			connected = true;
			socket.write(
				`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${
					proxy.authorization === undefined ? "" : `Proxy-Authorization: ${proxy.authorization}\r\n`
				}\r\n`,
			);
		});
		socket.on("error", (/** @type {Error} */ cause) => {
			const tls = tlsVerificationCode(cause);
			// The proxy's certificate is checked against the CAs Node.js trusts, never the server's `sslrootcert` (#6112).
			if (tls !== undefined)
				return fail(
					"proxy-unreachable",
					`the proxy ${proxy.label} showed a TLS certificate that was not accepted (${tls}), so no tunnel to ${authority} was opened. The proxy's certificate is checked against the CAs Node.js trusts: if a private or corporate CA issued it, add that CA to NODE_EXTRA_CA_CERTS`,
					true,
					{ cause },
				);
			const code = /** @type {{ code?: unknown }} */ (cause).code;
			const detail = typeof code === "string" ? code : reasonText(cause.message);
			if (connected)
				return fail(
					"proxy-closed",
					`the connection to the proxy ${proxy.label} failed before it answered the tunnel request to ${authority} (${detail})`,
					false,
					{ cause },
				);
			fail(
				"proxy-unreachable",
				`the proxy ${proxy.label} could not be reached for the tunnel to ${authority} (${detail})`,
				false,
				{ cause },
			);
		});
		const invalidAnswer = () =>
			fail(
				"proxy-protocol",
				`the proxy ${proxy.label} answered the tunnel request to ${authority} with something other than HTTP`,
				true,
			);
		// A connection that ends after a CR was cut, as one that ends anywhere else in the answer is (#5670).
		socket.on("close", () => {
			fail(
				"proxy-closed",
				`the proxy ${proxy.label} closed the connection before answering the tunnel request to ${authority}`,
				false,
			);
		});
		/**
		 * @param {number} code
		 * @param {string} text
		 * @param {Buffer} rest Bytes after the final response in the same read.
		 */
		const finish = (code, text, rest) => {
			const reason = reasonText(text);
			const answered = reason === "" ? `${code}` : `${code} ${reason}`;
			if (code >= 200 && code < 300) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.off("data", onData);
				socket.removeAllListeners("error");
				socket.removeAllListeners("close");
				socket.pause();
				if (rest.length > 0) socket.unshift(rest);
				resolve(/** @type {import("node:net").Socket} */ (socket));
				return;
			}
			if (code === 407)
				return fail(
					"proxy-auth-required",
					`the proxy ${proxy.label} refused the tunnel to ${authority} without accepted credentials (${answered})`,
					true,
					{ status: code },
				);
			if (code >= 500)
				return fail(
					"proxy-upstream",
					`the proxy ${proxy.label} could not open the tunnel to ${authority} (${answered})`,
					false,
					{ status: code },
				);
			fail("proxy-refused", `the proxy ${proxy.label} refused the tunnel to ${authority} (${answered})`, true, {
				status: code,
			});
		};
		/** @param {Buffer} chunk */
		const onData = (chunk) => {
			for (let i = 0; i < chunk.length && answerBytes < MAX_PROXY_ANSWER_BYTES; i++) {
				answerBytes++;
				const byte = /** @type {number} */ (chunk[i]);
				if (afterCR && byte !== 0x0a) {
					// A CR that no LF follows: a space inside a header field (RFC 9112 2.2), but no status line holds one (#5670).
					if (status === null) return invalidAnswer();
					line += " ";
				}
				afterCR = byte === 0x0d;
				if (afterCR) {
					// Nor does `HTTP/`.
					if (status === null && line.length < 5) return invalidAnswer();
					continue;
				}
				if (byte !== 0x0a) {
					line += String.fromCharCode(byte);
					if (status === null && line.length <= 5 && !"HTTP/".startsWith(line)) return invalidAnswer();
					continue;
				}
				if (status === null) {
					status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(line);
					if (status === null) return invalidAnswer();
				} else if (line === "") {
					const code = Number(status[1]);
					// 101 switches protocols instead of continuing to a final CONNECT response.
					if (code < 100 || code === 101 || code >= 200)
						return finish(code, status[2] ?? "", chunk.subarray(i + 1));
					status = null;
				}
				line = "";
			}
			if (answerBytes === MAX_PROXY_ANSWER_BYTES)
				fail(
					"proxy-protocol",
					`the proxy ${proxy.label} exceeded ${MAX_PROXY_ANSWER_BYTES} bytes of response headers for the tunnel to ${authority}`,
					true,
				);
		};
		socket.on("data", onData);
	});
}

/**
 * The stream pg is given for a connection opened by `open`, such as a proxy tunnel: pg calls `connect(port, host)` on it
 * as on a socket, and it emits `connect` once `open` resolved with a stream to the server, then carries pg's bytes,
 * TLS included, to and from that stream. A failure of `open` is the stream's error.
 */
export class OpenedSocket extends Duplex {
	/** @param {PostgresSocketFactory} open */
	constructor(open) {
		super({ allowHalfOpen: false });
		/** @type {PostgresSocketFactory} */
		this.open = open;
		/** @type {import("node:stream").Duplex | undefined} */
		this.inner = undefined;
		/** Whether a connection is being opened, as a socket says it. */
		this.connecting = false;
		/** @type {[Buffer | string, BufferEncoding, (error?: Error | null) => void][]} */
		this.waiting = [];
		/** @type {boolean | undefined} */
		this.noDelay = undefined;
		/** @type {[boolean, number | undefined] | undefined} */
		this.keepAlive = undefined;
		this.referenced = true;
	}

	/**
	 * @param {number | string} port
	 * @param {string} [host]
	 */
	connect(port, host) {
		this.connecting = true;
		const target = { host: host ?? "localhost", port: Number(port) };
		Promise.resolve()
			.then(() => this.open(target))
			.then(
				(inner) => {
					if (this.destroyed) {
						inner.destroy();
						return;
					}
					this.attach(inner);
				},
				(/** @type {Error} */ error) => this.destroy(error),
			);
		return this;
	}

	/** @param {import("node:stream").Duplex} inner */
	attach(inner) {
		this.inner = inner;
		const socket = /** @type {Partial<import("node:net").Socket>} */ (inner);
		if (this.noDelay !== undefined) socket.setNoDelay?.(this.noDelay);
		if (this.keepAlive !== undefined) socket.setKeepAlive?.(...this.keepAlive);
		if (!this.referenced) socket.unref?.();
		inner.on("data", (/** @type {Buffer} */ chunk) => {
			if (!this.push(chunk)) inner.pause();
		});
		inner.on("end", () => this.push(null));
		inner.on("error", (/** @type {Error} */ error) => this.destroy(error));
		inner.on("close", () => {
			if (!this.destroyed) this.destroy();
		});
		inner.resume();
		this.connecting = false;
		for (const [chunk, encoding, callback] of this.waiting.splice(0)) inner.write(chunk, encoding, callback);
		this.emit("connect");
		this.emit("ready");
	}

	_read() {
		this.inner?.resume();
	}

	/**
	 * @param {Buffer | string} chunk
	 * @param {BufferEncoding} encoding
	 * @param {(error?: Error | null) => void} callback
	 */
	_write(chunk, encoding, callback) {
		if (this.inner === undefined) this.waiting.push([chunk, encoding, callback]);
		else this.inner.write(chunk, encoding, callback);
	}

	/** @param {(error?: Error | null) => void} callback */
	_final(callback) {
		if (this.inner === undefined) return callback();
		this.inner.end(callback);
	}

	/**
	 * @param {Error | null} error
	 * @param {(error?: Error | null) => void} callback
	 */
	_destroy(error, callback) {
		this.inner?.destroy();
		for (const [, , waiting] of this.waiting.splice(0)) waiting(error ?? new Error("The connection closed"));
		// A TLS session on this stream that ends it, as when the server's certificate was refused, reports why on its
		// next tick: this stream closes after that, so pg sees the reason before the end, as it does on a socket.
		setImmediate(() => callback(error));
	}

	/** @param {boolean} [noDelay] */
	setNoDelay(noDelay = true) {
		this.noDelay = noDelay;
		/** @type {Partial<import("node:net").Socket> | undefined} */ (this.inner)?.setNoDelay?.(noDelay);
		return this;
	}

	/**
	 * @param {boolean} [enable]
	 * @param {number} [initialDelay]
	 */
	setKeepAlive(enable = false, initialDelay) {
		this.keepAlive = [enable, initialDelay];
		/** @type {Partial<import("node:net").Socket> | undefined} */ (this.inner)?.setKeepAlive?.(enable, initialDelay);
		return this;
	}

	ref() {
		this.referenced = true;
		/** @type {Partial<import("node:net").Socket> | undefined} */ (this.inner)?.ref?.();
		return this;
	}

	unref() {
		this.referenced = false;
		/** @type {Partial<import("node:net").Socket> | undefined} */ (this.inner)?.unref?.();
		return this;
	}
}

/**
 * The function that opens a connection to a target through `transport`, or undefined for a direct connection, which
 * pg opens itself.
 * @param {PostgresTransport} transport
 * @returns {PostgresSocketFactory | undefined}
 */
export function socketOpener(transport) {
	if (transport.kind === "direct") return undefined;
	const { proxy } = transport;
	return (target) => openProxyTunnel(proxy, target);
}
