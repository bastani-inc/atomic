// Regex hygiene and matcher construction for native grep.

use std::borrow::Cow;

use grep_regex::RegexMatcherBuilder;
use napi::bindgen_prelude::{Error, Result};

// ---------------------------------------------------------------------------
// Regex brace sanitization
// ---------------------------------------------------------------------------

/// Check if `bytes[start]` (which must be `b'{'`) begins a valid repetition
/// quantifier: `{N}`, `{N,}`, or `{N,M}` where N and M are decimal digits.
/// Returns the byte index of the closing `}` if valid.
fn find_valid_repetition(bytes: &[u8], start: usize) -> Option<usize> {
	let len = bytes.len();
	let mut i = start + 1;
	// Must start with at least one digit.
	if i >= len || !bytes[i].is_ascii_digit() {
		return None;
	}
	while i < len && bytes[i].is_ascii_digit() {
		i += 1;
	}
	if i >= len {
		return None;
	}
	if bytes[i] == b'}' {
		return Some(i);
	}
	if bytes[i] != b',' {
		return None;
	}
	i += 1;
	if i >= len {
		return None;
	}
	// After comma: optional digits then `}`.
	while i < len && bytes[i].is_ascii_digit() {
		i += 1;
	}
	if i < len && bytes[i] == b'}' {
		return Some(i);
	}
	None
}

fn find_braced_escape_end(bytes: &[u8], start: usize) -> Option<usize> {
	let mut i = start + 1;
	while i < bytes.len() {
		if bytes[i] == b'}' {
			return Some(i);
		}
		i += 1;
	}
	None
}

/// Escape `{` and `}` that don't form valid repetition quantifiers.
///
/// Patterns like `${platform}` or `a{b}` contain braces the regex engine
/// rejects as malformed repetitions. Since such braces can never be valid
/// regex syntax, turning them into `\{` / `\}` is semantics-preserving
/// and avoids confusing error messages for callers who pass literal text
/// fragments (e.g. JS template strings).
fn sanitize_braces(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.contains(&b'{') && !bytes.contains(&b'}') {
		return Cow::Borrowed(pattern);
	}

	let len = bytes.len();
	let mut result = String::with_capacity(len + 8);
	let mut modified = false;
	let mut i = 0;

	while i < len {
		// Pass escaped characters through unchanged.
		if bytes[i] == b'\\' && i + 1 < len {
			result.push('\\');
			i += 1;
			// The next character is the escaped literal; push it regardless.
			// Safety: index is in bounds (checked above).
			let ch = pattern[i..].chars().next().expect("non-empty slice has a char");
			result.push(ch);
			i += ch.len_utf8();
			if matches!(ch, 'p' | 'P' | 'x' | 'u') && i < len && bytes[i] == b'{' {
				if let Some(end) = find_braced_escape_end(bytes, i) {
					result.push_str(&pattern[i..=end]);
					i = end + 1;
				} else {
					result.push_str(&pattern[i..]);
					i = len;
				}
			}
			continue;
		}

		if bytes[i] == b'{' {
			if let Some(end) = find_valid_repetition(bytes, i) {
				result.push_str(&pattern[i..=end]);
				i = end + 1;
				continue;
			}
			result.push_str("\\{");
			i += 1;
			modified = true;
			continue;
		}

		if bytes[i] == b'}' {
			result.push_str("\\}");
			i += 1;
			modified = true;
			continue;
		}

		let ch = pattern[i..].chars().next().expect("non-empty slice has a char");
		result.push(ch);
		i += ch.len_utf8();
	}

	if modified { Cow::Owned(result) } else { Cow::Borrowed(pattern) }
}

/// Escape unescaped parentheses after a group-syntax regex error.
///
/// Search patterns like `fetchAnthropicProvider(` are common literal snippets,
/// but the regex engine parses the trailing `(` as the start of a capture
/// group. When the parser already reported invalid group syntax, escaping any
/// remaining literal parentheses preserves useful search behavior without
/// changing valid regexes.
fn escape_unescaped_parentheses(pattern: &str) -> Cow<'_, str> {
	let bytes = pattern.as_bytes();
	if !bytes.contains(&b'(') && !bytes.contains(&b')') {
		return Cow::Borrowed(pattern);
	}

	let mut result = String::with_capacity(pattern.len() + 4);
	let mut modified = false;
	let mut i = 0;

	while i < bytes.len() {
		if bytes[i] == b'\\' && i + 1 < bytes.len() {
			result.push('\\');
			i += 1;
			let ch = pattern[i..].chars().next().expect("non-empty slice has a char");
			result.push(ch);
			i += ch.len_utf8();
			continue;
		}

		let ch = pattern[i..].chars().next().expect("non-empty slice has a char");
		if matches!(ch, '(' | ')') {
			result.push('\\');
			modified = true;
		}
		result.push(ch);
		i += ch.len_utf8();
	}

	if modified { Cow::Owned(result) } else { Cow::Borrowed(pattern) }
}

fn build_regex_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> std::result::Result<grep_regex::RegexMatcher, grep_regex::Error> {
	RegexMatcherBuilder::new().case_insensitive(ignore_case).multi_line(multiline).build(pattern)
}

pub fn build_matcher(
	pattern: &str,
	ignore_case: bool,
	multiline: bool,
) -> Result<grep_regex::RegexMatcher> {
	let sanitized = sanitize_braces(pattern);
	match build_regex_matcher(sanitized.as_ref(), ignore_case, multiline) {
		Ok(matcher) => Ok(matcher),
		Err(err) => {
			let message = err.to_string();
			if message.contains("unclosed group") || message.contains("unopened group") {
				let escaped = escape_unescaped_parentheses(sanitized.as_ref());
				if escaped.as_ref() != sanitized.as_ref() {
					return build_regex_matcher(escaped.as_ref(), ignore_case, multiline)
						.map_err(|retry_err| Error::from_reason(format!("Regex error: {retry_err}")));
				}
			}
			Err(Error::from_reason(format!("Regex error: {message}")))
		},
	}
}

#[cfg(test)]
mod tests {
	use super::{escape_unescaped_parentheses, sanitize_braces};

	#[test]
	fn preserves_unicode_property_escapes() {
		assert_eq!(sanitize_braces(r"\p{Greek}").as_ref(), r"\p{Greek}");
	}

	#[test]
	fn preserves_hex_brace_escapes() {
		assert_eq!(sanitize_braces(r"\x{41}").as_ref(), r"\x{41}");
	}

	#[test]
	fn preserves_malformed_braced_escapes() {
		assert_eq!(sanitize_braces(r"\p{Greek").as_ref(), r"\p{Greek");
	}

	#[test]
	fn escapes_non_quantifier_braces() {
		assert_eq!(sanitize_braces("${platform}").as_ref(), "$\\{platform\\}");
	}

	#[test]
	fn preserves_valid_quantifiers() {
		assert_eq!(sanitize_braces("a{2,4}").as_ref(), "a{2,4}");
	}

	#[test]
	fn preserves_escaped_parentheses() {
		assert_eq!(escape_unescaped_parentheses(r"foo\(bar\)").as_ref(), r"foo\(bar\)");
	}

	#[test]
	fn escapes_literal_parentheses() {
		assert_eq!(
			escape_unescaped_parentheses("fetchAnthropicProvider(").as_ref(),
			r"fetchAnthropicProvider\("
		);
		assert_eq!(
			escape_unescaped_parentheses("fetchAnthropicProvider()").as_ref(),
			r"fetchAnthropicProvider\(\)"
		);
	}
}
