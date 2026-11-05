#!/usr/bin/env node
// @ts-check
/**
 * TLS front for sqld on a private database VM. sqld's HTTP listener is plain TCP, so it listens on loopback only and
 * this gateway terminates TLS with the run CA's host certificate on the VM's private address, forwarding each request
 * unchanged (authentication stays sqld's JWT check). It logs counts, never headers or bodies.
 *
 *   node gateway.mjs --listen <ip>:<port> --upstream 127.0.0.1:<port> --cert <file> --key <file> [--stats <file>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

/** @type {Record<string, string>} */
const flags = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 2) flags[argv[index].replace(/^--/, "")] = argv[index + 1];
const [listenHost, listenPort] = splitAddress(flags.listen);
const [upstreamHost, upstreamPort] = splitAddress(flags.upstream);

/** @param {string | undefined} address */
function splitAddress(address) {
	const at = address?.lastIndexOf(":") ?? -1;
	if (address === undefined || at < 1) throw new TypeError("gateway needs --listen and --upstream as <host>:<port>");
	return /** @type {const} */ ([address.slice(0, at), Number(address.slice(at + 1))]);
}

const stats = { requests: 0, upstreamErrors: 0, tlsErrors: 0, startedAt: new Date().toISOString() };
const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
const server = https.createServer(
	{ cert: readFileSync(flags.cert), key: readFileSync(flags.key), minVersion: "TLSv1.2" },
	(request, response) => {
		stats.requests++;
		const upstream = http.request(
			{
				host: upstreamHost,
				port: upstreamPort,
				method: request.method,
				path: request.url,
				headers: request.headers,
				agent,
			},
			(answer) => {
				response.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(response);
			},
		);
		upstream.on("error", () => {
			stats.upstreamErrors++;
			if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
			response.end("upstream unavailable");
		});
		request.pipe(upstream);
	},
);
server.on("tlsClientError", () => {
	stats.tlsErrors++;
});
if (flags.stats !== undefined) {
	const statsFile = flags.stats;
	setInterval(() => writeFileSync(statsFile, `${JSON.stringify(stats)}\n`), 1000).unref();
}
server.listen(listenPort, listenHost, () => {
	process.stdout.write(`${JSON.stringify({ event: "listening", host: listenHost, port: listenPort })}\n`);
});
