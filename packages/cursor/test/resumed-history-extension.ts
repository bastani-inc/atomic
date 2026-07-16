import { fromBinary } from "@bufbuild/protobuf";
import { registerCursorProvider } from "../src/provider.js";
import { CursorProtobufProtocolCodec } from "../src/proto/protobuf-codec.js";
import { AgentClientMessageSchema } from "../src/proto/agent_pb.js";
import { cursorProtoTest } from "../../../test/unit/cursor-proto-test-helpers.js";

function getBlobFrame(id: number, blobId: string): Uint8Array {
	return cursorProtoTest.encodeMessageField(4, cursorProtoTest.concatBytes(
		cursorProtoTest.encodeVarintField(1, BigInt(id)),
		cursorProtoTest.encodeMessageField(2, cursorProtoTest.encodeMessageField(1, blobId)),
	));
}

function readBlob(codec: CursorProtobufProtocolCodec, requestId: string, blobId: string, id: number): Uint8Array {
	const request = codec.decodeRunFrame({ flags: 0, data: getBlobFrame(id, blobId), endStream: false })[0]!;
	const response = codec.encodeServerResponse(request, requestId);
	const client = cursorProtoTest.readFields(response).find((field) => field.fieldNumber === 3)?.value;
	const result = cursorProtoTest.readFields(client!).find((field) => field.fieldNumber === 2)?.value;
	return cursorProtoTest.readFields(result!).find((field) => field.fieldNumber === 1)?.value ?? new Uint8Array();
}

class HistoryAwareTransport {
	openStreams = 0;
	async run(request: { requestId: string; messages: readonly object[] }) {
		const codec = new CursorProtobufProtocolCodec();
		const decoded = fromBinary(AgentClientMessageSchema, codec.encodeRunRequest(request as never));
		const roots = decoded.message.value.conversationState.rootPromptMessagesJson;
		const history = roots.map((blobId, index) => JSON.parse(new TextDecoder().decode(readBlob(codec, request.requestId, blobId, index + 1))) as { content?: string });
		const text = history.some((message) => message.content?.includes("VIOLET RIVER 83")) ? "VIOLET RIVER 83" : "ACK";
		this.openStreams += 1;
		return {
			id: request.requestId,
			messages: this.messages(text),
			async writeToolResult() {}, async cancel() {}, async close() {},
		};
	}
	async *messages(text: string) {
		try {
			yield { type: "textDelta" as const, text };
			yield { type: "usage" as const, inputTokens: 1, outputTokens: 1 };
			yield { type: "done" as const, reason: "stop" as const };
		} finally { this.openStreams = Math.max(0, this.openStreams - 1); }
	}
	async dispose() {}
	discardConversation() {}
	getLifecycleSnapshot() { return { openStreams: this.openStreams, cancelledStreams: 0, closedStreams: 0 }; }
}

export default function extension(pi: Parameters<typeof registerCursorProvider>[0]): void {
	const transport = new HistoryAwareTransport();
	registerCursorProvider(pi, {
		transport: transport as never,
		discoveryService: { async discover() { return { source: "live" as const, fetchedAt: Date.now(), models: [{ id: "continuity-route", maxMode: false }] }; } } as never,
		catalogCache: { load() { return null; }, save() { return true; }, clear() {} },
		resolveCurrentAccessToken: () => `x.${Buffer.from(JSON.stringify({ sub: "resumed-cli-test" })).toString("base64url")}.x`,
	});
}
