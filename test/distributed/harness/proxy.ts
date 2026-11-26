import { connect, createServer, type Server, type Socket } from "node:net";

/**
 * A node's network path to one database endpoint: a loopback TCP proxy the harness can cut or slow.
 *
 * - `partition()` holds every byte in both directions on the connections already open, and holds new connections
 *   unanswered, as a network partition does: nothing fails at once, TCP just stops moving. `heal()` delivers what
 *   was held, in order, and lets new connections through again.
 * - `delay(ms)` adds latency to every chunk in both directions, as a distant or congested link does.
 */
export class NodeLink {
	private cut = false;
	private latencyMs = 0;
	private readonly sockets = new Set<Socket>();
	private readonly held: Array<() => void> = [];
	private accepted = 0;

	private constructor(
		private readonly server: Server,
		readonly port: number,
	) {}

	static async open(targetHost: string, targetPort: number): Promise<NodeLink> {
		let link: NodeLink | undefined;
		const server = createServer((client) => link?.accept(client, targetHost, targetPort));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("the node link has no TCP address");
		link = new NodeLink(server, address.port);
		return link;
	}

	/** Connections this link has accepted so far. */
	get connections(): number {
		return this.accepted;
	}

	get partitioned(): boolean {
		return this.cut;
	}

	partition(): void {
		this.cut = true;
	}

	heal(): void {
		this.cut = false;
		for (const send of this.held.splice(0)) send();
	}

	delay(ms: number): void {
		this.latencyMs = ms;
	}

	/** Ends every open connection at once, as a reset link does. New connections go through. */
	reset(): void {
		for (const socket of this.sockets) socket.destroy();
	}

	async close(): Promise<void> {
		this.held.length = 0;
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private accept(client: Socket, targetHost: string, targetPort: number): void {
		this.accepted++;
		this.sockets.add(client);
		client.on("close", () => this.sockets.delete(client));
		client.on("error", () => client.destroy());
		const open = () => {
			if (client.destroyed) return;
			const upstream = connect(targetPort, targetHost);
			this.sockets.add(upstream);
			upstream.on("close", () => this.sockets.delete(upstream));
			this.relay(client, upstream);
			this.relay(upstream, client);
		};
		if (this.cut) this.held.push(open);
		else open();
	}

	private relay(from: Socket, to: Socket): void {
		// Chunks leave in the order they came, whatever the latency or partition does to their timing.
		let chain = Promise.resolve();
		from.on("data", (chunk) => {
			const latency = this.latencyMs;
			chain = chain.then(async () => {
				if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
				const send = () => {
					if (!to.destroyed) to.write(chunk);
				};
				if (this.cut) this.held.push(send);
				else send();
			});
		});
		// A close crosses a partition no sooner than the data before it.
		from.on("close", () => {
			chain = chain.then(() => {
				if (this.cut) this.held.push(() => to.destroy());
				else to.destroy();
			});
		});
		from.on("error", () => to.destroy());
	}
}
