import type { ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@bastani/atomic";
import { setTimeout as delay } from "node:timers/promises";
import { isIntercomBrokerTimeout, isRecoverableIntercomDisconnect } from "./recoverable-disconnect.js";
import { RECONNECT_DELAYS_MS } from "./retry-policy.js";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
type ExecutableHeavy = {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, { handler: CommandHandler }>;
};

export type HeavyHandle<THeavy extends ExecutableHeavy> = {
	heavy: THeavy;
	assertCurrent: () => void;
};

export async function executeHeavyTool<THeavy extends ExecutableHeavy>(
	loadHeavy: (ctx?: ExtensionContext) => Promise<HeavyHandle<THeavy>>,
	name: string,
	args: Parameters<NonNullable<ToolDefinition["execute"]>>,
): Promise<Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>> {
	// Loading/replaying startup precedes tool execution and cannot have sent the
	// requested message. Retry only that boundary, never an executed heavy call.
	const params = args[1] as { action?: string };
	const recoverInitialization = name === "intercom" && ["send", "ask", "reply"].includes(params.action ?? "");
	let handle: HeavyHandle<THeavy>;
	let retries = 0;
	for (;;) {
		if (recoverInitialization && args[2]?.aborted) return initializationFailure("Cancelled", retries);
		try {
			handle = await loadHeavy(args[4]);
			break;
		} catch (error) {
			if (!recoverInitialization || !isRecoverableIntercomDisconnect(error)) throw error;
			const delayMs = RECONNECT_DELAYS_MS[retries];
			if (delayMs === undefined) {
				return initializationFailure(isIntercomBrokerTimeout(error) ? "Connection timeout" : "Client disconnected", retries);
			}
			try {
				await delay(delayMs, undefined, { signal: args[2] });
			} catch {
				return initializationFailure("Cancelled", retries);
			}
			retries += 1;
		}
	}
	handle.assertCurrent();
	const tool = handle.heavy.tools.get(name);
	if (!tool?.execute) throw new Error(`Intercom tool implementation not found: ${name}`);
	const result = await tool.execute(...args);
	handle.assertCurrent();
	return result as Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>;
}

function initializationFailure(reason: string, retries: number) {
	return {
		content: [{ type: "text" as const, text: `${reason}. Intercom initialization stopped after ${retries} automatic retries. This operation was not sent.` }],
		isError: true,
		details: { error: true, terminal: true, automaticRetries: retries, outcome: "not_sent" },
	};
}

export async function runHeavyCommand<THeavy extends ExecutableHeavy>(
	loadHeavy: (ctx?: ExtensionContext) => Promise<HeavyHandle<THeavy>>,
	args: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const handle = await loadHeavy(ctx);
	handle.assertCurrent();
	const command = handle.heavy.commands.get("intercom");
	if (!command) throw new Error("Intercom command implementation not found");
	await command.handler(args ?? "", ctx);
	handle.assertCurrent();
}
