import { stripProviderCredentials } from "./helpers/provider-credential-env.js";

/**
 * Tests must see the providers their fixtures register, not the developer's.
 * A provider credential exported in the shell makes that provider's catalog
 * available, so `auto` routing and model fallback can pick it, and a live child
 * can try to reach it. Clear inherited provider credentials and endpoints in the
 * runner before workers and their subprocesses start. Tests that need one set it
 * themselves; live provider suites opt back in with
 * `ATOMIC_TEST_KEEP_PROVIDER_CREDENTIALS=1`.
 */
export default function setup(): void {
	stripProviderCredentials();
}
