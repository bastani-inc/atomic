import { expect, it } from "vitest";
import { exitOnDecisionConfigError } from "../src/cli/settings-startup.ts";
import { rpcTransportError } from "../src/modes/rpc/rpc-transport-error.ts";

it("reports an engine startup failure with its named extension diagnostic, without rethrowing the transport stack", () => {
	const printed: string[] = [];
	const exits: number[] = [];
	const exit = new Error("exit sentinel");
	const failure = rpcTransportError(
		"Agent process exited (code=1 signal=null). Stderr: Error: Failed to load extension \"legacy.ts\": Cannot find module 'missing-dependency'",
	);
	expect(() =>
		exitOnDecisionConfigError(failure, {
			error: (text) => printed.push(text),
			exit: (code) => {
				exits.push(code);
				throw exit;
			},
		}),
	).toThrow(exit);
	expect(exits).toEqual([1]);
	expect(printed).toHaveLength(1);
	expect(printed[0]).toContain(failure.message);
	expect(printed[0]).not.toContain("at rpcTransportError");
});
