import { createInterface } from "node:readline";

const [mode, encodedStderr] = process.argv.slice(2);
const stderrText = JSON.parse(encodedStderr);

if (mode === "fail") {
	process.stderr.write(stderrText, () => process.exit(1));
} else {
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of lines) {
		const message = JSON.parse(line);
		if (!("id" in message)) continue;
		if (message.method === "tools/call") {
			process.stderr.write(stderrText, () => process.exit(0));
			continue;
		}
		const result =
			message.method === "initialize"
				? {
						protocolVersion: "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "stderr-fixture", version: "1.0.0" },
					}
				: { tools: [{ name: "die", inputSchema: { type: "object" } }] };
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
	}
}
