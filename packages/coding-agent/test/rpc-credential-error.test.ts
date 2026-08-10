import { describe, expect, it } from "vitest";
import { CredentialSynchronizationError } from "../src/core/model-runtime.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { createRpcErrorResponse } from "../src/modes/rpc/rpc-responses.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";

class ProbeRpcClient extends RpcClient {
	decode(response: RpcResponse): void {
		this.data(response);
	}
}

describe("RPC credential synchronization errors", () => {
	it("preserves the synchronization discriminator without credential material", () => {
		const error = new CredentialSynchronizationError(
			"anthropic",
			"login",
			{ type: "api_key", key: "secret" },
			{ cause: new Error("availability failed") },
		);
		const response = createRpcErrorResponse("login", "login_provider", error.message, error);

		expect(response).toMatchObject({
			success: false,
			errorCode: "credential_synchronization",
			errorDetails: { providerId: "anthropic", operation: "login" },
		});
		expect(JSON.stringify(error)).not.toContain("secret");
		expect(JSON.stringify(response)).not.toContain("secret");
	});

	it("rehydrates the typed error at the isolated-runtime host", () => {
		const response = createRpcErrorResponse(
			"logout",
			"logout_provider",
			"Credential logout committed for anthropic, but local synchronization failed",
			new CredentialSynchronizationError("anthropic", "logout", undefined, { cause: new Error("stale") }),
		);
		const client = new ProbeRpcClient();

		expect(() => client.decode(response)).toThrow(CredentialSynchronizationError);
		try {
			client.decode(response);
		} catch (error) {
			expect(error).toMatchObject({
				providerId: "anthropic",
				operation: "logout",
				credential: undefined,
				cause: { message: "Credential logout committed for anthropic, but local synchronization failed" },
			});
		}
	});
});
