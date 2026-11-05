const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

/** Remove `user:token@` credentials from every URL in `value`, so remotes never leak secrets into errors or records. */
export function redactCredentials(value: string): string {
	return value.replace(URL_USERINFO, "$1");
}
