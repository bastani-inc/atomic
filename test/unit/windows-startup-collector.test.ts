import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { test } from "vitest";
import {
	LoopbackProviderCollector,
	REQUIRED_BENCHMARK_TOOL_SCHEMAS,
	REQUIRED_BENCHMARK_TOOLS,
	validateProviderRequest,
} from "../../scripts/perf/windows-startup/collector.js";

type RequiredBenchmarkTool = (typeof REQUIRED_BENCHMARK_TOOLS)[number];

function requestBody(nonce: string, tools: readonly RequiredBenchmarkTool[] = REQUIRED_BENCHMARK_TOOLS): string {
	return JSON.stringify({
		messages: [{ role: "user", content: nonce }],
		tools: tools.map((name) => {
			const contract = REQUIRED_BENCHMARK_TOOL_SCHEMAS[name];
			return {
				type: "function",
				function: {
					name,
					parameters: {
						type: "object",
						properties: Object.fromEntries(contract.properties.map((property) => [property, { type: "string" }])),
						required: [...contract.required],
					},
				},
			};
		}),
	});
}

function rawRequest(body: string): string {
	return `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

async function exchange(port: number, request: string, splitAt?: number): Promise<void> {
	const socket = connect(port, "127.0.0.1");
	await once(socket, "connect");
	socket.resume();
	if (splitAt === undefined) {
		socket.end(request);
	} else {
		socket.write(request.slice(0, splitAt));
		socket.end(request.slice(splitAt));
	}
	await once(socket, "end");
	socket.destroy();
}

test("the collector timestamps the first socket byte before parsing HTTP", async () => {
	const marks = [100n, 900n];
	const collector = new LoopbackProviderCollector("nonce-1", { nowNs: () => marks.shift() ?? 900n });
	await collector.start();
	await exchange(collector.port, rawRequest(requestBody("nonce-1")), 1);
	const record = await collector.waitForRequest();
	assert.equal(record.firstByteNs, "100");
	assert.equal(record.parsedAtNs, "900");
	await collector.stop();
});

test("duplicate provider requests fail the single-request assertion", async () => {
	const collector = new LoopbackProviderCollector("nonce-2");
	await collector.start();
	await exchange(collector.port, rawRequest(requestBody("nonce-2")));
	await exchange(collector.port, rawRequest(requestBody("nonce-2")));
	assert.throws(() => collector.assertSingleValidRequest(), /exactly one provider socket attempt/u);
	await collector.stop();
});

test("a duplicate arriving after the first assertion fails once collection closes", async () => {
	const collector = new LoopbackProviderCollector("nonce-late");
	await collector.start();
	await exchange(collector.port, rawRequest(requestBody("nonce-late")));
	assert.doesNotThrow(() => collector.assertSingleValidRequest());
	await exchange(collector.port, rawRequest(requestBody("nonce-late")));
	await collector.stop();
	assert.throws(() => collector.assertSingleValidRequest(), /exactly one provider socket attempt/u);
});

test("incomplete provider attempts retain their socket-level first-byte mark", async () => {
	const marks = [123n, 456n];
	const collector = new LoopbackProviderCollector("nonce-incomplete", { nowNs: () => marks.shift() ?? 456n });
	await collector.start();
	await exchange(collector.port, "POST /v1/chat/completions HTTP/1.1\r\nContent-Length: 10\r\n\r\nshort");
	await collector.stop();
	assert.equal(collector.attempts.length, 1);
	assert.equal(collector.attempts[0]?.index, 0);
	assert.equal(collector.attempts[0]?.firstByteNs, "123");
	assert.equal(collector.attempts[0]?.closedAtNs, "456");
	assert.equal(collector.attempts[0]?.status, "incomplete");
	assert.equal(collector.attempts[0]?.error, "socket closed before the declared request body was complete");
	assert.throws(() => collector.assertSingleValidRequest(), /did not complete/u);
});

test("missing nonce and required tool schemas fail validation", () => {
	const missingNonce = validateProviderRequest(requestBody("other"), "expected");
	assert.ok(missingNonce.errors.some((error) => error.includes("nonce")));
	const missingTool = validateProviderRequest(requestBody("expected", REQUIRED_BENCHMARK_TOOLS.slice(1)), "expected");
	assert.ok(missingTool.errors.some((error) => error.includes(REQUIRED_BENCHMARK_TOOLS[0]!)));
});

test("required tool schemas must match exact property and required-name contracts", () => {
	const body = JSON.parse(requestBody("expected")) as {
		tools: Array<{
			function: {
				name: string;
				parameters: { properties: Record<string, unknown>; required?: unknown[] };
			};
		}>;
	};
	const read = body.tools.find((tool) => tool.function.name === "read")!;
	read.function.parameters.properties.extra = { type: "string" };
	let validation = validateProviderRequest(JSON.stringify(body), "expected");
	assert.ok(validation.errors.some((error) => error.includes("inexact required tool schema: read")));

	const missingRequired = JSON.parse(requestBody("expected")) as typeof body;
	const write = missingRequired.tools.find((tool) => tool.function.name === "write")!;
	write.function.parameters.required = ["path"];
	validation = validateProviderRequest(JSON.stringify(missingRequired), "expected");
	assert.ok(validation.errors.some((error) => error.includes("inexact required tool schema: write")));

	const duplicateRequired = JSON.parse(requestBody("expected")) as typeof body;
	const duplicateWrite = duplicateRequired.tools.find((tool) => tool.function.name === "write")!;
	duplicateWrite.function.parameters.required = ["path", "content", "content"];
	validation = validateProviderRequest(JSON.stringify(duplicateRequired), "expected");
	assert.ok(validation.errors.some((error) => error.includes("inexact required tool schema: write")));

	const absentEmptyRequired = JSON.parse(requestBody("expected")) as typeof body;
	const mcp = absentEmptyRequired.tools.find((tool) => tool.function.name === "mcp")!;
	delete mcp.function.parameters.required;
	validation = validateProviderRequest(JSON.stringify(absentEmptyRequired), "expected");
	assert.ok(!validation.errors.some((error) => error.includes("inexact required tool schema: mcp")));

	const absentNonEmptyRequired = JSON.parse(requestBody("expected")) as typeof body;
	const readTool = absentNonEmptyRequired.tools.find((tool) => tool.function.name === "read")!;
	delete readTool.function.parameters.required;
	validation = validateProviderRequest(JSON.stringify(absentNonEmptyRequired), "expected");
	assert.ok(validation.errors.some((error) => error.includes("inexact required tool schema: read")));

	const duplicateTool = JSON.parse(requestBody("expected")) as typeof body;
	duplicateTool.tools.push(duplicateTool.tools.find((tool) => tool.function.name === "read")!);
	validation = validateProviderRequest(JSON.stringify(duplicateTool), "expected");
	assert.ok(validation.errors.some((error) => error.includes("exactly one required tool schema: read")));

	const valid = requestBody("expected");
	const duplicateProperty = valid.replace(
		'"properties":{"path":{"type":"string"}}',
		'"properties":{"path":{"type":"string"},"path":{"type":"string"}}',
	);
	assert.notEqual(duplicateProperty, valid);
	validation = validateProviderRequest(duplicateProperty, "expected");
	assert.ok(validation.errors.some((error) => error.includes("duplicate JSON object keys")));
});
