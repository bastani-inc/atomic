import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * The SDK schema's inferred result also includes task handles, while these
 * legacy adapter paths consume the terminal CallToolResult shape.
 */
export function asCallToolResult(result: object): CallToolResult {
  return result as CallToolResult;
}
