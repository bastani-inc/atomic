// Per-buffer search engine and match collection for native grep.

use std::io;

use grep_matcher::Matcher;
use grep_searcher::{
	BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkContextKind, SinkMatch,
};
use smallvec::SmallVec;

use super::{ContextLine, OutputMode, SearchParams};

// ---------------------------------------------------------------------------
// Internal match collection
// ---------------------------------------------------------------------------

struct MatchCollector<'m> {
	matcher: &'m grep_regex::RegexMatcher,
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

pub(super) struct CollectedMatch {
	pub(super) line_number: u64,
	pub(super) line: String,
	pub(super) context_before: SmallVec<[ContextLine; 8]>,
	pub(super) context_after: SmallVec<[ContextLine; 8]>,
	pub(super) truncated: bool,
}

pub(super) struct SearchResultInternal {
	pub(super) matches: Vec<CollectedMatch>,
	pub(super) match_count: u64,
	pub(super) collected: u64,
	pub(super) limit_reached: bool,
}

impl<'m> MatchCollector<'m> {
	fn new(
		matcher: &'m grep_regex::RegexMatcher,
		max_count: Option<u64>,
		offset: u64,
		max_columns: Option<usize>,
		collect_matches: bool,
	) -> Self {
		Self {
			matcher,
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

/// Truncates `line` to `max_columns` bytes, ellipses included. When `first_match` (a byte range) ends past
/// the kept head, the kept window moves to show the match instead, with "..." on each cut side.
fn truncate_line(
	line: String,
	max_columns: Option<usize>,
	first_match: Option<(usize, usize)>,
) -> (String, bool) {
	match max_columns {
		Some(max) if line.len() > max => {
			let cut = max.saturating_sub(3);
			match first_match {
				Some((start, end)) if end > cut => {
					let budget = max.saturating_sub(6);
					let match_len = end.saturating_sub(start).min(budget);
					let window_start = start
						.saturating_sub((budget - match_len) / 2)
						.min(line.len().saturating_sub(budget));
					let window_start = line.floor_char_boundary(window_start);
					let window_end = line.floor_char_boundary((window_start + budget).min(line.len()));
					let prefix = if window_start > 0 { "..." } else { "" };
					let suffix = if window_end < line.len() { "..." } else { "" };
					(format!("{prefix}{}{suffix}", &line[window_start..window_end]), true)
				},
				_ => {
					let boundary = line.floor_char_boundary(cut);
					(format!("{}...", &line[..boundary]), true)
				},
			}
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

impl Sink for MatchCollector<'_> {
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
			let first_match = match self.max_columns {
				Some(max) if raw_line.len() > max => self
					.matcher
					.find(mat.bytes())
					.ok()
					.flatten()
					.map(|found| (found.start(), found.end())),
				_ => None,
			};
			let (line, truncated) = truncate_line(raw_line, self.max_columns, first_match);
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
		let (line, _) = truncate_line(raw_line, self.max_columns, None);
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
// Search engine
// ---------------------------------------------------------------------------

pub(super) fn run_search(
	matcher: &grep_regex::RegexMatcher,
	content: &[u8],
	params: SearchParams,
) -> io::Result<SearchResultInternal> {
	run_search_slice(&mut build_searcher_for_params(params), matcher, content, params)
}

pub(super) fn run_search_slice(
	searcher: &mut Searcher,
	matcher: &grep_regex::RegexMatcher,
	content: &[u8],
	params: SearchParams,
) -> io::Result<SearchResultInternal> {
	let mut collector = MatchCollector::new(
		matcher,
		params.max_count,
		params.offset,
		params.max_columns.map(|v| v as usize),
		params.mode == OutputMode::Content,
	);
	searcher.search_slice(matcher, content, &mut collector)?;
	Ok(SearchResultInternal {
		matches: collector.matches,
		match_count: collector.match_count,
		collected: collector.collected_count,
		limit_reached: collector.limit_reached,
	})
}

pub(super) fn build_searcher_for_params(params: SearchParams) -> Searcher {
	build_searcher(
		if params.mode == OutputMode::Content { params.context_before } else { 0 },
		if params.mode == OutputMode::Content { params.context_after } else { 0 },
		params.multiline,
	)
}

fn build_searcher(context_before: u32, context_after: u32, multiline: bool) -> Searcher {
	SearcherBuilder::new()
		.binary_detection(BinaryDetection::quit(b'\x00'))
		.line_number(true)
		.multi_line(multiline)
		.before_context(context_before as usize)
		.after_context(context_after as usize)
		.build()
}

pub(super) fn per_file_params(params: SearchParams) -> SearchParams {
	let file_limit = match params.mode {
		OutputMode::Content => {
			let global = params.max_count.map(|max| max.saturating_add(params.offset));
			match (global, params.max_count_per_file) {
				(Some(global), Some(per_file)) => Some(global.min(per_file)),
				(global, per_file) => global.or(per_file),
			}
		},
		OutputMode::Count => None,
		OutputMode::FilesWithMatches => Some(1),
	};
	SearchParams { max_count: file_limit, offset: 0, ..params }
}
