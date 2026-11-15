import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { extractPDFToMarkdown } from "../../packages/web-access/pdf-extract.js";
import {
	makeDirectorySync,
	makeTempDirectory,
	readDirectorySync,
	readTextSync,
	removeTempDirectory,
	writeTextSync,
} from "../helpers/runtime.js";

vi.mock("@bastani/atomic", () => ({
	CONFIG_DIR_NAME: ".atomic",
	APP_NAME: "atomic",
	getUserConfigPaths: () => [],
}));
vi.mock("../../packages/web-access/github-extract.js", () => ({ extractGitHub: async () => null }));
const geminiFallbacks = vi.hoisted(() => ({
	extractWithUrlContext: vi.fn(async () => null),
	extractWithGeminiWeb: vi.fn(async () => null),
}));
vi.mock("../../packages/web-access/gemini-url-context.js", () => geminiFallbacks);

interface Result {
	url: string;
	title: string;
	content: string;
	error: string | null;
}
// These legacy sources are excluded from the root typecheck.
const { extractContent } = await vi.importActual<{
	extractContent(url: string, signal?: AbortSignal): Promise<Result>;
}>("../../packages/web-access/extract.js");

const MB = 1024 * 1024;

/** A one-page PDF whose document title is `title` (encoded as UTF-16BE) and whose page shows `text`. */
function buildPdf(title: string, text: string): Buffer {
	const utf16 = Buffer.from(`\ufeff${title}`, "utf16le").swap16().toString("hex");
	const content = `BT /F1 24 Tf 10 10 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 50] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Title <${utf16}> >>`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, index) => {
		offsets.push(pdf.length);
		pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}

function pdfBuffer(title: string): ArrayBuffer {
	return new Uint8Array(buildPdf(title, "Text")).buffer;
}

/** Write `total` bytes of `fill` without a Content-Length (chunked), honouring backpressure. */
function streamChunked(
	res: ServerResponse,
	total: number,
	fill: string,
	sent: { bytes: number; closedEarly: boolean },
) {
	const chunk = Buffer.alloc(64 * 1024, fill);
	res.on("close", () => {
		if (!res.writableFinished) sent.closedEarly = true;
	});
	const pump = () => {
		while (sent.bytes < total && !res.destroyed) {
			const size = Math.min(chunk.length, total - sent.bytes);
			sent.bytes += size;
			if (!res.write(chunk.subarray(0, size))) {
				res.once("drain", pump);
				return;
			}
		}
		if (!res.destroyed) res.end();
	};
	pump();
}

let home: string;
let server: Server;
let baseUrl: string;
let route: (path: string, res: ServerResponse) => void;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(async () => {
	home = makeTempDirectory("atomic-web-fetch-");
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	server = createServer((req, res) => route(req.url ?? "/", res));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	vi.unstubAllGlobals();
	geminiFallbacks.extractWithUrlContext.mockClear();
	geminiFallbacks.extractWithGeminiWeb.mockClear();
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	process.env.HOME = savedHome.HOME;
	process.env.USERPROFILE = savedHome.USERPROFILE;
	removeTempDirectory(home);
});

function servePdfs(pdfs: Record<string, Buffer>) {
	route = (path, res) => {
		res.writeHead(200, { "content-type": "application/pdf" });
		res.end(pdfs[path]);
	};
}

test("concurrent PDFs with non-Latin titles are saved to distinct files and never overwrite one (#4898)", async () => {
	const downloads = join(home, "Downloads");
	makeDirectorySync(downloads);
	writeTextSync(join(downloads, "document.md"), "my notes");
	servePdfs({ "/a.pdf": buildPdf("論文", "Alpha"), "/b.pdf": buildPdf("Статья", "Bravo") });

	const results = await Promise.all([extractContent(`${baseUrl}/a.pdf`), extractContent(`${baseUrl}/b.pdf`)]);

	for (const result of results) assert.equal(result.error, null);
	assert.deepEqual(readDirectorySync(downloads).sort(), ["document.md", "статья.md", "論文.md"].sort());
	assert.equal(readTextSync(join(downloads, "document.md"), "utf-8"), "my notes");
	assert.match(readTextSync(join(downloads, "論文.md"), "utf-8"), /^Alpha$/m);
	assert.match(readTextSync(join(downloads, "статья.md"), "utf-8"), /^Bravo$/m);
});

