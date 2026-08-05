// DO NOT EDIT: copied from can1357/oh-my-pi commit 15b5c1397fc059673e3b0bcbc50b074e6dc1f9d8 for Atomic issue #1483 parity.
// Ripgrep-backed search engine exported via N-API.
//
// Provides two layers:
// - `search()` for in-memory content search.
// - `grep()` for filesystem search with glob/type filtering.
//
// The filesystem search matches the previous JS wrapper behavior, including
// global offsets, optional match limits, and per-file match summaries.

use grep_matcher::Matcher;
use napi::{JsString, bindgen_prelude::*, threadsafe_function::ThreadsafeFunction};
use napi_derive::napi;

use crate::task;

const DEFAULT_NATIVE_GREP_MAX_COUNT: u64 = 100_000;

/// Output mode for [`search`] and [`grep`] (string values match JS callers).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum GrepOutputMode {
	/// Emit matched lines (and optional context lines).
	#[napi(value = "content")]
	Content,
	/// Emit per-file or total counts instead of line content.
	#[napi(value = "count")]
	Count,
	/// Emit one row per file that matched, without line content.
	#[napi(value = "filesWithMatches")]
	FilesWithMatches,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutputMode {
	Content,
	Count,
	FilesWithMatches,
}

/// Options for searching file content.
#[napi(object)]
pub struct SearchOptions {
	/// Regex pattern to search for.
	pub pattern: String,
	/// Case-insensitive search.
	pub ignore_case: Option<bool>,
	/// Enable multiline matching.
	pub multiline: Option<bool>,
	/// Maximum number of matches to return.
	pub max_count: Option<u32>,
	/// Skip first N matches.
	pub offset: Option<u32>,
	/// Lines of context before matches.
	pub context_before: Option<u32>,
	/// Lines of context after matches.
	pub context_after: Option<u32>,
	/// Lines of context before/after matches (legacy).
	pub context: Option<u32>,
	/// Truncate lines longer than this (characters).
	pub max_columns: Option<u32>,
	/// Output mode (content or count).
	pub mode: Option<GrepOutputMode>,
}

/// Options for searching files on disk.
#[napi(object)]
pub struct GrepOptions<'env> {
	/// Regex pattern to search for.
	pub pattern: String,
	/// Directory or file to search.
	pub path: String,
	/// Workspace/root used to evaluate path-qualified glob filters for explicit files.
	pub cwd: Option<String>,
	/// Glob filter for filenames (e.g., "*.ts").
	pub glob: Option<String>,
	/// Filter by file type (e.g., "js", "py", "rust").
	pub r#type: Option<String>,
	/// Case-insensitive search.
	pub ignore_case: Option<bool>,
	/// Enable multiline matching.
	pub multiline: Option<bool>,
	/// Include hidden files (default: true).
	pub hidden: Option<bool>,
	/// Respect .gitignore files (default: true).
	pub gitignore: Option<bool>,
	/// Enable shared filesystem scan cache (default: false).
	pub cache: Option<bool>,
	/// Maximum number of matches to return.
	pub max_count: Option<u32>,
	/// Skip first N matches.
	pub offset: Option<u32>,
	/// Lines of context before matches.
	pub context_before: Option<u32>,
	/// Lines of context after matches.
	pub context_after: Option<u32>,
	/// Lines of context before/after matches (legacy).
	pub context: Option<u32>,
	/// Truncate lines longer than this (characters).
	pub max_columns: Option<u32>,
	/// Output mode (content, filesWithMatches, or count).
	pub mode: Option<GrepOutputMode>,
	/// Maximum matches collected per file (content mode). Keeps one hot file
	/// from exhausting the global `max_count` budget before other files are
	/// reached.
	pub max_count_per_file: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal: Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms: Option<u32>,
}

/// A context line (before or after a match).
#[derive(Clone)]
#[napi(object)]
pub struct ContextLine {
	/// 1-indexed line number in the source file.
	pub line_number: u32,
	/// Raw line content (trimmed line ending).
	pub line: String,
}

/// A single match in the content.
#[napi(object)]
pub struct Match {
	/// 1-indexed line number.
	pub line_number: u32,
	/// The matched line content.
	pub line: String,
	/// Context lines before the match.
	pub context_before: Option<Vec<ContextLine>>,
	/// Context lines after the match.
	pub context_after: Option<Vec<ContextLine>>,
	/// Whether the line was truncated.
	pub truncated: Option<bool>,
}

/// Result of searching content.
#[napi(object)]
pub struct SearchResult {
	/// All matches found.
	pub matches: Vec<Match>,
	/// Total number of matches (may exceed `matches.len()` due to offset/limit).
	pub match_count: u32,
	/// Whether the limit was reached.
	pub limit_reached: bool,
	/// Error message, if any.
	pub error: Option<String>,
}

/// A single match in a grep result.
#[derive(Clone)]
#[napi(object)]
pub struct GrepMatch {
	/// File path for the match (relative for directory searches).
	pub path: String,
	/// 1-indexed line number (0 for count-only entries).
	pub line_number: u32,
	/// The matched line content (empty for count-only entries).
	pub line: String,
	/// Context lines before the match.
	pub context_before: Option<Vec<ContextLine>>,
	/// Context lines after the match.
	pub context_after: Option<Vec<ContextLine>>,
	/// Whether the line was truncated.
	pub truncated: Option<bool>,
	/// Per-file match count (count mode only).
	pub match_count: Option<u32>,
}

