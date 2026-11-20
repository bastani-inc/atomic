import type { Duplex } from "node:stream";

/** A connection's target: the endpoint pg connects to, the URL's host and port, else `PGHOST` and `PGPORT`. */
export interface ProxyTarget {
	readonly host: string;
	readonly port: number;
}

/**
 * Opens a connection that carries the PostgreSQL protocol to `target`, for a custom transport. The adapter negotiates
 * TLS over it with the server, checking the certificate against `target.host`, as it does over a socket.
 */
export type PostgresSocketFactory = (target: ProxyTarget) => Duplex | Promise<Duplex>;

/** How long a proxy may take to accept a connection and answer its tunnel request, in milliseconds. */
export const PROXY_ANSWER_TIMEOUT_MS: 8000;

/**
 * The codes of a certificate TLS verification refused, for a server's certificate and an https proxy's: a connection
 * that fails with one is not retried.
 */
export const TLS_VERIFICATION_CODES: ReadonlySet<string>;

/**
 * Whether a `NO_PROXY` value exempts `host` on `port`, as Atomic's HTTPS clients decide it: entries separated by commas
 * or white space; a host matches itself and its subdomains, `*.name` only subdomains, `*` every host; an entry with a
 * port matches that port only.
 */
export function noProxyMatches(host: string, port: number, value: string): boolean;

/**
 * The environment's proxy for a connection to PostgreSQL and the variable it came from: `https_proxy` or `HTTPS_PROXY`,
 * then `all_proxy` or `ALL_PROXY` when it names an HTTP proxy, then `http_proxy` or `HTTP_PROXY`.
 */
export function proxySetting(env: {
	readonly [name: string]: string | undefined;
}): { readonly variable: string; readonly value: string } | undefined;

/** An HTTP proxy a setting names; `label` names it without credentials. */
export interface HttpProxy {
	readonly protocol: "http:" | "https:";
	readonly host: string;
	readonly port: number;
	readonly label: string;
	readonly authorization?: string;
}

export type PostgresTransport = { readonly kind: "direct" } | { readonly kind: "proxy"; readonly proxy: HttpProxy };

/** A proxy setting that cannot be used; the message names where it came from, never its value. */
export class ProxySettingError extends Error {
	constructor(subject: string, problem: string);
}

/** The proxy a setting names: an `http:` or `https:` URL, or a bare `host:port`, read as `http:`. */
export function parseProxy(value: string, subject: string): HttpProxy;

/**
 * Whether `host` is this machine: a socket directory, a loopback name or a loopback address, in any spelling a URL or
 * the resolver reads as one, such as `127.1`, `localhost.` or `::ffff:127.0.0.1`.
 */
export function isLocalTarget(host: string): boolean;

/**
 * How a connection to `target` is opened: through the proxy `option` names (`"none"`: directly), else through the
 * environment's proxy unless `NO_PROXY` exempts the target; a socket directory or loopback target is reached directly.
 */
export function postgresTransport(
	target: ProxyTarget,
	env: { readonly [name: string]: string | undefined },
	option?: string,
): PostgresTransport;

/** `host:port` as a tunnel request names it, with an IPv6 address in brackets. */
export function authorityOf(target: ProxyTarget): string;

export type ProxyTunnelErrorCode =
	| "proxy-refused"
	| "proxy-auth-required"
	| "proxy-upstream"
	| "proxy-protocol"
	| "proxy-closed"
	| "proxy-unreachable"
	| "proxy-timeout";

/** A tunnel a proxy did not open; `permanent` when asking again would not change the answer. */
export class ProxyTunnelError extends Error {
	readonly code: ProxyTunnelErrorCode;
	/** The proxy, without credentials. */
	readonly proxy: string;
	/** The `host:port` the tunnel was asked for. */
	readonly target: string;
	readonly permanent: boolean;
	readonly status?: number;
	constructor(
		code: ProxyTunnelErrorCode,
		message: string,
		details: { proxy: string; target: string; permanent: boolean; status?: number; cause?: unknown },
	);
}

/** Asks `proxy` for a `CONNECT` tunnel to `target`; resolves with the connection once the proxy answers 2xx. */
export function openProxyTunnel(
	proxy: HttpProxy,
	target: ProxyTarget,
	options?: { timeoutMs?: number },
): Promise<import("node:net").Socket>;

/** The stream pg is given for a connection `open` opens: it emits `connect` once `open` resolved. */
export class OpenedSocket extends Duplex {
	constructor(open: PostgresSocketFactory);
	connect(port: number | string, host?: string): this;
	setNoDelay(noDelay?: boolean): this;
	setKeepAlive(enable?: boolean, initialDelay?: number): this;
	ref(): this;
	unref(): this;
}

/** The function that opens connections through `transport`, or undefined for a direct connection pg opens itself. */
export function socketOpener(transport: PostgresTransport): PostgresSocketFactory | undefined;
