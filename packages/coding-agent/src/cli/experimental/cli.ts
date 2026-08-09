import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type AtomicCommandContext, atomicCommand } from "./commands/pi.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";

export type ExperimentalCliContext = AtomicCommandContext & ServerCommandContext & ClientCommandContext;

export const experimentalCli = atomicCommand.command(serverCommand).command(clientCommand);
