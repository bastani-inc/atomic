/** The scheme is bounded, so a long run of scheme characters cannot make the scan quadratic. */
const URL_USERINFO = /([a-z][a-z0-9+.-]{0,31}):\/\/([^/@\s]+)@/gi;

/**
 * Remove credentials from every URL in `value`, so remotes never leak secrets into errors or records. An `ssh://`
 * user name is an account, not a secret, and is kept without any password; other schemes lose their user info, where
 * tokens usually travel.
 */
export function redactCredentials(value: string): string {
	return value.replace(URL_USERINFO, (_match, scheme: string, userinfo: string) =>
		scheme.toLowerCase() === "ssh" ? `${scheme}://${userinfo.split(":")[0]}@` : `${scheme}://`,
	);
}
