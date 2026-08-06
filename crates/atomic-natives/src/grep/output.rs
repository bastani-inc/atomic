// Result shaping and aggregation for native grep.

use super::{
	GrepMatch, Match, OutputMode, SearchParams, engine::CollectedMatch, walk::FileSearchResult,
};

// ---------------------------------------------------------------------------
// Result conversion
// ---------------------------------------------------------------------------

pub(super) fn to_public_match(matched: CollectedMatch) -> Match {
	let context_before = if matched.context_before.is_empty() {
		None
	} else {
		Some(matched.context_before.into_vec())
	};
	let context_after =
		if matched.context_after.is_empty() { None } else { Some(matched.context_after.into_vec()) };
	Match {
		line_number: crate::clamp_u32(matched.line_number),
		line: matched.line,
		context_before,
		context_after,
		truncated: if matched.truncated { Some(true) } else { None },
	}
}

fn to_grep_match(path: String, matched: CollectedMatch) -> GrepMatch {
	let context_before = if matched.context_before.is_empty() {
		None
	} else {
		Some(matched.context_before.into_vec())
	};
	let context_after =
		if matched.context_after.is_empty() { None } else { Some(matched.context_after.into_vec()) };
	GrepMatch {
		path,
		line_number: crate::clamp_u32(matched.line_number),
		line: matched.line,
		context_before,
		context_after,
		truncated: if matched.truncated { Some(true) } else { None },
		match_count: None,
	}
}

pub(super) fn push_content_matches(
	matches: &mut Vec<GrepMatch>,
	path: String,
	collected_matches: Vec<CollectedMatch>,
) {
	let last_index = collected_matches.len().saturating_sub(1);
	let mut path = Some(path);
	for (index, matched) in collected_matches.into_iter().enumerate() {
		let match_path = if index == last_index {
			path.take().expect("path is available for final match")
		} else {
			path.as_ref().expect("path is available for cloned matches").clone()
		};
		matches.push(to_grep_match(match_path, matched));
	}
}

fn push_count_match(matches: &mut Vec<GrepMatch>, path: String, match_count: u64) {
	matches.push(GrepMatch {
		path,
		line_number: 0,
		line: String::new(),
		context_before: None,
		context_after: None,
		truncated: None,
		match_count: Some(crate::clamp_u32(match_count)),
	});
}

fn push_file_match(matches: &mut Vec<GrepMatch>, path: String) {
	matches.push(GrepMatch {
		path,
		line_number: 0,
		line: String::new(),
		context_before: None,
		context_after: None,
		truncated: None,
		match_count: None,
	});
}

pub(super) fn aggregate_parallel_results(
	results: Vec<FileSearchResult>,
	params: SearchParams,
) -> (Vec<GrepMatch>, u64, u32, u32, bool) {
	let SearchParams { mode, max_count, offset, .. } = params;
	let mut matches = Vec::new();
	let mut total_matches = 0u64;
	let mut files_with_matches = 0u32;
	let files_searched = crate::clamp_u32(results.len() as u64);
	let mut skipped = 0u64;
	let mut emitted = 0u64;
	let mut limit_reached = false;

	for result in results {
		if result.match_count == 0 {
			continue;
		}

		let file_match_start = total_matches;
		let file_match_count = result.match_count;
		files_with_matches = files_with_matches.saturating_add(1);
		total_matches = total_matches.saturating_add(file_match_count);

		match mode {
			OutputMode::Content => {
				let mut selected_matches = Vec::new();
				for matched in result.matches {
					if skipped < offset {
						skipped += 1;
						continue;
					}
					if let Some(max) = max_count
						&& emitted >= max
					{
						limit_reached = true;
						break;
					}
					selected_matches.push(matched);
					emitted += 1;
				}
				if !selected_matches.is_empty() {
					push_content_matches(&mut matches, result.relative_path, selected_matches);
				}
				if result.limit_reached && skipped >= offset {
					limit_reached = true;
				}
			},
			OutputMode::Count => {
				let skipped_in_file = offset.saturating_sub(file_match_start).min(file_match_count);
				let available = file_match_count.saturating_sub(skipped_in_file);
				if available == 0 {
					continue;
				}
				if let Some(max) = max_count
					&& emitted >= max
				{
					limit_reached = true;
					continue;
				}
				let remaining = max_count.map_or(available, |max| max.saturating_sub(emitted));
				if remaining == 0 {
					limit_reached = true;
					continue;
				}
				push_count_match(&mut matches, result.relative_path, result.match_count);
				let selected = available.min(remaining);
				emitted = emitted.saturating_add(selected);
				if selected < available {
					limit_reached = true;
				}
			},
			OutputMode::FilesWithMatches => {
				if skipped < offset {
					skipped += 1;
					continue;
				}
				if let Some(max) = max_count
					&& emitted >= max
				{
					limit_reached = true;
					continue;
				}
				push_file_match(&mut matches, result.relative_path);
				emitted += 1;
			},
		}
	}

	if let Some(max) = max_count
		&& emitted >= max
	{
		limit_reached = true;
	}

	if max_count == Some(0) {
		limit_reached = files_with_matches > 0;
	}

	(matches, total_matches, files_with_matches, files_searched, limit_reached)
}
