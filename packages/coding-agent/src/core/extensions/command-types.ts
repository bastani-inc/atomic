import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { SourceInfo } from "../source-info.ts";
import type { ExtensionCommandContext } from "./context-types.ts";

export interface RegisteredCommand {
	name: string;
	sourceInfo: SourceInfo;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ResolvedCommand extends RegisteredCommand {
	invocationName: string;
}