test("concurrent PDFs with the same title get numbered files (#4898)", async () => {
	servePdfs({ "/a.pdf": buildPdf("論文", "Alpha"), "/b.pdf": buildPdf("論文", "Bravo") });

	const results = await Promise.all([extractContent(`${baseUrl}/a.pdf`), extractContent(`${baseUrl}/b.pdf`)]);

	const downloads = join(home, "Downloads");
	assert.deepEqual(readDirectorySync(downloads).sort(), ["論文-2.md", "論文.md"].sort());
	const texts = ["論文.md", "論文-2.md"].map((name) => readTextSync(join(downloads, name), "utf-8"));
	assert.deepEqual(texts.map((text) => /^(Alpha|Bravo)$/m.exec(text)?.[1]).sort(), ["Alpha", "Bravo"]);
	for (const result of results) assert.match(result.content, /PDF extracted and saved to: /);
});

test("a chunked 40 MB text response fails as too large without being read to the end (#4898)", async () => {
	const sent = { bytes: 0, closedEarly: false };
	route = (_path, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		streamChunked(res, 40 * MB, "a", sent);
	};

	const url = `${baseUrl}/big.txt`;
	const result = await extractContent(url);

	assert.deepEqual(result, { url, title: "", content: "", error: "Response too large (over 5MB)" });
	await vi.waitFor(() => assert.equal(sent.closedEarly, true));
	assert.ok(sent.bytes < 40 * MB, `server sent ${sent.bytes} bytes`);
});

test("a chunked PDF response over 20 MB fails as too large (#4898)", async () => {
	const sent = { bytes: 0, closedEarly: false };
	route = (_path, res) => {
		res.writeHead(200, { "content-type": "application/pdf" });
		streamChunked(res, 30 * MB, "a", sent);
	};

	const url = `${baseUrl}/big.pdf`;
	const result = await extractContent(url);

	assert.deepEqual(result, { url, title: "", content: "", error: "Response too large (over 20MB)" });
	assert.deepEqual(readDirectorySync(home), []);
});

test("a chunked text response under the cap is returned whole (#4898)", async () => {
	const sent = { bytes: 0, closedEarly: false };
	route = (_path, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		streamChunked(res, 5 * MB, "0123456789abc", sent);
	};

	const result = await extractContent(`${baseUrl}/ok.txt`);

	assert.equal(result.error, null);
	// Every 64 KB chunk restarts the pattern, so misplaced chunks would change the text.
	assert.equal(
		result.content,
		Buffer.alloc(64 * 1024, "0123456789abc")
			.toString()
			.repeat(80),
	);
	assert.equal(sent.closedEarly, false);
});

test("a response whose Content-Length is over the cap is refused before reading it (#4898)", async () => {
	route = (_path, res) => {
		res.writeHead(200, { "content-type": "text/plain", "content-length": String(6 * MB) });
		res.write("partial");
	};

	const url = `${baseUrl}/declared.txt`;
	const result = await extractContent(url);

	assert.deepEqual(result, { url, title: "", content: "", error: "Response too large (6MB)" });
});

test("an empty response body is returned as empty text (#4898)", async () => {
	vi.stubGlobal("fetch", async () => new Response(null, { headers: { "content-type": "text/plain" } }));

	const result = await extractContent("https://example.com/empty.txt");

	assert.deepEqual(result, { url: "https://example.com/empty.txt", title: "empty.txt", content: "", error: null });
});

