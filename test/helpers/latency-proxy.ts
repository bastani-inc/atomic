import { createServer, type Server, Socket } from "node:net";

export interface LatencyProxy {
	/** `http://127.0.0.1:<port>`: the server's address as clients reach it through the proxy. */
	readonly url: string;
	close(): Promise<void>;
}

/**
 * A TCP proxy that holds every chunk for `oneWayMs` before forwarding it, in each direction, so a request waits
 * about twice that for its answer. It stands in for a database a network away from a server on this machine. Chunks
 * keep their order, because timers of equal delay fire in the order they were set.
 */
export async function startLatencyProxy(target: URL, oneWayMs: number): Promise<LatencyProxy> {
	const sockets = new Set<Socket>();
	const forward = (from: Socket, to: Socket) => {
		from.on("data", (chunk) => {
			setTimeout(() => {
				if (!to.destroyed) to.write(chunk);
			}, oneWayMs);
		});
		from.on("end", () => setTimeout(() => to.end(), oneWayMs));
		from.on("error", () => to.destroy());
		from.on("close", () => to.destroy());
	};
	const server: Server = createServer((client) => {
		const upstream = new Socket();
		sockets.add(client).add(upstream);
		upstream.connect(Number(target.port), target.hostname);
		forward(client, upstream);
		forward(upstream, client);
		for (const socket of [client, upstream]) socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Latency proxy has no port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
