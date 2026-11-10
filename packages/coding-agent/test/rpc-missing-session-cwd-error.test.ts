import { describe, expect, it } from "vitest";
import { isMissingSessionCwdError, MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { assertRpcSuccess } from "../src/modes/rpc/rpc-error-decoding.ts";
import { createRpcErrorResponse } from "../src/modes/rpc/rpc-responses.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";

class ProbeRpcClient extends RpcClient {
	decode(response: RpcResponse): void {
		this.data(response);
	}
}

function overTheWire(response: RpcResponse): RpcResponse {
	return JSON.parse(JSON.stringify(response));
}

function caught(run: () => void): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected the response to be rejected");
}

describe("a missing session cwd over RPC (earendil-works/pi#11060)", () => {
	const issue = { sessionFile: "/sessions/s.jsonl", sessionCwd: "/renamed-from", fallbackCwd: "/renamed-to" };

	it("keeps its code and facts in the error response", () => {
		const error = new MissingSessionCwdError(issue);

		const response = createRpcErrorResponse("r1", "switch_session", error.message, error);

		expect(response).toMatchObject({
			id: "r1",
			command: "switch_session",
			success: false,
			error: error.message,
			errorCode: "missing_session_cwd",
			errorDetails: { name: "MissingSessionCwdError", code: "session-cwd-missing", fields: issue },
		});
	});

	it("rehydrates the same class at the host for a resume and an import", () => {
		for (const command of ["switch_session", "import_session"]) {
			const error = new MissingSessionCwdError(issue);
			const response = overTheWire(createRpcErrorResponse("r1", command, error.message, error));

			const thrown = caught(() => new ProbeRpcClient().decode(response));

			expect(thrown).toBeInstanceOf(MissingSessionCwdError);
			expect(isMissingSessionCwdError(thrown)).toBe(true);
			expect(thrown).toMatchObject({ code: "session-cwd-missing", retryable: false, issue });
			expect((thrown as MissingSessionCwdError).fields()).toEqual(error.fields());
			expect((thrown as MissingSessionCwdError).message).toBe(error.message);
		}
	});

	it("rehydrates a stored session's error, which has no session file", () => {
		const error = new MissingSessionCwdError({ sessionCwd: "/renamed-from", fallbackCwd: "/renamed-to" });
		const response = overTheWire(createRpcErrorResponse("r1", "switch_session", error.message, error));

		const thrown = caught(() => assertRpcSuccess(response));

		expect(thrown).toBeInstanceOf(MissingSessionCwdError);
		expect((thrown as MissingSessionCwdError).issue).toEqual({
			sessionCwd: "/renamed-from",
			fallbackCwd: "/renamed-to",
		});
	});

	it("falls back to a plain error carrying the message when the details are malformed", () => {
		const response = overTheWire(
			createRpcErrorResponse(
				"r1",
				"switch_session",
				"Stored session working directory does not exist",
				new MissingSessionCwdError(issue),
			),
		);
		const malformed = { ...response, errorDetails: { name: "MissingSessionCwdError", code: "session-cwd-missing" } };

		const thrown = caught(() => assertRpcSuccess(malformed as RpcResponse));

		expect(thrown).not.toBeInstanceOf(MissingSessionCwdError);
		expect((thrown as Error).constructor).toBe(Error);
		expect(thrown).toMatchObject({ message: "Stored session working directory does not exist" });
	});

	it("does not rehydrate details that no error code names", () => {
		const error = new MissingSessionCwdError(issue);
		const response = overTheWire(createRpcErrorResponse("r1", "switch_session", error.message, error));

		for (const errorCode of [undefined, "another_code"]) {
			const thrown = caught(() => assertRpcSuccess({ ...response, errorCode } as RpcResponse));

			expect((thrown as Error).constructor).toBe(Error);
			expect(thrown).toMatchObject({ message: error.message });
		}
	});

	it("adds no code to a failure of another kind", () => {
		const response = createRpcErrorResponse("r1", "switch_session", "storage is down", new Error("storage is down"));

		expect(response).toEqual({
			id: "r1",
			type: "response",
			command: "switch_session",
			success: false,
			error: "storage is down",
		});
		const thrown = caught(() => assertRpcSuccess(response));
		expect((thrown as Error).constructor).toBe(Error);
		expect(thrown).toMatchObject({ message: "storage is down" });
	});

	it("passes a successful response through", () => {
		expect(() => assertRpcSuccess({ id: "r1", type: "response", command: "abort", success: true })).not.toThrow();
	});
});
