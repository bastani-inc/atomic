import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model, Tool } from "../src/types.ts";

const parameters = Type.Union([
	Type.Object({
		requestId: Type.String(),
		kind: Type.Literal("items"),
		values: Type.Array(Type.String()),
	}),
	Type.Object({
		requestId: Type.String(),
		kind: Type.Literal("record"),
		value: Type.Object({ count: Type.Number() }),
	}),
]);

const objectParameters = Type.Object({ query: Type.String() });
const mixedUnionParameters = Type.Union([Type.Object({ value: Type.String() }), Type.String()]);

const tools: Tool[] = [
	{
		name: "store_container",
		description: "Store a container value",
		parameters,
		constrainedSampling: false,
	},
	{
		name: "search",
		description: "Search for a query",
		parameters: objectParameters,
		constrainedSampling: false,
	},
	{
		name: "mixed_union",
		description: "Accept an object or string",
		parameters: mixedUnionParameters,
		constrainedSampling: false,
	},
];

function createModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
		compat: { supportsStrictTools: true },
	};
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeEmptySseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

it("projects a root object union into an Anthropic-compatible tool schema", async () => {
	const authoredParameters = JSON.stringify(parameters);
	let capturedBody: Record<string, unknown> | undefined;
	const server = createServer(async (request, response) => {
		capturedBody = await readRequestBody(request);
		writeEmptySseResponse(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		const context: Context = {
			messages: [{ role: "user", content: "Store the items", timestamp: Date.now() }],
			tools,
		};
		const stream = streamAnthropic(createModel(`http://127.0.0.1:${address.port}`), context, {
			apiKey: "test-key",
			cacheRetention: "none",
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	const outgoingTools = capturedBody?.tools;
	expect(Array.isArray(outgoingTools)).toBe(true);
	const [unionTool, objectTool, mixedUnionTool] = outgoingTools as Array<Record<string, unknown>>;
	const inputSchema = unionTool.input_schema as Record<string, unknown>;
	expect(inputSchema).toEqual({
		type: "object",
		properties: {
			requestId: parameters.anyOf[0].properties.requestId,
			kind: {
				anyOf: [parameters.anyOf[0].properties.kind, parameters.anyOf[1].properties.kind],
			},
			values: parameters.anyOf[0].properties.values,
			value: parameters.anyOf[1].properties.value,
		},
		required: ["requestId", "kind"],
	});
	expect(inputSchema).not.toEqual({ type: "object", properties: {}, required: [] });
	expect(inputSchema).not.toHaveProperty("anyOf");
	expect(inputSchema).not.toHaveProperty("oneOf");
	expect(inputSchema).not.toHaveProperty("allOf");
	expect(JSON.stringify(parameters)).toBe(authoredParameters);

	expect(objectTool.input_schema).toEqual({
		type: "object",
		properties: objectParameters.properties,
		required: objectParameters.required,
	});
	expect(mixedUnionTool.input_schema).toEqual({ type: "object", properties: {}, required: [] });
});
