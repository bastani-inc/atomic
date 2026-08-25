import { describe, expect, it } from "vitest";
import { RpcClientApi, type RpcCommandBody } from "../src/modes/rpc/rpc-client-api.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";

class QueueClient extends RpcClientApi {
	lastCommand: RpcCommandBody | undefined;

	protected request(command: RpcCommandBody): Promise<RpcResponse> {
		this.lastCommand = command;
		return Promise.resolve({
			type: "response",
			command: "clear_queue",
			success: true,
			data: { steering: ["Change direction"], followUp: ["Summarize when finished"] },
		});
	}

	protected data<T>(response: RpcResponse): T {
		if (!("data" in response)) throw new Error("Expected RPC response data");
		return response.data as T;
	}
}

describe("RpcClient clearQueue", () => {
	it("sends the clear_queue RPC command", async () => {
		const client = new QueueClient();

		const result = await client.clearQueue();

		expect(client.lastCommand).toEqual({ type: "clear_queue" });
		expect(result).toEqual({ steering: ["Change direction"], followUp: ["Summarize when finished"] });
	});
});
