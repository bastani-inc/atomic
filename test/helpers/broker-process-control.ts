import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface BrokerProcessControl {
	readonly preloadUrl: string;
	stop(pid: number): Promise<void>;
	exited(pid: number): Promise<void>;
	close(): Promise<void>;
}

export async function createBrokerProcessControl(
	directory: string,
	shutdownTimeoutMs: number,
): Promise<BrokerProcessControl> {
	const token = randomUUID();
	const preloadPath = join(directory, `control-${token}.mjs`);
	const sockets = new Map<net.Socket, Promise<void>>();
	const processes = new Map<number, net.Socket>();
	let closing: Promise<void> | undefined;
	const server = net.createServer((socket) => {
		socket.on("error", () => {});
		sockets.set(
			socket,
			new Promise((resolve) => {
				socket.once("close", () => {
					sockets.delete(socket);
					for (const [pid, connection] of processes) if (connection === socket) processes.delete(pid);
					resolve();
				});
			}),
		);
		if (closing !== undefined) {
			socket.end("stop\n");
			return;
		}
		let handshake = "";
		const acceptHandshake = (chunk: Buffer) => {
			handshake += chunk.toString();
			if (!handshake.includes("\n")) return;
			socket.off("data", acceptHandshake);
			const [receivedToken, rawPid] = handshake.slice(0, handshake.indexOf("\n")).split(" ");
			const pid = Number(rawPid);
			if (receivedToken !== token || !Number.isSafeInteger(pid) || pid <= 0) {
				socket.destroy();
				return;
			}
			if (closing !== undefined) {
				socket.end("stop\n");
				return;
			}
			processes.set(pid, socket);
			socket.write(`ready ${token}\n`);
		};
		socket.on("data", acceptHandshake);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	assert.ok(address !== null && typeof address !== "string");
	const endpoint = { host: "127.0.0.1", port: address.port };
	const close = () => {
		closing ??= (async () => {
			const ended = new Promise<void>((resolve, reject) =>
				server.close((error) => (error === undefined ? resolve() : reject(error))),
			);
			for (const socket of sockets.keys()) socket.write("stop\n");
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					ended,
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error("broker control connections did not close")),
							shutdownTimeoutMs,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		})();
		return closing;
	};
	try {
		writeFileSync(
			preloadPath,
			[
				'import net from "node:net";',
				`const control = net.createConnection(${JSON.stringify(endpoint)});`,
				'const stop = () => process.kill(process.pid, "SIGKILL");',
				'control.on("error", stop);',
				'control.on("close", stop);',
				`control.setTimeout(${shutdownTimeoutMs}, stop);`,
				`control.on("connect", () => control.write(${JSON.stringify(`${token} `)} + process.pid + "\\n"));`,
				"await new Promise((resolve) => {",
				'  let input = "";',
				'  control.on("data", (chunk) => {',
				"    input += chunk.toString();",
				'    while (input.includes("\\n")) {',
				'      const end = input.indexOf("\\n");',
				"      const command = input.slice(0, end);",
				"      input = input.slice(end + 1);",
				`      if (command === ${JSON.stringify(`ready ${token}`)}) resolve(); else stop();`,
				"    }",
				"  });",
				"});",
				"control.setTimeout(0);",
				"control.unref();",
			].join("\n"),
		);
	} catch (error) {
		await close();
		throw error;
	}
	return {
		preloadUrl: pathToFileURL(preloadPath).href,
		async stop(pid) {
			const socket = processes.get(pid);
			assert.ok(socket !== undefined, `broker ${pid} has no control connection`);
			const ended = sockets.get(socket);
			socket.write("stop\n");
			await ended;
		},
		async exited(pid) {
			const socket = processes.get(pid);
			if (socket !== undefined) await sockets.get(socket);
		},
		close,
	};
}
