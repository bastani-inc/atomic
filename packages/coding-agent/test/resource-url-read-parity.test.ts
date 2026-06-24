import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

function textOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
}
function listen(server: Server): Promise<number> { return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))); }

describe("resource URL read parity", () => {
	let testDir: string;
	beforeEach(() => { testDir = join(tmpdir(), `atomic-resource-url-${Date.now()}-${Math.random().toString(36).slice(2)}`); mkdirSync(testDir, { recursive: true }); });
	afterEach(() => rmSync(testDir, { recursive: true, force: true }));

	it("applies line selectors and reader extraction to URL reads", async () => {
		const server = createServer((req, res) => {
			if (req.url?.startsWith("/notebook.ipynb") || req.url?.startsWith("/download")) { res.setHeader("content-type", "application/x-ipynb+json"); res.end(JSON.stringify({ cells: [{ cell_type: "code", source: ["print('url')\n"] }] })); return; }
			if (req.url?.startsWith("/file.rtf")) { res.setHeader("content-type", "application/rtf"); res.end("{\\rtf1\\ansi Hello RTF}"); return; }
			if (req.url?.startsWith("/big.txt")) { res.setHeader("content-type", "text/plain"); res.end("x".repeat(60_000)); return; }
			res.setHeader("content-type", "text/html"); res.end("<html><head><title>Example</title></head><body><p>one</p><p>two</p><p>three</p></body></html>");
		});
		const port = await listen(server);
		try {
			const read = createReadToolDefinition(testDir);
			expect(textOutput(await read.execute("url-read", { path: `http://127.0.0.1:${port}/:3-3` }, undefined, undefined, {} as never))).toContain("three");
			const raw = textOutput(await read.execute("url-raw", { path: `http://127.0.0.1:${port}/:raw` }, undefined, undefined, {} as never));
			expect(raw).toContain("<html>"); expect(raw).not.toContain("URL:");
			const big = await read.execute("url-big", { path: `http://127.0.0.1:${port}/big.txt` }, undefined, undefined, {} as never);
			expect(textOutput(big)).toContain("Showing first");
			expect(big.details?.truncation?.truncated).toBe(true);
			expect(big.details?.meta?.truncation?.truncated).toBe(true);
			expect(textOutput(await read.execute("url-ipynb", { path: `http://127.0.0.1:${port}/notebook.ipynb` }, undefined, undefined, {} as never))).toContain("# %% [code] cell:0");
			expect(textOutput(await read.execute("url-ipynb-content-type", { path: `http://127.0.0.1:${port}/download` }, undefined, undefined, {} as never))).toContain("# %% [code] cell:0");
			const rtf = textOutput(await read.execute("url-rtf-query", { path: `http://127.0.0.1:${port}/file.rtf?download` }, undefined, undefined, {} as never));
			expect(rtf).toContain("[Cannot read .rtf file: Unsupported format: .rtf]");
			expect(textOutput(await read.execute("url-oob", { path: `http://127.0.0.1:${port}/:99` }, undefined, undefined, {} as never))).toContain("Requested line 99 is beyond end of resource");
		} finally { server.close(); }
	});
});
