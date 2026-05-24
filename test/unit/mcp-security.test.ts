import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { escapeHtmlAttribute } from "../../packages/mcp/host-html-template.ts";
import {
  handleRequest,
  renderCallbackErrorHtml,
  waitForCallback,
} from "../../packages/mcp/mcp-callback-server.ts";
import { OAUTH_CALLBACK_PATH } from "../../packages/mcp/mcp-oauth-provider.ts";

describe("MCP HTML security helpers", () => {
  test("does not reflect OAuth callback error details into HTML", () => {
    const html = renderCallbackErrorHtml();

    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /alert\("xss"\)/i);
    assert.match(html, /Return to Atomic and try again\./);
  });

  test("OAuth callback error responses do not reflect query-string script content", async () => {
    const server = createServer(handleRequest);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP test server");
    const pending = waitForCallback("state-x");
    const pendingRejection = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    let html = "";
    let status = 0;
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}?state=state-x&error=${encodeURIComponent("<script>alert(1)</script>")}&error_description=${encodeURIComponent("<SCRIPT>alert(2)</SCRIPT>")}`,
      );
      status = response.status;
      html = await response.text();
    } finally {
      server.close();
    }

    assert.equal(status, 200);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /alert\([12]\)/i);
    const rejection = await pendingRejection;
    assert.ok(rejection instanceof Error);
    assert.match(rejection.message, /<SCRIPT>alert\(2\)<\/SCRIPT>/);
  });

  test("escapes iframe src attribute values", () => {
    assert.equal(
      escapeHtmlAttribute(`http://127.0.0.1/?q=" onload="alert(1)&x=<tag>`),
      "http://127.0.0.1/?q=&quot; onload=&quot;alert(1)&amp;x=&lt;tag&gt;",
    );
  });
});
