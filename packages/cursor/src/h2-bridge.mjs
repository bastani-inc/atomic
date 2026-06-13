#!/usr/bin/env node
/**
 * HTTP/2 bridge for Cursor's private gRPC/Connect API.
 *
 * Derived from ndraiman/pi-cursor-provider's MIT-licensed h2-bridge.mjs.
 * Bun's node:http2 implementation has live interoperability issues with
 * api2.cursor.sh, so Atomic keeps Cursor HTTP/2 traffic in a Node child and
 * exchanges raw request/response chunks over length-prefixed stdio frames.
 */
import http2 from "node:http2";

function writeMessage(data) {
	const payload = Buffer.from(data);
	const len = Buffer.alloc(4);
	len.writeUInt32BE(payload.length, 0);
	process.stdout.write(len);
	process.stdout.write(payload);
}

let stdinBuffer = Buffer.alloc(0);
let stdinResolve;
let stdinEnded = false;

process.stdin.on("data", (chunk) => {
	stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
	if (stdinResolve) {
		const resolve = stdinResolve;
		stdinResolve = undefined;
		resolve();
	}
});

process.stdin.on("end", () => {
	stdinEnded = true;
	if (stdinResolve) {
		const resolve = stdinResolve;
		stdinResolve = undefined;
		resolve();
	}
});

function waitForData() {
	return new Promise((resolve) => {
		stdinResolve = resolve;
	});
}

async function readExact(length) {
	while (stdinBuffer.length < length) {
		if (stdinEnded) return null;
		await waitForData();
	}
	const output = stdinBuffer.subarray(0, length);
	stdinBuffer = stdinBuffer.subarray(length);
	return Buffer.from(output);
}

async function readMessage() {
	const len = await readExact(4);
	if (!len) return null;
	const length = len.readUInt32BE(0);
	if (length === 0) return Buffer.alloc(0);
	return readExact(length);
}

const configBytes = await readMessage();
if (!configBytes) process.exit(1);

const config = JSON.parse(configBytes.toString("utf8"));
const baseUrl = config.baseUrl || "https://api2.cursor.sh";
const path = config.path || "/agent.v1.AgentService/Run";
const unary = Boolean(config.unary);
const headers = config.headers && typeof config.headers === "object" ? config.headers : {};

const client = http2.connect(baseUrl);
let settled = false;
let timeout = setTimeout(killBridge, 30_000);

timeout.unref?.();

function resetTimeout() {
	clearTimeout(timeout);
	timeout = setTimeout(killBridge, 120_000);
	timeout.unref?.();
}

function killBridge() {
	if (settled) return;
	settled = true;
	client.destroy();
	process.exit(1);
}

client.on("error", () => killBridge());

const requestHeaders = {
	":method": "POST",
	":path": path,
	...headers,
};
const h2Stream = client.request(requestHeaders);

h2Stream.on("data", (chunk) => {
	resetTimeout();
	writeMessage(chunk);
});

h2Stream.on("end", () => {
	if (settled) return;
	settled = true;
	clearTimeout(timeout);
	client.close();
	setTimeout(() => process.exit(0), 50).unref?.();
});

h2Stream.on("error", () => killBridge());
h2Stream.on("aborted", () => killBridge());

if (unary) {
	const body = await readMessage();
	h2Stream.end(body && body.length > 0 ? body : undefined);
} else {
	void (async () => {
		while (true) {
			const message = await readMessage();
			if (!message || message.length === 0) break;
			if (!h2Stream.closed && !h2Stream.destroyed) {
				resetTimeout();
				h2Stream.write(message);
			}
		}
		if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.end();
	})();
}
