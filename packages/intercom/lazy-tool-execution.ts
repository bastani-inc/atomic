import type { ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@bastani/atomic";

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
	const handle = await loadHeavy(args[4]);
	handle.assertCurrent();
	const tool = handle.heavy.tools.get(name);
	if (!tool?.execute) throw new Error(`Intercom tool implementation not found: ${name}`);
	const result = await tool.execute(...args);
	handle.assertCurrent();
	return result as Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>;
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