test("a fallback reader response under the cap is used (#4898)", async () => {
	const markdown = `# Page\n\n${"Readable text. ".repeat(20)}`;
	vi.stubGlobal("fetch", async (input: string | URL | Request) =>
		String(input).startsWith("https://r.jina.ai/")
			? new Response(`Title: Page\n\nMarkdown Content:\n${markdown}`)
			: new Response("down", { status: 503 }),
	);

	const result = await extractContent("https://example.com/page");

	assert.deepEqual(result, { url: "https://example.com/page", title: "Page", content: markdown.trim(), error: null });
});

test("an oversized chunked fallback reader response is discarded (#4898)", async () => {
	let pulls = 0;
	const fetch = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (!url.startsWith("https://r.jina.ai/")) return new Response("down", { status: 503 });
		const chunk = new TextEncoder().encode(`Markdown Content:\n${"c".repeat(MB)}`);
		return new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls++;
					controller.enqueue(chunk);
					if (pulls > 40) controller.close();
				},
			}),
		);
	});
	vi.stubGlobal("fetch", fetch);

	const result = await extractContent("https://example.com/page");

	assert.match(result.error ?? "", /^HTTP 503/);
	assert.ok(!result.content.includes("ccc"));
	assert.ok(pulls < 10, `fallback body was read ${pulls} times`);
});

test("local and private URLs are never sent to remote fallback services (#4898)", async () => {
	const fetch = vi.fn(
		async (_input: string | URL | Request) =>
			new Response("down", { status: 500, statusText: "Internal Server Error" }),
	);
	vi.stubGlobal("fetch", fetch);

	for (const url of [
		"http://127.0.0.1/admin",
		"http://10.0.0.5/?token=x",
		"http://192.168.1.2/",
		"http://172.20.0.1/",
		"http://172.16.0.1/",
		"http://172.31.255.1/",
		"http://0.0.0.0/",
		"http://[::]/",
		"http://[fc00::1]/",
		"http://[feb0::1]/",
		"http://[::ffff:192.168.0.1]/",
		"http://localhost./",
		"http://app.localhost/",
		"http://LOCALHOST/",
		"https://user@example.com/",
		"https://:secret@example.com/",
		"http://169.254.169.254/latest",
		"http://[::1]:8080/",
		"http://[fd00::1]/",
		"http://[fe80::1]/",
		"http://[::ffff:10.0.1.1]/",
		"http://printer.local./",
		"http://localhost:3000/",
		"http://printer.local/",
		"http://wiki.corp.internal/",
		"http://intranet/",
		"https://user:secret@example.com/",
	]) {
		const result = await extractContent(url);
		assert.equal(result.error, "HTTP 500: Internal Server Error", url);
	}

	const requested = fetch.mock.calls.map(([input]) => String(input));
	assert.deepEqual(
		requested.filter((url) => url.startsWith("https://r.jina.ai/")),
		[],
	);
	assert.equal(geminiFallbacks.extractWithUrlContext.mock.calls.length, 0);
	assert.equal(geminiFallbacks.extractWithGeminiWeb.mock.calls.length, 0);
});

test("public URLs still use the remote fallback services (#4898)", async () => {
	const fetch = vi.fn(
		async (_input: string | URL | Request) =>
			new Response("down", { status: 500, statusText: "Internal Server Error" }),
	);
	vi.stubGlobal("fetch", fetch);

	const publicUrls = [
		"https://example.com/a",
		"http://8.8.8.8/",
		"http://1.10.127.0/",
		"http://172.15.0.1/",
		"http://172.32.0.1/",
		"http://169.1.0.1/",
		"http://192.1.0.1/",
		"http://[2001:db8::1]/",
		"http://1.254.0.1/",
		"http://1.20.0.1/",
		"http://1.168.0.1/",
		"http://[1::ffff:a00:101]/",
		"http://[::ffff:a00:101:1]/",
		"http://[2001:db8::fd1]/",
		"http://[2001:db8::fe80]/",
		"http://[::ffff:8.8.8.8]/",
		"http://notlocalhost.com/",
		"http://example.local.com/",
	];
	for (const url of publicUrls) await extractContent(url);

	const jina = fetch.mock.calls.map(([input]) => String(input)).filter((url) => url.startsWith("https://r.jina.ai/"));
	assert.deepEqual(
		jina,
		publicUrls.map((url) => `https://r.jina.ai/${url}`),
	);
	assert.equal(geminiFallbacks.extractWithUrlContext.mock.calls.length, publicUrls.length);
});

