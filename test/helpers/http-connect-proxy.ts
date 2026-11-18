import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";

/**
 * An HTTP proxy that opens `CONNECT` tunnels, as a sandbox's egress proxy does (#5473): it answers each request from
 * `routes`, which maps the requested `host:port` to the address it really connects to (undefined: refused with 403, as
 * an allow-list refuses a target it does not list), and records what each tunnel's client sent, so a test can tell
 * ciphertext from a plaintext protocol. `refuse` answers a request with a status of its choice instead, and
 * `credentials` makes it ask for them (407) when a request does not carry them.
 */
export interface ConnectProxyOptions {
	readonly routes: (target: string) => { readonly host: string; readonly port: number } | undefined;
	readonly refuse?: (target: string) => number | undefined;
	readonly credentials?: { readonly user: string; readonly password: string };
	/** How long the proxy waits before it answers a tunnel it opens, as a slow proxy or a long network path does. */
	readonly answerDelayMs?: number;
	/** Whether a tunnel to `target` is answered 200 and then gets nothing, as a server that stopped answering. */
	readonly blackHole?: (target: string) => boolean;
}

export interface ConnectProxyTunnel {
	readonly target: string;
	/** Every byte the client sent through the tunnel so far. */
	clientBytes(): Buffer;
	/** Every byte the target sent back through the tunnel so far. */
	serverBytes(): Buffer;
	/** Whether the client closed its end of the tunnel. */
	clientClosed(): boolean;
}

export interface ConnectProxy {
	readonly port: number;
	/** `http://127.0.0.1:<port>`. */
	readonly url: string;
	/** Every `CONNECT` request, in order, with the `Proxy-Authorization` it carried. */
	readonly requests: { readonly target: string; readonly authorization: string | undefined }[];
	/** Every tunnel the proxy opened, in order. */
	readonly tunnels: ConnectProxyTunnel[];
	/** Ends every open tunnel to `target` (every tunnel when omitted), as a dropped network path would. */
	dropTunnels(target?: string): void;
	close(): Promise<void>;
}

const STATUS_TEXT: Record<number, string> = {
	403: "Forbidden",
	407: "Proxy Authentication Required",
	502: "Bad Gateway",
	503: "Service Unavailable",
};

export async function startConnectProxy(options: ConnectProxyOptions): Promise<ConnectProxy> {
	const requests: { target: string; authorization: string | undefined }[] = [];
	const tunnels: ConnectProxyTunnel[] = [];
	const open = new Map<Socket, string>();
	const sockets = new Set<Socket>();
	const track = (socket: Socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		return socket;
	};
	const answer = (client: Socket, status: number) => {
		client.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Refused"}\r\nContent-Length: 0\r\n\r\n`);
	};
	const server = createHttpServer();
	server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
		track(client);
		const target = request.url ?? "";
		const authorization = request.headers["proxy-authorization"];
		requests.push({ target, authorization });
		const refused = options.refuse?.(target);
		if (refused !== undefined) return answer(client, refused);
		if (options.credentials !== undefined) {
			const expected = `Basic ${Buffer.from(`${options.credentials.user}:${options.credentials.password}`).toString("base64")}`;
			if (authorization !== expected) return answer(client, 407);
		}
		const route = options.routes(target);
		if (route === undefined) return answer(client, 403);
		if (options.blackHole?.(target) === true) {
			let closed = false;
			client.on("end", () => {
				closed = true;
			});
			client.on("close", () => {
				closed = true;
			});
			tunnels.push({
				target,
				clientBytes: () => Buffer.alloc(0),
				serverBytes: () => Buffer.alloc(0),
				clientClosed: () => closed,
			});
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			client.resume();
			return;
		}
		const chunks: Buffer[] = [];
		const answers: Buffer[] = [];
		const record = (chunk: Buffer) => chunks.push(Buffer.from(chunk));
		if (head.length > 0) record(head);
		const upstream = track(connect(route.port, route.host));
		upstream.once("error", () => answer(client, 502));
		upstream.once("connect", () => {
			upstream.removeAllListeners("error");
			upstream.on("error", () => client.destroy());
			tunnels.push({
				target,
				clientBytes: () => Buffer.concat(chunks),
				serverBytes: () => Buffer.concat(answers),
				clientClosed: () => client.destroyed || client.readableEnded,
			});
			open.set(client, target);
			client.on("close", () => {
				open.delete(client);
				upstream.destroy();
			});
			upstream.on("close", () => client.destroy());
			const establish = () => {
				if (client.destroyed) return;
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length > 0) upstream.write(head);
				client.on("data", (chunk: Buffer) => {
					record(chunk);
					upstream.write(chunk);
				});
				upstream.on("data", (chunk: Buffer) => {
					answers.push(Buffer.from(chunk));
					client.write(chunk);
				});
			};
			if (options.answerDelayMs === undefined) establish();
			else setTimeout(establish, options.answerDelayMs);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return {
		port: address.port,
		url: `http://127.0.0.1:${address.port}`,
		requests,
		tunnels,
		dropTunnels(target) {
			for (const [client, opened] of [...open]) if (target === undefined || opened === target) client.destroy();
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

/** A loopback port nothing listens on: a proxy address that refuses connections. */
export async function closedPort(): Promise<number> {
	const server = createHttpServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}
