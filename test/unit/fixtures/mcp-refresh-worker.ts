import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpOAuthProvider } from "../../../packages/mcp/mcp-oauth-provider.js";

const serverUrl = process.argv[2];
class SynchronizedProvider extends McpOAuthProvider {
	override async tokens() {
		const tokens = await super.tokens();
		await fetch(`${serverUrl}/ready`);
		return tokens;
	}
}
const provider = new SynchronizedProvider("rotating", serverUrl, {}, { onRedirect: () => {} });
const result = await auth(provider, { serverUrl, fetchFn: provider.fetch });
await provider.waitForRefresh();
console.log(result);
