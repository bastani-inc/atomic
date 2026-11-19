import type { ExtensionRunner, IntercomPolicyView, SubagentChildPolicy } from "../../src/index.ts";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Condition extends true> = Condition;

type ExtensionRunnerArguments = ConstructorParameters<typeof ExtensionRunner>;

// Hosts without a workflow stage passed `undefined` sixth, where the stage context used to go. That slot stays,
// accepting only `undefined`, so the policies those hosts pass after it keep the positions the runner reads.
export type ExtensionRunnerReservedSixthArgument = Assert<Equal<ExtensionRunnerArguments[5], undefined>>;
export type ExtensionRunnerSubagentPolicyArgument = Assert<
	Equal<ExtensionRunnerArguments[6], SubagentChildPolicy | undefined>
>;
export type ExtensionRunnerIntercomPolicyArgument = Assert<
	Equal<ExtensionRunnerArguments[7], IntercomPolicyView | undefined>
>;
export type ExtensionRunnerArgumentCount = Assert<Equal<ExtensionRunnerArguments["length"], 5 | 6 | 7 | 8>>;
