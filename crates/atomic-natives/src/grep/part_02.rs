const fn parse_output_mode(mode: Option<GrepOutputMode>) -> OutputMode {
	match mode {
		None | Some(GrepOutputMode::Content) => OutputMode::Content,
		Some(GrepOutputMode::Count) => OutputMode::Count,
		Some(GrepOutputMode::FilesWithMatches) => OutputMode::FilesWithMatches,
	}
}

fn resolve_search_path(path: &str) -> Result<PathBuf> {
	let candidate = PathBuf::from(path);
	if candidate.is_absolute() {
		return Ok(candidate);
	}
	let cwd = std::env::current_dir()
		.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
	Ok(cwd.join(candidate))
}

fn resolve_type_filter(type_name: Option<&str>) -> Option<TypeFilter> {
	let normalized = type_name
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(|value| value.trim_start_matches('.').to_lowercase())?;

	let (exts, names): (&[&str], &[&str]) = match normalized.as_str() {
		"js" | "javascript" => (&["js", "jsx", "mjs", "cjs"], &[]),
		"ts" | "typescript" => (&["ts", "tsx", "mts", "cts"], &[]),
		"json" => (&["json", "jsonc", "json5"], &[]),
		"yaml" | "yml" => (&["yaml", "yml"], &[]),
		"toml" => (&["toml"], &[]),
		"md" | "markdown" => (&["md", "markdown", "mdx"], &[]),
		"py" | "python" => (&["py", "pyi"], &[]),
		"rs" | "rust" => (&["rs"], &[]),
		"go" => (&["go"], &[]),
		"java" => (&["java"], &[]),
		"kt" | "kotlin" => (&["kt", "kts"], &[]),
		"c" => (&["c", "h"], &[]),
		"cpp" | "cxx" => (&["cpp", "cc", "cxx", "hpp", "hxx", "hh"], &[]),
		"cs" | "csharp" => (&["cs", "csx"], &[]),
		"php" => (&["php", "phtml"], &[]),
		"rb" | "ruby" => (&["rb", "rake", "gemspec"], &[]),
		"sh" | "bash" => (&["sh", "bash", "zsh"], &[]),
		"zsh" => (&["zsh"], &[]),
		"fish" => (&["fish"], &[]),
		"html" => (&["html", "htm"], &[]),
		"css" => (&["css"], &[]),
		"scss" => (&["scss"], &[]),
		"sass" => (&["sass"], &[]),
		"less" => (&["less"], &[]),
		"xml" => (&["xml"], &[]),
		"docker" | "dockerfile" => (&[], &["dockerfile"]),
		"make" | "makefile" => (&[], &["makefile"]),
		_ => {
			return Some(TypeFilter::Custom(normalized));
		},
	};

	Some(TypeFilter::Known { exts, names })
}

fn matches_type_filter(path: &Path, filter: &TypeFilter) -> bool {
	let base_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
	if filter.match_name(base_name) {
		return true;
	}
	let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
	if ext.is_empty() {
		return false;
	}
	filter.match_ext(ext)
}

fn resolve_context(
	context: Option<u32>,
	context_before: Option<u32>,
	context_after: Option<u32>,
) -> (u32, u32) {
	if context_before.is_some() || context_after.is_some() {
		(context_before.unwrap_or(0), context_after.unwrap_or(0))
	} else {
		let value = context.unwrap_or(0);
		(value, value)
	}
}

// ---------------------------------------------------------------------------
// Search engine
// ---------------------------------------------------------------------------

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

fn run_search(
	matcher: &grep_regex::RegexMatcher,
	content: &[u8],
	params: SearchParams,
) -> io::Result<SearchResultInternal> {
	run_search_slice(&mut build_searcher_for_params(params), matcher, content, params)
}

fn run_search_slice(
	searcher: &mut Searcher,
	matcher: &grep_regex::RegexMatcher,
	content: &[u8],
	params: SearchParams,
) -> io::Result<SearchResultInternal> {
	let mut collector = MatchCollector::new(
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

fn build_searcher_for_params(params: SearchParams) -> Searcher {
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

/// Read file bytes, distinguishing oversized files from other skips.
fn read_file_bytes(path: &Path) -> io::Result<ReadFile> {
	let file = match File::open(path) {
		Ok(file) => file,
		Err(err)
			if matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied) =>
		{
			return Ok(ReadFile::Skipped);
		},
		Err(err) => return Err(err),
	};
	let metadata = file.metadata()?;
	if !metadata.is_file() {
		return Ok(ReadFile::Skipped);
	}
	let size = metadata.len();
	if size > MAX_FILE_BYTES {
		return Ok(ReadFile::Oversized);
	} else if size == 0 {
		return Ok(ReadFile::Bytes(FileBytes::Owned(Vec::new())));
	}
	if size <= SMALL_FILE_READ_BYTES {
		let mut buffer = Vec::with_capacity(size as usize);
		let mut handle = file;
		handle.read_to_end(&mut buffer)?;
		return Ok(ReadFile::Bytes(FileBytes::Owned(buffer)));
	}

	let mapping = unsafe {
		// SAFETY: The mapping is read-only and tied to the opened file handle.
		// We do not mutate through this view; the map is dropped immediately
		// after search for each file.
		memmap2::Mmap::map(&file)
	};

	let bytes = if let Ok(mapped) = mapping {
		FileBytes::Mapped(mapped)
	} else {
		let mut buffer = Vec::with_capacity(size as usize);
		let mut handle = file;
		handle.read_to_end(&mut buffer)?;
		FileBytes::Owned(buffer)
	};

	Ok(ReadFile::Bytes(bytes))
}

// ---------------------------------------------------------------------------
// Result conversion
// ---------------------------------------------------------------------------

fn to_public_match(matched: CollectedMatch) -> Match {
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

fn push_content_matches(
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

fn collect_files(
	root: &Path,
	scanned_entries: &[fs_cache::GlobMatch],
	glob_set: Option<&GlobSet>,
	type_filter: Option<&TypeFilter>,
) -> Vec<FileEntry> {
	let mut entries = Vec::new();
	for entry in scanned_entries {
		if entry.file_type != fs_cache::FileType::File {
			continue;
		}
		if let Some(glob_set) = glob_set
			&& !glob_set.is_match(Path::new(&entry.path))
		{
			continue;
		}
		let path = root.join(&entry.path);
		if let Some(filter) = type_filter
			&& !matches_type_filter(&path, filter)
		{
			continue;
		}
		entries.push(FileEntry { path, relative_path: entry.path.clone() });
	}
	entries
}
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