function stubFetchFailingDirectly() {
	const fetch = vi.fn(
		async (_input: string | URL | Request, _init?: RequestInit) =>
			new Response("down", { status: 500, statusText: "Internal Server Error" }),
	);
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

function requestedUrls(fetch: ReturnType<typeof stubFetchFailingDirectly>): string[] {
	return fetch.mock.calls.map(([input]) => String(input));
}

function assertNoRemoteFallback(fetch: ReturnType<typeof stubFetchFailingDirectly>) {
	assert.deepEqual(
		requestedUrls(fetch).filter((url) => url.startsWith("https://r.jina.ai/")),
		[],
	);
	assert.equal(geminiFallbacks.extractWithUrlContext.mock.calls.length, 0);
	assert.equal(geminiFallbacks.extractWithGeminiWeb.mock.calls.length, 0);
}

test("non-http(s) URLs are refused without any request (#5127)", async () => {
	const fetch = stubFetchFailingDirectly();

	for (const url of [
		"foo://intranet.LOCAL/secret",
		"ftp://files.example.com/report.txt",
		"file:///etc/passwd",
		"gopher://Wiki.Corp.Internal/",
	]) {
		const result = await extractContent(url);
		assert.deepEqual(
			result,
			{ url, title: "", content: "", error: `Unsupported URL scheme: ${new URL(url).protocol}` },
			url,
		);
	}

	assert.deepEqual(requestedUrls(fetch), []);
	assertNoRemoteFallback(fetch);
});

test("private hosts in every notation are never sent to remote fallback services (#5127)", async () => {
	const fetch = stubFetchFailingDirectly();

	for (const url of [
		"http://INTRANET.LOCAL/",
		"HTTPS://Wiki.Corp.INTERNAL/",
		"http://nas.lan/",
		"http://router.home.arpa/",
		"http://localhost.localdomain/",
		"http://printer.local../",
		"http://Intranet./",
		"http://2130706433/",
		"http://0177.0.0.1/",
		"http://0x7f.1/",
		"http://10.1/",
		"http://0xa000001/",
		"http://0300.0250.0.1/",
		"http://0xac.0x10.1/",
		"http://0251.0376.1.1/",
		"http://[0:0:0:0:0:ffff:127.0.0.1]/",
		"http://[::FFFF:a9fe:a9fe]/",
		"http://[::ffff:0:a00:1]/",
		"http://[::ffff:0:192.168.1.1]/",
		"http://[::10.0.0.1]/",
		"http://[::0.0.0.1]/",
		"http://[64:ff9b::10.0.0.1]/",
		"http://[0:0:0:0:0:0:0:1]/",
		"http://[FE80::1]/",
		"http://[FEBF::1]/",
		"http://[FEC0::1]/",
		"http://[feff::1]/",
		"http://100.64.0.1/",
		"http://100.127.255.254/",
		"http://[FD12:3456::1]/",
		"http://[FC00::1]/",
	]) {
		const result = await extractContent(url);
		assert.equal(result.error, "HTTP 500: Internal Server Error", url);
	}

	assertNoRemoteFallback(fetch);
});

test("an IPv6 URL with a zone id is rejected and never sent to remote fallback services (#5127)", async () => {
	const fetch = stubFetchFailingDirectly();

	const result = await extractContent("http://[fe80::1%25eth0]/");

	assert.equal(result.error, "Invalid URL");
	assert.deepEqual(requestedUrls(fetch), []);
	assertNoRemoteFallback(fetch);
});

test("public hosts that only resemble private ones still use the remote fallback (#5127)", async () => {
	const fetch = stubFetchFailingDirectly();
	const publicUrls = [
		"http://nas.lan.example.com/",
		"http://home.arpa.example.com/",
		"http://[64:ff9b::8.8.8.8]/",
		"http://[::ffff:0:8.8.8.8]/",
		"http://[::8.8.8.8]/",
		"http://[64:ff9c::a00:1]/",
		"http://[0:0:0:1::a00:1]/",
		"http://100.63.255.255/",
		"http://100.128.0.1/",
		"http://101.64.0.1/",
		"http://[fbff::1]/",
		"http://[fe7f::1]/",
	];

	for (const url of publicUrls) await extractContent(url);

	assert.deepEqual(
		requestedUrls(fetch).filter((url) => url.startsWith("https://r.jina.ai/")),
		publicUrls.map((url) => `https://r.jina.ai/${url}`),
	);
});

test("a public URL that redirects to a private host is never sent to remote fallback services (#5127)", async () => {
	const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
		const url = String(input);
		if (url === "https://example.com/start") {
			return new Response(null, { status: 302, headers: { location: "https://example.com/next" } });
		}
		if (url === "https://example.com/next") {
			return new Response(null, { status: 307, headers: { location: "http://10.0.0.5/admin" } });
		}
		if (url.startsWith("https://r.jina.ai/")) {
			return new Response(`Markdown Content:\n# Leaked\n\n${"Readable text. ".repeat(20)}`);
		}
		throw new TypeError("fetch failed");
	});
	vi.stubGlobal("fetch", fetch);

	const result = await extractContent("https://example.com/start");

	assert.equal(result.error, "fetch failed");
	assert.deepEqual(requestedUrls(fetch), [
		"https://example.com/start",
		"https://example.com/next",
		"http://10.0.0.5/admin",
	]);
	for (const [, init] of fetch.mock.calls) assert.equal(init?.redirect, "manual");
	assert.equal(geminiFallbacks.extractWithUrlContext.mock.calls.length, 0);
	assert.equal(geminiFallbacks.extractWithGeminiWeb.mock.calls.length, 0);
});

