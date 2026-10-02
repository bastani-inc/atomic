import type { ExtensionAPI } from "@bastani/atomic";

export default function providerAccounts(pi: ExtensionAPI) {
	for (let account = 1; account <= 7; account++) {
		pi.registerProviderAlias({
			id: `openai-${account}`,
			name: `OpenAI account ${account}`,
			provider: "openai",
		});
	}
}
