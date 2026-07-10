export type AssertMcpStateLease = () => void;

export class McpStateChangedError extends Error {
  constructor() {
    super("MCP session changed during execution");
    this.name = "McpStateChangedError";
  }
}

export function assertMcpStateLease(assertActive?: AssertMcpStateLease): void {
  assertActive?.();
}