test("a public URL that redirects to a non-http(s) URL is never sent to remote fallback services (#5127)", async () => {
	const fetch = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url === "https://example.com/start") {
			return new Response(null, { status: 301, headers: { location: "foo://intranet.LOCAL/x" } });
		}
		return new Response("down", { status: 500, statusText: "Internal Server Error" });
	});
	vi.stubGlobal("fetch", fetch);

	const result = await extractContent("https://example.com/start");

	assert.equal(result.error, "Unsupported redirect URL scheme: foo:");
	assert.deepEqual(requestedUrls(fetch), ["https://example.com/start"]);
	assert.equal(geminiFallbacks.extractWithUrlContext.mock.calls.length, 0);
});

test("redirects between public URLs are followed and still allow the remote fallback (#5127)", async () => {
	const markdown = `# Page\n\n${"Readable text. ".repeat(20)}`;
	const fetch = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url === "https://example.com/a/start") {
			return new Response("moved", { status: 308, headers: { location: "next?x=1" } });
		}
		if (url === "https://example.com/a/next?x=1") {
			return new Response(null, { status: 303, headers: { location: "https://docs.example.org/page" } });
		}
		if (url.startsWith("https://r.jina.ai/")) return new Response(`Markdown Content:\n${markdown}`);
		return new Response("down", { status: 503, statusText: "Service Unavailable" });
	});
	vi.stubGlobal("fetch", fetch);

	const result = await extractContent("https://example.com/a/start");

	assert.deepEqual(result, {
		url: "https://example.com/a/start",
		title: "Page",
		content: markdown.trim(),
		error: null,
	});
	assert.deepEqual(requestedUrls(fetch), [
		"https://example.com/a/start",
		"https://example.com/a/next?x=1",
		"https://docs.example.org/page",
		"https://r.jina.ai/https://example.com/a/start",
	]);
});

