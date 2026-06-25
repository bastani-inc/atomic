// DO NOT EDIT: copied from can1357/oh-my-pi commit 15b5c1397fc059673e3b0bcbc50b074e6dc1f9d8 for Atomic issue #1483 parity.
// Ripgrep-backed search engine exported via N-API.
//
// Provides two layers:
// - `search()` for in-memory content search.
// - `grep()` for filesystem search with glob/type filtering.
//
// The filesystem search matches the previous JS wrapper behavior, including
// global offsets, optional match limits, and per-file match summaries.

use std::{
	borrow::Cow,
	fs::File,
	io::{self, Read},
	path::{Path, PathBuf},
	sync::{
		Arc, Mutex,
		atomic::{AtomicU64, Ordering},
	},
};

use globset::GlobSet;
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{
	BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkContextKind, SinkMatch,
};
use ignore::{ParallelVisitor, ParallelVisitorBuilder, WalkState};
use napi::{
	JsString,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use rayon::prelude::*;
use smallvec::SmallVec;

use crate::{fs_cache, glob_util, task};

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const SMALL_FILE_READ_BYTES: u64 = 128 * 1024;
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

enum TypeFilter {
	Known { exts: &'static [&'static str], names: &'static [&'static str] },
	Custom(String),
}

impl TypeFilter {
	fn match_ext(&self, ext: &str) -> bool {
		match self {
			Self::Known { exts, .. } => exts.iter().any(|e| ext.eq_ignore_ascii_case(e)),
			Self::Custom(custom_ext) => ext.eq_ignore_ascii_case(custom_ext),
		}
	}

	fn match_name(&self, name: &str) -> bool {
		match self {
			Self::Known { names, .. } => names.iter().any(|n| name.eq_ignore_ascii_case(n)),
			Self::Custom(ext) => ext.eq_ignore_ascii_case(name),
		}
	}
}

// ---------------------------------------------------------------------------
// Internal match collection
// ---------------------------------------------------------------------------

struct MatchCollector {
	matches: Vec<CollectedMatch>,
	match_count: u64,
	collected_count: u64,
	max_count: Option<u64>,
	offset: u64,
	skipped: u64,
	limit_reached: bool,
	max_columns: Option<usize>,
	collect_matches: bool,
	context_before: SmallVec<[ContextLine; 8]>,
}

struct CollectedMatch {
	line_number: u64,
	line: String,
	context_before: SmallVec<[ContextLine; 8]>,
	context_after: SmallVec<[ContextLine; 8]>,
	truncated: bool,
}

struct SearchResultInternal {
	matches: Vec<CollectedMatch>,
	match_count: u64,
	collected: u64,
	limit_reached: bool,
}

struct FileEntry {
	path: PathBuf,
	relative_path: String,
}

struct FileSearchResult {
	relative_path: String,
	matches: Vec<CollectedMatch>,
	match_count: u64,
	limit_reached: bool,
}

enum FileBytes {
	Mapped(memmap2::Mmap),
	Owned(Vec<u8>),
}

/// Outcome of attempting to read a file for searching.
enum ReadFile {
	Bytes(FileBytes),
	/// File exceeds [`MAX_FILE_BYTES`]; callers count these so the skip can be
	/// surfaced instead of silently returning no matches.
	Oversized,
	/// Unreadable or not a regular file; silently skipped.
	Skipped,
}

impl FileBytes {
	fn as_slice(&self) -> &[u8] {
		match self {
			Self::Mapped(mapped) => mapped.as_ref(),
			Self::Owned(bytes) => bytes.as_slice(),
		}
	}
}

impl MatchCollector {
	fn new(
		max_count: Option<u64>,
		offset: u64,
		max_columns: Option<usize>,
		collect_matches: bool,
	) -> Self {
		Self {
			matches: Vec::new(),
			match_count: 0,
			collected_count: 0,
			max_count,
			offset,
			skipped: 0,
			limit_reached: false,
			max_columns,
			collect_matches,
			context_before: SmallVec::new(),
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn truncate_line(line: String, max_columns: Option<usize>) -> (String, bool) {
	match max_columns {
		Some(max) if line.len() > max => {
			let cut = max.saturating_sub(3);
			let boundary = line.floor_char_boundary(cut);
			(format!("{}...", &line[..boundary]), true)
		},
		_ => (line, false),
	}
}

fn bytes_to_trimmed_string(bytes: &[u8]) -> String {
	match std::str::from_utf8(bytes) {
		Ok(text) => text.trim_end().to_string(),
		Err(_) => String::from_utf8_lossy(bytes).trim_end().to_string(),
	}
}

// ---------------------------------------------------------------------------
// Sink implementation for grep-searcher
// ---------------------------------------------------------------------------

impl Sink for MatchCollector {
	type Error = io::Error;

	fn matched(
		&mut self,
		_searcher: &Searcher,
		mat: &SinkMatch<'_>,
	) -> std::result::Result<bool, Self::Error> {
		self.match_count += 1;

		if self.limit_reached {
			return Ok(false);
		}

		if self.skipped < self.offset {
			self.skipped += 1;
			self.context_before.clear();
			return Ok(true);
		}

		if self.collect_matches {
			let raw_line = bytes_to_trimmed_string(mat.bytes());
			let (line, truncated) = truncate_line(raw_line, self.max_columns);
			let line_number = mat.line_number().unwrap_or(0);

			self.matches.push(CollectedMatch {
				line_number,
				line,
				context_before: std::mem::take(&mut self.context_before),
				context_after: SmallVec::new(),
				truncated,
			});
		} else {
			self.context_before.clear();
		}

		self.collected_count += 1;

		if let Some(max) = self.max_count
			&& self.collected_count >= max
		{
			self.limit_reached = true;
		}

		Ok(true)
	}

	fn context(
		&mut self,
		_searcher: &Searcher,
		ctx: &SinkContext<'_>,
	) -> std::result::Result<bool, Self::Error> {
		if !self.collect_matches {
			return Ok(true);
		}

		let raw_line = bytes_to_trimmed_string(ctx.bytes());
		let (line, _) = truncate_line(raw_line, self.max_columns);
		let line_number = ctx.line_number().unwrap_or(0);

		match ctx.kind() {
			SinkContextKind::Before => {
				self
					.context_before
					.push(ContextLine { line_number: crate::clamp_u32(line_number), line });
			},
			SinkContextKind::After => {
				if let Some(last_match) = self.matches.last_mut() {
					last_match
						.context_after
						.push(ContextLine { line_number: crate::clamp_u32(line_number), line });
				}
			},
			SinkContextKind::Other => {},
		}

		Ok(true)
	}
}

// ---------------------------------------------------------------------------
// Option resolution
// ---------------------------------------------------------------------------
