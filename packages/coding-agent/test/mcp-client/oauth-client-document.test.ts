import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { authorizeMcp, McpOAuthProvider, MemoryOAuthStateStore } from "../../src/extensions/mcp/client/oauth/index.js";
import { closeServers, listen, readBody } from "./helpers.js";

afterEach(closeServers);

test("uses a client document's redirect URI for authorization and code exchange without storing the document (#10302)", async () => {
	const tokenRequests: URLSearchParams[] = [];
	const origin = await listen(async (request, response, serverOrigin) => {
		response.setHeader("content-type", "application/json");
		if (request.url === "/.well-known/oauth-protected-resource/mcp") {
			response.end(JSON.stringify({ resource: `${serverOrigin}/mcp`, authorization_servers: [serverOrigin] }));
		} else if (request.url === "/.well-known/oauth-authorization-server") {
			response.end(
				JSON.stringify({
					issuer: serverOrigin,
					authorization_endpoint: `${serverOrigin}/authorize`,
					token_endpoint: `${serverOrigin}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
					client_id_metadata_document_supported: true,
				}),
			);
		} else if (request.url === "/token") {
			tokenRequests.push(new URLSearchParams(await readBody(request)));
			response.end(JSON.stringify({ access_token: "access", token_type: "Bearer", refresh_token: "refresh" }));
		} else {
			response.writeHead(404).end();
		}
	});
	const store = new MemoryOAuthStateStore();
	const document = {
		url: "https://client.example/oauth/client.json",
		redirectUrl: "http://127.0.0.1:8765/callback/server",
	};
	let authorization: URL | undefined;
	const provider = new McpOAuthProvider({
		serverUrl: `${origin}/mcp`,
		redirectUrl: "http://127.0.0.1:8765/callback",
		clientMetadata: { client_name: "test" },
		clientMetadataDocument: (metadata) => {
			assert.equal(metadata?.client_id_metadata_document_supported, true);
			return document;
		},
		store,
		onRedirect: (url) => {
			authorization = url;
		},
	});
	const options = { serverUrl: `${origin}/mcp` };
	assert.equal(await authorizeMcp(provider, options), "REDIRECT");
	assert.ok(authorization);
	assert.equal(authorization.searchParams.get("client_id"), document.url);
	assert.equal(authorization.searchParams.get("redirect_uri"), document.redirectUrl);
	assert.equal(await authorizeMcp(provider, { ...options, authorizationCode: "code" }), "AUTHORIZED");
	assert.equal(tokenRequests[0].get("redirect_uri"), document.redirectUrl);
	assert.equal(tokenRequests[0].get("client_id"), document.url);
	assert.equal(store.load()?.clientInformation, undefined);
	assert.equal(await authorizeMcp(provider, options), "AUTHORIZED");
	assert.equal(tokenRequests[1].get("grant_type"), "refresh_token");
	assert.equal(tokenRequests[1].get("client_id"), document.url);
});
