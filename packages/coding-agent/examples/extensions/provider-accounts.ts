import type { ExtensionAPI } from "@bastani/atomic";

export default function providerAccounts(atomic: ExtensionAPI) {
	for (let account = 1; account <= 7; account++) {
		atomic.registerProviderAlias({
			id: `openai-${account}`,
			name: `OpenAI account ${account}`,
			provider: "openai",
		});
	}
}
