// File reading and candidate filtering for native grep.

use std::{
	fs::File,
	io::{self, Read},
	path::{Path, PathBuf},
};

use globset::GlobSet;
use napi::bindgen_prelude::{Error, Result};

use crate::fs_cache;

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const SMALL_FILE_READ_BYTES: u64 = 128 * 1024;

pub(super) enum TypeFilter {
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

pub(super) struct FileEntry {
	pub(super) path: PathBuf,
	pub(super) relative_path: String,
}

pub(super) enum FileBytes {
	Mapped(memmap2::Mmap),
	Owned(Vec<u8>),
}

/// Outcome of attempting to read a file for searching.
pub(super) enum ReadFile {
	Bytes(FileBytes),
	/// File exceeds [`MAX_FILE_BYTES`]; callers count these so the skip can be
	/// surfaced instead of silently returning no matches.
	Oversized,
	/// Unreadable or not a regular file; silently skipped.
	Skipped,
}

impl FileBytes {
	pub(super) fn as_slice(&self) -> &[u8] {
		match self {
			Self::Mapped(mapped) => mapped.as_ref(),
			Self::Owned(bytes) => bytes.as_slice(),
		}
	}
}

pub(super) fn resolve_search_path(path: &str) -> Result<PathBuf> {
	let candidate = PathBuf::from(path);
	if candidate.is_absolute() {
		return Ok(candidate);
	}
	let cwd = std::env::current_dir()
		.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
	Ok(cwd.join(candidate))
}

pub(super) fn resolve_type_filter(type_name: Option<&str>) -> Option<TypeFilter> {
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

pub(super) fn matches_type_filter(path: &Path, filter: &TypeFilter) -> bool {
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

/// Read file bytes, distinguishing oversized files from other skips.
pub(super) fn read_file_bytes(path: &Path) -> io::Result<ReadFile> {
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

pub(super) fn collect_files(
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
