import { expect, it } from "vitest";
import { exitOnDecisionConfigError } from "../src/cli/settings-startup.ts";
import { SessionAlreadyOpenError } from "../src/core/session-manager-errors.ts";
import { SessionConflictError } from "../src/core/storage/session/errors.ts";
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

it("ends a run refused for a session another live process holds with exit code 75 and its message (#5135)", () => {
	const printed: string[] = [];
	const exits: number[] = [];
	const exit = new Error("exit sentinel");
	const failure = new SessionAlreadyOpenError("s-1", { pid: 42, host: "node-a" });
	expect(() =>
		exitOnDecisionConfigError(failure, {
			error: (text) => printed.push(text),
			exit: (code) => {
				exits.push(code);
				throw exit;
			},
		}),
	).toThrow(exit);
	expect(exits).toEqual([75]);
	expect(printed).toEqual([expect.stringContaining("Error: Session s-1 is already open in process 42 on node-a.")]);
});

it("ends a run whose session another process wrote to meanwhile with exit code 1 and a message naming it (#5135)", () => {
	const printed: string[] = [];
	const exits: number[] = [];
	const exit = new Error("exit sentinel");
	expect(() =>
		exitOnDecisionConfigError(new SessionConflictError("s-2", 1, 4), {
			error: (text) => printed.push(text),
			exit: (code) => {
				exits.push(code);
				throw exit;
			},
		}),
	).toThrow(exit);
	expect(exits).toEqual([1]);
	expect(printed).toEqual([
		expect.stringContaining(
			"Error: Another process wrote to session s-2 while this one was writing to it (expected 1 entries, found 4), so this run stopped. Resume the session again",
		),
	]);
});
