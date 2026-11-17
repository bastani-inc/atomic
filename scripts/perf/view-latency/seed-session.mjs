/**
 * Seeds one long session in the default session store of `ATOMIC_CODING_AGENT_DIR`, through the built package's own
 * SessionManager so the entries are exactly what a real session writes.
 *
 *   node seed-session.mjs <dist-index.js> <cwd> <entries>
 *
 * Prints the new session id. The transcript repeats a four-entry turn (user prompt, assistant tool call, tool result,
 * assistant answer with Markdown) until it holds `entries` entries.
 */
import { pathToFileURL } from "node:url";

const [distIndex, cwd, entriesArg] = process.argv.slice(2);
const entries = Number(entriesArg);
const { SessionManager } = await import(pathToFileURL(distIndex).href);

const usage = {
	input: 1200,
	output: 180,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1380,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content) => ({
	role: "assistant",
	content,
	api: "openai-completions",
	provider: "viewlat",
	model: "viewlat-model",
	usage,
	stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
	timestamp: Date.now(),
});

const manager = await SessionManager.create(cwd);
let written = 0;
for (let turn = 0; written < entries; turn++) {
	const callId = `seed_call_${turn}`;
	const turnEntries = [
		{ role: "user", content: `Turn ${turn}: check the module and report what changed.`, timestamp: Date.now() },
		assistant([
			{ type: "text", text: `Reading the file for turn ${turn}.` },
			{ type: "toolCall", id: callId, name: "read", arguments: { path: `src/module-${turn % 50}.ts` } },
		]),
		{
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [
				{
					type: "text",
					text: Array.from(
						{ length: 8 },
						(_, line) => `${line + 1}\texport const value${line} = compute(${turn}, ${line});`,
					).join("\n"),
				},
			],
			isError: false,
			timestamp: Date.now(),
		},
		assistant([
			{
				type: "text",
				text: [
					`### Turn ${turn}`,
					"",
					`The module exports **eight values**; \`value${turn % 8}\` changed since the last turn.`,
					"",
					"- the first item of a short list",
					"- a second item that is long enough to wrap in a narrow terminal pane",
					"",
					"```ts",
					`const result = compute(${turn});`,
					"```",
				].join("\n"),
			},
		]),
	];
	for (const message of turnEntries) {
		if (written >= entries) break;
		await manager.appendMessage(message);
		written++;
	}
}
process.stdout.write(`${manager.getSessionId()}\n`);
await manager.getSessionStore?.().close?.();
process.exit(0);
