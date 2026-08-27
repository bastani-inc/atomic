import type { RpcClient, RpcResponse } from "../../src/index.ts";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Condition extends true> = Condition;

type SetThinkingLevel = RpcClient["setThinkingLevel"];

export type SetThinkingLevelArity = Assert<Equal<Parameters<SetThinkingLevel>["length"], 1>>;
export type SetThinkingLevelReturnsVoid = Assert<Equal<ReturnType<SetThinkingLevel>, Promise<void>>>;

export const rpcThinkingLevelLegacySuccess: RpcResponse = {
	type: "response",
	command: "set_thinking_level",
	success: true,
};

export const rpcThinkingLevelAckSuccess: RpcResponse = {
	type: "response",
	command: "set_thinking_level",
	success: true,
	data: { level: "high", provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
};
