import type { ExtensionContext } from "../../src/core/extensions/context-types.ts";

// #2799: object literals written before this additive member must remain assignable.
type LegacyExtensionContext = Omit<ExtensionContext, "hasNonBuiltinExtensions">;
declare const legacyContext: LegacyExtensionContext;
const compatibleContext: ExtensionContext = legacyContext;
void compatibleContext;
