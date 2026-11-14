import { createServer, type Server, Socket } from "node:net";

/** A TCP proxy to `target` that can cut every connection and refuse new ones, as a database a network away goes away. */
export async function startOutageProxy(target: URL): Promise<{
	readonly url: string;
	cut(): void;
	restore(): void;
	close(): Promise<void>;
}> {
	const sockets = new Set<Socket>();
	let down = false;
	const server: Server = createServer((client) => {
		if (down) return void client.resetAndDestroy();
		const upstream = new Socket();
		sockets.add(client).add(upstream);
		upstream.connect(Number(target.port), target.hostname);
		client.pipe(upstream).pipe(client);
		for (const socket of [client, upstream]) {
			socket.on("error", () => {
				client.destroy();
				upstream.destroy();
			});
			socket.on("close", () => sockets.delete(socket));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Outage proxy has no port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		cut() {
			down = true;
			for (const socket of sockets) socket.resetAndDestroy();
		},
		restore() {
			down = false;
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