/// Result of searching files.
#[napi(object)]
pub struct GrepResult {
	/// Matches or per-file counts, depending on output mode.
	pub matches: Vec<GrepMatch>,
	/// Total matches across all files, or matched file count in filesWithMatches
	/// mode.
	pub total_matches: u32,
	/// Number of files with at least one match.
	pub files_with_matches: u32,
	/// Number of files searched.
	pub files_searched: u32,
	/// Whether the limit/offset stopped the search early.
	pub limit_reached: Option<bool>,
	/// Number of files skipped because they exceed the size limit.
	pub skipped_oversized: Option<u32>,
}

#[derive(Clone, Copy)]
struct SearchParams {
	context_before: u32,
	context_after: u32,
	max_columns: Option<u32>,
	mode: OutputMode,
	max_count: Option<u64>,
	max_count_per_file: Option<u64>,
	offset: u64,
	multiline: bool,
}

const fn empty_search_result(error: Option<String>) -> SearchResult {
	SearchResult { matches: Vec::new(), match_count: 0, limit_reached: false, error }
}

/// Internal configuration for grep, extracted from options.
struct GrepConfig {
	pattern: String,
	path: String,
	cwd: Option<String>,
	glob: Option<String>,
	type_filter: Option<String>,
	ignore_case: Option<bool>,
	multiline: Option<bool>,
	hidden: Option<bool>,
	gitignore: Option<bool>,
	cache: Option<bool>,
	max_count: Option<u32>,
	offset: Option<u32>,
	context_before: Option<u32>,
	context_after: Option<u32>,
	context: Option<u32>,
	max_columns: Option<u32>,
	mode: Option<GrepOutputMode>,
	max_count_per_file: Option<u32>,
}

// ---------------------------------------------------------------------------
// N-API exports
// ---------------------------------------------------------------------------

/// Search content for a pattern (one-shot, compiles pattern each time).
/// For repeated searches with the same pattern, use [`grep`] with file filters.
///
/// # Arguments
/// - `content`: `Uint8Array`/`Buffer` (zero-copy) or `string` (UTF-8).
/// - `options`: Regex settings, context, and output mode.
///
/// # Returns
/// Match list plus counts/limit status; errors are surfaced in `error`.
#[napi]
pub fn search(content: Either<JsString, Uint8Array>, options: SearchOptions) -> SearchResult {
	match &content {
		Either::A(js_str) => {
			let utf8 = match js_str.into_utf8() {
				Ok(utf8) => utf8,
				Err(err) => return empty_search_result(Some(err.to_string())),
			};
			search_sync(utf8.as_slice(), options)
		},
		Either::B(buf) => search_sync(buf.as_ref(), options),
	}
}

/// Quick check if content matches a pattern.
///
/// # Arguments
/// - `content`: `Uint8Array`/`Buffer` (zero-copy) or `string` (UTF-8).
/// - `pattern`: `Uint8Array`/`Buffer` (zero-copy) or `string` (UTF-8).
/// - `ignore_case`: Case-insensitive matching.
/// - `multiline`: Enable multiline regex mode.
///
/// # Returns
/// True if any match exists; false on no match.
#[napi]
pub fn has_match(
	content: Either<JsString, Uint8Array>,
	pattern: Either<JsString, Uint8Array>,
	ignore_case: Option<bool>,
	multiline: Option<bool>,
) -> Result<bool> {
	// Hold JsStringUtf8 on the stack and borrow - no copy
	let content_utf8;
	let content_slice: &[u8] = match &content {
		Either::A(js_str) => {
			content_utf8 = js_str.into_utf8()?;
			content_utf8.as_slice()
		},
		Either::B(buf) => buf.as_ref(),
	};

	let pattern_utf8;
	let pattern_string;
	let pattern_ref: &str = match &pattern {
		Either::A(js_str) => {
			pattern_utf8 = js_str.into_utf8()?;
			pattern_utf8.as_str()?
		},
		Either::B(buf) => {
			pattern_string = std::str::from_utf8(buf.as_ref())
				.map_err(|err| Error::from_reason(format!("Invalid UTF-8 in pattern: {err}")))?
				.to_owned();
			&pattern_string
		},
	};

	let matcher =
		build_matcher(pattern_ref, ignore_case.unwrap_or(false), multiline.unwrap_or(false))?;
	Ok(matcher.is_match(content_slice).unwrap_or(false))
}

/// Search files for a regex pattern.
///
/// # Arguments
/// - `options`: Pattern, path, filters, and output mode.
/// - `on_match`: Optional callback invoked per match/result.
///
/// # Returns
/// Aggregated results across matching files.
#[napi]
pub fn grep(
	options: GrepOptions<'_>,
	#[napi(ts_arg_type = "((error: Error | null, match: GrepMatch) => void) | undefined | null")]
	on_match: Option<ThreadsafeFunction<GrepMatch>>,
) -> task::Promise<GrepResult> {
	let GrepOptions {
		pattern,
		path,
		cwd,
		glob,
		r#type,
		ignore_case,
		multiline,
		hidden,
		gitignore,
		cache,
		max_count,
		offset,
		context_before,
		context_after,
		context,
		max_columns,
		mode,
		max_count_per_file,
		timeout_ms,
		signal,
	} = options;

	let config = GrepConfig {
		pattern,
		path,
		cwd,
		glob,
		type_filter: r#type,
		ignore_case,
		multiline,
		hidden,
		gitignore,
		cache,
		max_count,
		max_count_per_file,
		offset,
		context_before,
		context_after,
		context,
		max_columns,
		mode,
	};
	let ct = task::CancelToken::new(timeout_ms, signal);
	task::blocking("grep", ct, move |ct| grep_sync(config, on_match.as_ref(), ct))
}

mod engine;
mod fs;
mod output;
mod pattern;
mod run;
mod walk;

pub use pattern::build_matcher;
use run::{grep_sync, search_sync};
