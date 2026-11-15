import { redactUrlCredentials } from "../error-contract.ts";

/**
 * Remove credentials from every URL in `value`, so remotes never leak secrets into errors or records. An `ssh://`
 * user name is an account, not a secret, and is kept without any password; other schemes lose their user info, where
 * tokens usually travel. User info runs to the last `@` of the authority, so a secret containing `@` is removed whole.
 */
export function redactCredentials(value: string): string {
	return redactUrlCredentials(value, "text", { keepSshUser: true });
}
