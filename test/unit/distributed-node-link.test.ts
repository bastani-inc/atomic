import assert from "node:assert/strict";
import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, test } from "vitest";
import { NodeLink } from "../distributed/harness/proxy.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A server that echoes every byte back, as a stand-in for the database at the far end of a node's link. */
async function echoServer(): Promise<number> {
	const sockets: Socket[] = [];
	const server: Server = createServer((socket) => {
		sockets.push(socket);
		socket.pipe(socket);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return address.port;
}

async function client(port: number): Promise<{ socket: Socket; received: () => string; closed: () => boolean }> {
	const socket = connect(port, "127.0.0.1");
	let received = "";
	let closed = false;
	socket.on("data", (chunk) => {
		received += chunk.toString();
	});
	socket.on("close", () => {
		closed = true;
	});
	socket.on("error", () => {});
	await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	cleanups.push(() => {
		socket.destroy();
	});
	return { socket, received: () => received, closed: () => closed };
}

async function until(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function link(): Promise<NodeLink> {
	const opened = await NodeLink.open("127.0.0.1", await echoServer());
	cleanups.push(() => opened.close());
	return opened;
}

test("a partitioned link moves nothing either way, and delivers what it held, in order, once it heals", async () => {
	const path = await link();
	const end = await client(path.port);
	end.socket.write("before ");
	await until(() => end.received() === "before ", "the echo before the partition");
	path.partition();
	end.socket.write("one ");
	end.socket.write("two");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(end.received(), "before ");
	assert.equal(end.closed(), false, "a partition does not close connections");
	path.heal();
	await until(() => end.received() === "before one two", "the held bytes");
});

test("a connection opened during a partition goes through once it heals", async () => {
	const path = await link();
	path.partition();
	const late = await client(path.port);
	late.socket.write("late");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(late.received(), "");
	path.heal();
	await until(() => late.received() === "late", "the late connection's echo");
	assert.equal(path.connections, 1);
});

test("a delayed link adds its latency each way", async () => {
	const path = await link();
	const end = await client(path.port);
	path.delay(150);
	const started = performance.now();
	end.socket.write("slow");
	await until(() => end.received() === "slow", "the delayed echo");
	assert.ok(performance.now() - started >= 290, `the round trip took ${performance.now() - started} ms`);
});

test("a reset ends the open connections and lets new ones through", async () => {
	const path = await link();
	const first = await client(path.port);
	await until(() => path.connections === 1, "the link to accept the connection");
	path.reset();
	await until(() => first.closed(), "the reset connection to close");
	const second = await client(path.port);
	second.socket.write("again");
	await until(() => second.received() === "again", "a new connection's echo");
});
