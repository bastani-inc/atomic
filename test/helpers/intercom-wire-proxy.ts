import { mkdirSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { createMessageReader, type JsonWireValue, writeMessage } from "../../packages/intercom/broker/framing.js";

export type WireFrame = { readonly type: string } & { readonly [key: string]: JsonWireValue };

export interface ObservedFrame {
	readonly connection: number;
	readonly frame: WireFrame;
}

type FirstFrameMatcher = (first: WireFrame) => boolean;

/**
 * A byte-forwarding front for a real broker, standing in for the broker's own socket path.
 *
 * Everything a client sends reaches the real broker unchanged, so the broker's work is real; the proxy only
 * observes it by frame type. It can also hold a connection whose first frame matches: the socket is accepted and
 * its frames are buffered, but the broker never sees it. That is what a broker with a backlogged event loop looks
 * like from a client, and unlike pausing the process it needs no signals, no sleeping, and works on every platform.
 */
export class IntercomWireProxy {
	readonly toBroker: ObservedFrame[] = [];
	readonly toClients: ObservedFrame[] = [];
	private holdMatcher: FirstFrameMatcher | undefined;
	private brokerToClientTransform: ((frame: WireFrame) => WireFrame | undefined) | undefined;
	private readonly connections = new Set<ProxyConnection>();
	private nextConnection = 1;
	private readonly server = net.createServer((socket) => {
		this.connections.add(new ProxyConnection(this.nextConnection++, socket, this));
	});

	constructor(
		private readonly listenPath: string,
		readonly brokerPath: string,
	) {}

	async listen(): Promise<void> {
		if (process.platform !== "win32") mkdirSync(dirname(this.listenPath), { recursive: true });
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.listenPath, () => resolve());
		});
	}

	async close(): Promise<void> {
		for (const connection of this.connections) connection.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	/** Hold every new connection whose first frame matches, until `release()`. */
	hold(matches: FirstFrameMatcher): void {
		this.holdMatcher = matches;
	}

	/** Stop holding and let every held connection through to the broker. */
	release(): void {
		this.holdMatcher = undefined;
		for (const connection of this.connections) connection.releaseIfHeld();
	}

	/** Rewrite frames the broker sends, e.g. to drop a capability an older broker would not advertise. */
	transformBrokerFrames(transform: ((frame: WireFrame) => WireFrame | undefined) | undefined): void {
		this.brokerToClientTransform = transform;
	}

	/** Close every connection whose first frame matches, as a broker or client dropping it would. */
	disconnect(matches: FirstFrameMatcher): number {
		let closed = 0;
		for (const connection of this.connections) {
			const first = connection.firstFrame();
			if (first === undefined || !matches(first)) continue;
			connection.destroy();
			closed += 1;
		}
		return closed;
	}

	heldConnections(): number {
		let held = 0;
		for (const connection of this.connections) if (connection.isHeld()) held += 1;
		return held;
	}

	/** Connections still open whose first frame matches. */
	openConnections(matches: FirstFrameMatcher): number {
		let open = 0;
		for (const connection of this.connections) {
			const first = connection.firstFrame();
			if (first !== undefined && matches(first)) open += 1;
		}
		return open;
	}

	countToBroker(type: string): number {
		return this.toBroker.filter(({ frame }) => frame.type === type).length;
	}

	countToClients(type: string): number {
		return this.toClients.filter(({ frame }) => frame.type === type).length;
	}

	matchesHold(first: WireFrame): boolean {
		return this.holdMatcher?.(first) === true;
	}

	transformForClient(frame: WireFrame): WireFrame | undefined {
		return this.brokerToClientTransform ? this.brokerToClientTransform(frame) : frame;
	}

	forget(connection: ProxyConnection): void {
		this.connections.delete(connection);
	}
}

class ProxyConnection {
	private state: "undecided" | "held" | "forwarding" | "closed" = "undecided";
	private buffered: Buffer[] = [];
	private heldFrames: WireFrame[] = [];
	private upstream: net.Socket | undefined;
	private first: WireFrame | undefined;

	constructor(
		private readonly id: number,
		private readonly client: net.Socket,
		private readonly proxy: IntercomWireProxy,
	) {
		const reader = createMessageReader(
			(message) => this.observe(message as WireFrame),
			(error) => client.destroy(error),
		);
		client.on("data", (chunk) => {
			reader(chunk);
			if (this.state === "forwarding") this.upstream?.write(chunk);
			else if (this.state !== "closed") this.buffered.push(chunk);
		});
		client.on("close", () => this.destroy());
		client.on("error", () => {});
	}

	firstFrame(): WireFrame | undefined {
		return this.first;
	}

	isHeld(): boolean {
		return this.state === "held";
	}

	releaseIfHeld(): void {
		if (this.state === "held") this.startForwarding();
	}

	destroy(): void {
		if (this.state === "closed") return;
		this.state = "closed";
		this.buffered = [];
		this.heldFrames = [];
		this.client.destroy();
		this.upstream?.destroy();
		this.proxy.forget(this);
	}

	private observe(frame: WireFrame): void {
		this.first ??= frame;
		if (this.state === "undecided") {
			if (this.proxy.matchesHold(frame)) this.state = "held";
			else this.startForwarding();
		}
		if (this.state === "held") this.heldFrames.push(frame);
		else this.proxy.toBroker.push({ connection: this.id, frame });
	}

	private startForwarding(): void {
		const upstream = net.createConnection(this.proxy.brokerPath);
		this.upstream = upstream;
		this.state = "forwarding";
		for (const frame of this.heldFrames.splice(0)) this.proxy.toBroker.push({ connection: this.id, frame });
		const reader = createMessageReader(
			(message) => {
				const frame = message as WireFrame;
				this.proxy.toClients.push({ connection: this.id, frame });
				const transformed = this.proxy.transformForClient(frame);
				if (!this.client.destroyed && transformed !== undefined) writeMessage(this.client, transformed);
			},
			(error) => upstream.destroy(error),
		);
		upstream.on("data", reader);
		upstream.on("close", () => this.destroy());
		upstream.on("error", () => {});
		for (const chunk of this.buffered.splice(0)) upstream.write(chunk);
	}
}
