import { once } from "node:events";
import { FileAuthStorageBackend } from "../../../src/core/auth-storage.ts";
import { McpOAuthCredentialStore } from "../../../src/extensions/mcp/oauth.ts";

const [path, lockDir, url] = process.argv.slice(2);
if (!path || !lockDir || !url) throw new Error("Expected credential path, lock directory, and synthetic server URL");
const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(path), lockDir);
const store = credentials.forServer("test", url);
const flow = store.fenced();
await store.withRefreshLock(async () => {
	console.log("locked");
	await once(process.stdin, "data");
	await flow.save({ serverUrl: url, tokens: { access_token: "rotated", token_type: "Bearer" } });
});
console.log("saved");
await once(process.stdin, "data");
try {
	await flow.save({ serverUrl: url, tokens: { access_token: "late-sign-in", token_type: "Bearer" } });
	throw new Error("Revoked flow wrote credentials after logout");
} catch (error) {
	if (!(error instanceof Error) || error.name !== "McpSignInCancelledError") throw error;
}
console.log("fenced");
process.stdin.destroy();