test("a non-redirect response with a Location header is used as is (#5127)", async () => {
	const fetch = vi.fn(
		async (_input: string | URL | Request) =>
			new Response("# Created\n\nDone.", {
				status: 201,
				headers: { "content-type": "text/plain", location: "http://10.0.0.5/item" },
			}),
	);
	vi.stubGlobal("fetch", fetch);

	const result = await extractContent("https://example.com/items");

	assert.deepEqual(result, {
		url: "https://example.com/items",
		title: "Created",
		content: "# Created\n\nDone.",
		error: null,
	});
	assert.deepEqual(requestedUrls(fetch), ["https://example.com/items"]);
});

test("a 3xx response without a Location header is reported as an HTTP error (#5127)", async () => {
	vi.stubGlobal("fetch", async () => new Response(null, { status: 304, statusText: "Not Modified" }));

	const result = await extractContent("http://localhost/cached");

	assert.equal(result.error, "HTTP 304: Not Modified");
});

test("a redirect loop stops after 20 redirects (#5127)", async () => {
	const fetch = vi.fn(
		async (input: string | URL | Request) =>
			new Response(null, { status: 302, headers: { location: `${String(input)}x` } }),
	);
	vi.stubGlobal("fetch", fetch);

	const result = await extractContent("http://localhost/loop");

	assert.equal(result.error, "Too many redirects");
	assert.equal(fetch.mock.calls.length, 21);
});

test("PDF file names keep the title but drop unsafe characters and reserved names (#4898)", async () => {
	const outputDir = join(home, "out");
	const save = async (title: string) => {
		const result = await extractPDFToMarkdown(pdfBuffer(title), "https://example.com/x.pdf", {
			outputDir,
		});
		return result.outputPath.slice(outputDir.length + 1);
	};

	assert.equal(await save('Q3: "Plans" <draft> a/b\\c|d?*'), "q3-plans-draft-abcd.md");
	assert.equal(await save("..Hidden  Title.."), "hidden-title.md");
	assert.equal(await save("- dashed -"), "dashed.md");
	assert.equal(await save("???"), "document.md");
	assert.equal(await save("CON"), "con-document.md");
	assert.equal(await save("lpt1.txt"), "lpt1.txt-document.md");
	assert.equal(await save("console"), "console.md");
	assert.equal(await save("A - B  --  C"), "a-b-c.md");
	assert.equal(await save("COM1"), "com1-document.md");
	assert.equal(await save("falcon"), "falcon.md");
	assert.equal(await save("a".repeat(150)), `${"a".repeat(100)}.md`);
	// 100 three-byte characters would be 300 bytes; the stem stops within 200 UTF-8 bytes.
	assert.equal(await save("論".repeat(100)), `${"論".repeat(66)}.md`);
	assert.equal(await save(`${"論".repeat(66)}ab`), `${"論".repeat(66)}ab.md`);
	assert.equal(await save(`${"b".repeat(98)}.-c`), `${"b".repeat(98)}.md`);
});

test("an explicit PDF file name is never overwritten either (#4898)", async () => {
	const outputDir = join(home, "out");
	makeDirectorySync(outputDir);
	writeTextSync(join(outputDir, "paper.md"), "keep");
	const result = await extractPDFToMarkdown(pdfBuffer("Paper"), "https://example.com/paper.pdf", {
		outputDir,
		filename: "paper.md",
	});

	assert.equal(result.outputPath, join(outputDir, "paper-2.md"));
	assert.equal(readTextSync(join(outputDir, "paper.md"), "utf-8"), "keep");
});

test("a PDF that cannot be saved reports the write error (#4898)", async () => {
	await assert.rejects(
		extractPDFToMarkdown(pdfBuffer("Paper"), "https://example.com/paper.pdf", {
			outputDir: join(home, "out"),
			filename: join("missing", "paper.md"),
		}),
		/ENOENT/,
	);
});
