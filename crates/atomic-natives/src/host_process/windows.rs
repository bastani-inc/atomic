//! The Windows start of a host process: suspended, in a kill-on-close job of its own, then resumed, so the process
//! and every process it starts are in that job from their first instruction, unless it asks to leave it
//! (`CREATE_BREAKAWAY_FROM_JOB`), which the job allows. Node's `child_process` puts a child in libuv's own job
//! instead, whose children leave it silently; putting such a child in a second job afterwards makes the second job a
//! member of libuv's, so what the command leaves running would end when this process exits.
//!
//! Ending the tree ends, while the process runs, it and the processes below it through handles (see
//! `crate::process_tree`), which reaches those that left the job and are still below it, as Git Bash's are: Cygwin
//! starts every process with `CREATE_BREAKAWAY_FROM_JOB` when its job allows it. Then it ends what stayed in the job.
//!
//! The command line and environment block are built as libuv builds them for `child_process.spawn`, so the program
//! sees what it saw before. Its piped standard streams are the client ends of a pipe server the host listens on, opened
//! as libuv opens a child's ends of its pipes, so the host's runtime reads and writes them as it does a
//! `child_process`'s: each is checked to lead to a server of this process, and the host's prefix and the stream's
//! number are written into it first, by which the host tells its own connections from any other. A thread waits for
//! the exit and reports it, until the host's release.
use super::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use std::cmp::Ordering as Order;
use std::fs::File;
use std::io::{self, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use windows_sys::Win32::Foundation::{
	ERROR_ACCESS_DENIED, ERROR_BAD_EXE_FORMAT, ERROR_DIRECTORY, ERROR_ELEVATION_REQUIRED,
	ERROR_FILE_NOT_FOUND, ERROR_FILENAME_EXCED_RANGE, ERROR_INVALID_DRIVE, ERROR_INVALID_NAME,
	ERROR_INVALID_PARAMETER, ERROR_NOT_ENOUGH_MEMORY, ERROR_OUTOFMEMORY, ERROR_PATH_NOT_FOUND,
	ERROR_TOO_MANY_OPEN_FILES, FILETIME, GENERIC_READ, GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT,
	INVALID_HANDLE_VALUE, SetHandleInformation, WAIT_OBJECT_0,
};
use windows_sys::Win32::Globalization::{CSTR_GREATER_THAN, CSTR_LESS_THAN, CompareStringOrdinal};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
	CreateFileW, FILE_APPEND_DATA, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
	FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
	FILE_WRITE_ATTRIBUTES, GetFileAttributesW, GetShortPathNameW, INVALID_FILE_ATTRIBUTES,
	OPEN_ALWAYS, OPEN_EXISTING, SYNCHRONIZE,
};
use windows_sys::Win32::System::Environment::GetEnvironmentVariableW;
use windows_sys::Win32::System::JobObjects::{
	AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
	JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
	JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows_sys::Win32::System::Threading::{
	CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_SUSPENDED,
	CREATE_UNICODE_ENVIRONMENT, CreateEventW, CreateProcessW, DETACHED_PROCESS,
	DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, GetProcessId,
	GetProcessTimes, INFINITE, InitializeProcThreadAttributeList, OpenProcess,
	PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
	PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, ResumeThread, STARTF_USESHOWWINDOW,
	STARTF_USESTDHANDLES, STARTUPINFOEXW, SetEvent, TerminateProcess, UpdateProcThreadAttribute,
	WaitForMultipleObjects, WaitForSingleObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

/// The longest current directory `CreateProcessW` takes; libuv shortens a longer one.
const MAX_PATH: usize = 260;

fn raw(handle: &impl AsRawHandle) -> HANDLE {
	handle.as_raw_handle()
}

/// The job a process starts in: it ends its processes when it is closed, until it is released, and lets a process
/// leave it that asks to, as libuv's own job lets one.
struct Job(OwnedHandle);

impl Job {
	fn create() -> io::Result<Self> {
		let job = unsafe { CreateJobObjectW(null(), null()) };
		if job.is_null() {
			return Err(io::Error::last_os_error());
		}
		let job = Self(unsafe { OwnedHandle::from_raw_handle(job) });
		job.limit(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK)?;
		Ok(job)
	}

	fn limit(&self, flags: JOB_OBJECT_LIMIT) -> io::Result<()> {
		let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
		limits.BasicLimitInformation.LimitFlags = flags;
		if unsafe {
			SetInformationJobObject(
				raw(&self.0),
				JobObjectExtendedLimitInformation,
				(&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
				std::mem::size_of_val(&limits) as u32,
			)
		} == 0
		{
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}

	fn assign(&self, process: HANDLE) -> io::Result<()> {
		if unsafe { AssignProcessToJobObject(raw(&self.0), process) } == 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(())
		}
	}

	fn terminate(&self) -> bool {
		unsafe { TerminateJobObject(raw(&self.0), 1) != 0 }
	}

	/// Closes the job without ending its processes. One that cannot be told so stays open until this process exits.
	fn release(self) {
		if self.limit(JOB_OBJECT_LIMIT_BREAKAWAY_OK).is_err() {
			std::mem::forget(self);
		}
	}
}

/// The program's end of its piped standard stream `index` (0 input, 1 output, 2 error): the client end of the host's
/// pipe server `name`, opened as libuv opens a child's end of a pipe `child_process` asks for (reading and writing, not
/// overlapped), after `prefix` and the stream's number were written into it. Refused when the server is not this
/// process's, so the stream cannot lead elsewhere.
fn connect_stream(name: &[u16], index: u8, prefix: &[u8]) -> io::Result<File> {
	let attributes = SECURITY_ATTRIBUTES {
		nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
		lpSecurityDescriptor: null_mut(),
		bInheritHandle: 0,
	};
	let opened = unsafe {
		CreateFileW(
			name.as_ptr(),
			GENERIC_READ | GENERIC_WRITE,
			0,
			&attributes,
			OPEN_EXISTING,
			0,
			null_mut(),
		)
	};
	if opened == INVALID_HANDLE_VALUE {
		return Err(io::Error::last_os_error());
	}
	let mut file = unsafe { File::from_raw_handle(opened) };
	let mut server = 0u32;
	if unsafe { GetNamedPipeServerProcessId(raw(&file), &mut server) } == 0 {
		return Err(io::Error::last_os_error());
	}
	if server != std::process::id() {
		return Err(io::Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32));
	}
	file.write_all(prefix)?;
	file.write_all(&[index])?;
	Ok(file)
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
	mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The process and the manual-reset event the host's release sets, which the thread waits on.
struct Handles {
	process: OwnedHandle,
	stop: OwnedHandle,
}

/// Synchronizes handle lifetime between the supervisor thread and host `release()` / `Drop`.
/// While `supervisor_done` is false, the supervisor thread holds raw handle copies in `WaitForMultipleObjects` and is
/// solely responsible for dropping `handles` after waking. Once `supervisor_done` is true:
/// - for normal (`retain_handle_until_release = false`) processes, the supervisor drops `handles` immediately;
/// - for detached/watched (`retain_handle_until_release = true`) processes, `handles` stays open until `released` is
///   set by `release_by_host()` / `Drop`, preventing kernel object destruction and PID reuse during relay handoff or
///   parent abort/timeout cleanup even if the child exits in 0 ms.
struct HandleState {
	handles: Option<Handles>,
	supervisor_done: bool,
	released: bool,
}

/// What the host and the thread that waits for the process's exit share.
pub(super) struct Shared {
	pid: u32,
	handles: Mutex<HandleState>,
	/// When true (`start_detached` / `watch`), retain `handles.process` after child exit until host `release()` / `Drop`.
	retain_handle_until_release: bool,
	/// The job, until the host released the processes in it.
	job: Mutex<Option<Job>>,
	callback: Mutex<Option<EventCallback>>,
	stopping: AtomicBool,
	/// The signal `kill` ended the process with, reported with its exit as `child_process` reports it.
	killed_with: AtomicI32,
}

impl Shared {
	/// Standard input is the host's own end of its pipe here: nothing goes through this.
	pub(super) fn write(&self, _chunk: Vec<u8>) -> bool {
		false
	}

	pub(super) fn end(&self) {}

	/// As libuv kills a child on Windows: `SIGINT`, `SIGQUIT`, `SIGKILL` and `SIGTERM` end the process with exit code 1,
	/// and signal 0 asks whether it still runs. Only the process itself: its job is ended by `end_tree`.
	pub(super) fn kill(&self, signal: i32, _group: bool) -> bool {
		let state = locked(&self.handles);
		let Some(handles) = state.handles.as_ref() else { return false };
		if (unsafe { WaitForSingleObject(raw(&handles.process), 0) }) == WAIT_OBJECT_0 {
			return false;
		}
		match signal {
			0 => true,
			2 | 3 | 9 | 15 => {
				let ended = unsafe { TerminateProcess(raw(&handles.process), 1) } != 0;
				if ended {
					self.killed_with.store(signal, Ordering::Release);
				}
				ended
			},
			_ => false,
		}
	}

	/// Ends, while the process runs, it and the processes below it, through handles, and then every process in the
	/// job; false once the job was released.
	pub(super) fn end_tree(&self) -> bool {
		let job = locked(&self.job);
		let Some(job) = job.as_ref() else { return false };
		// The process's handle stays open meanwhile, so its ID names no other process during the walk.
		let state = locked(&self.handles);
		if let Some(handles) = state.handles.as_ref()
			&& (unsafe { WaitForSingleObject(raw(&handles.process), 0) }) != WAIT_OBJECT_0
			&& let Some(mut below) = crate::process_tree::hold_process_descendants(self.pid)
		{
			below.end_all();
		}
		drop(state);
		job.terminate()
	}

	/// Lets the processes in the job run on: the job no longer ends them when it closes, and it is closed.
	pub(super) fn release_tree(&self) {
		if let Some(job) = locked(&self.job).take() {
			job.release();
		}
	}

	#[allow(deprecated)]
	pub(super) fn refer(&self, env: &Env, keep_alive: bool) -> napi::Result<()> {
		if let Some(callback) = locked(&self.callback).as_mut() {
			if keep_alive {
				callback.refer(env)?;
			} else {
				callback.unref(env)?;
			}
		}
		Ok(())
	}

	/// The host handled the process's `close`, or dropped its handle: wake the supervisor if still running, or drop
	/// retained handles immediately if the supervisor already exited.
	pub(super) fn release_by_host(&self) {
		self.stopping.store(true, Ordering::Release);
		let mut state = locked(&self.handles);
		state.released = true;
		let to_drop = if state.supervisor_done {
			state.handles.take()
		} else {
			if let Some(handles) = state.handles.as_ref() {
				unsafe {
					SetEvent(raw(&handles.stop));
				}
			}
			None
		};
		drop(state);
		drop(to_drop);
	}

	fn emit(&self, event: HostProcessEvent) {
		if let Some(callback) = locked(&self.callback).as_ref() {
			callback.call(event, ThreadsafeFunctionCallMode::NonBlocking);
		}
	}
}

impl Drop for Shared {
	/// A job the host never released stays armed until this process exits: garbage collection never ends it.
	fn drop(&mut self) {
		if let Some(job) = self.job.get_mut().unwrap_or_else(PoisonError::into_inner).take() {
			std::mem::forget(job);
		}
	}
}

fn code_error(code: &str, message: impl Into<String>) -> napi::Error<String> {
	napi::Error::new(code.to_string(), message.into())
}

/// The name libuv gives a Windows error from starting a process, which `child_process` reports as the error's code.
fn start_error_code(error: u32) -> &'static str {
	match error {
		ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND | ERROR_DIRECTORY | ERROR_INVALID_NAME
		| ERROR_INVALID_DRIVE => "ENOENT",
		ERROR_ACCESS_DENIED => "EPERM",
		ERROR_ELEVATION_REQUIRED => "EACCES",
		ERROR_BAD_EXE_FORMAT => "EFTYPE",
		ERROR_NOT_ENOUGH_MEMORY | ERROR_OUTOFMEMORY => "ENOMEM",
		ERROR_TOO_MANY_OPEN_FILES => "EMFILE",
		ERROR_FILENAME_EXCED_RANGE => "ENAMETOOLONG",
		ERROR_INVALID_PARAMETER => "EINVAL",
		_ => "UNKNOWN",
	}
}

fn os_error(error: io::Error) -> napi::Error<String> {
	let code = error.raw_os_error().map_or("UNKNOWN", |code| start_error_code(code as u32));
	code_error(code, error.to_string())
}

/// Refused here, before the program ran: the host starts it through `child_process` instead.
fn unsupported(error: io::Error) -> napi::Error<String> {
	code_error("ENOTSUP", format!("cannot contain the process: {error}"))
}

fn wide(text: &str) -> napi::Result<Vec<u16>, String> {
	let units: Vec<u16> = text.encode_utf16().collect();
	if units.contains(&0) {
		return Err(code_error("EINVAL", "process text contains NUL"));
	}
	Ok(units)
}

fn terminated(mut units: Vec<u16>) -> Vec<u16> {
	units.push(0);
	units
}

/// The program `file` names, as libuv's `search_path` finds a file given with a directory: the name itself when it has
/// an extension, then the name with `.com` and with `.exe` appended; a directory is not a program.
fn program_path(file: &[u16]) -> Option<Vec<u16>> {
	let name_start = file
		.iter()
		.rposition(|&unit| unit == b'\\' as u16 || unit == b'/' as u16 || unit == b':' as u16)?
		+ 1;
	let name = &file[name_start..];
	let has_ext =
		name.iter().position(|&unit| unit == b'.' as u16).is_some_and(|dot| dot + 1 < name.len());
	let appended = |extension: &str| {
		let mut candidate = file.to_vec();
		if candidate.last() != Some(&(b'.' as u16)) {
			candidate.push(b'.' as u16);
		}
		candidate.extend(extension.encode_utf16());
		candidate
	};
	let candidates =
		has_ext.then(|| file.to_vec()).into_iter().chain([appended("com"), appended("exe")]);
	for candidate in candidates {
		let path = terminated(candidate);
		let attributes = unsafe { GetFileAttributesW(path.as_ptr()) };
		if attributes != INVALID_FILE_ATTRIBUTES && attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
			return Some(path);
		}
	}
	None
}

/// libuv's `quote_cmd_arg`: the argument unchanged when it needs no quotes, else quoted so that `CommandLineToArgvW`
/// and the C runtime read it back unchanged.
pub(super) fn quote_argument(source: &[u16], target: &mut Vec<u16>) {
	const QUOTE: u16 = b'"' as u16;
	const BACKSLASH: u16 = b'\\' as u16;
	if source.is_empty() {
		target.extend([QUOTE, QUOTE]);
		return;
	}
	if !source.iter().any(|&unit| unit == b' ' as u16 || unit == b'\t' as u16 || unit == QUOTE) {
		target.extend_from_slice(source);
		return;
	}
	if !source.iter().any(|&unit| unit == QUOTE || unit == BACKSLASH) {
		target.push(QUOTE);
		target.extend_from_slice(source);
		target.push(QUOTE);
		return;
	}
	target.push(QUOTE);
	let start = target.len();
	let mut quote_hit = true;
	for &unit in source.iter().rev() {
		target.push(unit);
		if quote_hit && unit == BACKSLASH {
			target.push(BACKSLASH);
		} else if unit == QUOTE {
			quote_hit = true;
			target.push(BACKSLASH);
		} else {
			quote_hit = false;
		}
	}
	target[start..].reverse();
	target.push(QUOTE);
}

/// libuv's `make_program_args`: the program as given, then each argument, quoted as needed and separated by spaces.
pub(super) fn command_line(arguments: &[Vec<u16>]) -> Vec<u16> {
	let mut line = Vec::new();
	for (index, argument) in arguments.iter().enumerate() {
		if index > 0 {
			line.push(b' ' as u16);
		}
		quote_argument(argument, &mut line);
	}
	line.push(0);
	line
}

/// Joins `program` (quoted if needed) and `args` verbatim with spaces, matching Node's `windowsVerbatimArguments`.
pub(super) fn verbatim_command_line(program: &[u16], args: &[Vec<u16>]) -> Vec<u16> {
	let mut line = Vec::new();
	quote_argument(program, &mut line);
	for argument in args {
		line.push(b' ' as u16);
		line.extend_from_slice(argument);
	}
	line.push(0);
	line
}

/// Looks up `file`: directly via `program_path` when it contains a separator or drive prefix, else by searching the
/// `PATH` entries of `env` (or this process's `PATH` when `env` sets none), trying exact name when it has an extension
/// and then `.com` and `.exe`.
fn resolve_program_path(file: &[u16], env: &OrderedEnv) -> napi::Result<Option<Vec<u16>>, String> {
	if file.iter().any(|&unit| unit == b'\\' as u16 || unit == b'/' as u16 || unit == b':' as u16) {
		return Ok(program_path(file));
	}
	let path_value: Option<Vec<u16>> =
		match env.iter().rev().find(|(key, _)| key.eq_ignore_ascii_case("PATH")) {
			Some((_, value)) => Some(wide(value)?),
			None => current_variable("PATH"),
		};
	let Some(path_value) = path_value else {
		return Ok(None);
	};
	for raw_segment in path_value.split(|&unit| unit == b';' as u16) {
		let trimmed = trim_path_segment(raw_segment);
		if trimmed.is_empty() {
			continue;
		}
		let mut candidate = Vec::with_capacity(trimmed.len() + 1 + file.len());
		candidate.extend_from_slice(trimmed);
		if !matches!(candidate.last(), Some(&u) if u == b'\\' as u16 || u == b'/' as u16) {
			candidate.push(b'\\' as u16);
		}
		candidate.extend_from_slice(file);
		if let Some(found) = program_path(&candidate) {
			return Ok(Some(found));
		}
	}
	Ok(None)
}

fn trim_path_segment(mut segment: &[u16]) -> &[u16] {
	while let Some(&first) = segment.first() {
		if first == b' ' as u16 || first == b'\t' as u16 {
			segment = &segment[1..];
		} else {
			break;
		}
	}
	while let Some(&last) = segment.last() {
		if last == b' ' as u16 || last == b'\t' as u16 {
			segment = &segment[..segment.len() - 1];
		} else {
			break;
		}
	}
	if segment.len() >= 2
		&& segment.first() == Some(&(b'"' as u16))
		&& segment.last() == Some(&(b'"' as u16))
	{
		segment = &segment[1..segment.len() - 1];
	}
	segment
}

fn handle_creation_time(process: HANDLE) -> Option<String> {
	let empty = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
	let (mut created, mut exited, mut kernel, mut user) = (empty(), empty(), empty(), empty());
	if unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
		return None;
	}
	let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
	(ticks != 0).then(|| ticks.to_string())
}

/// Opens `path` append-only (`FILE_APPEND_DATA`, no truncate right) with full sharing so other processes can read
/// tails or reset on the next start.
fn open_stderr_append(path: &[u16]) -> io::Result<File> {
	let attributes = SECURITY_ATTRIBUTES {
		nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
		lpSecurityDescriptor: null_mut(),
		bInheritHandle: 0,
	};
	let opened = unsafe {
		CreateFileW(
			path.as_ptr(),
			FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | SYNCHRONIZE,
			FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
			&attributes,
			OPEN_ALWAYS,
			FILE_ATTRIBUTE_NORMAL,
			null_mut(),
		)
	};
	if opened == INVALID_HANDLE_VALUE {
		return Err(io::Error::last_os_error());
	}
	Ok(unsafe { File::from_raw_handle(opened) })
}

/// The variables libuv adds from this process's environment when the child's has none of that name.
const REQUIRED_VARIABLES: [&str; 11] = [
	"HOMEDRIVE",
	"HOMEPATH",
	"LOGONSERVER",
	"PATH",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"USERDOMAIN",
	"USERNAME",
	"USERPROFILE",
	"WINDIR",
];

/// The name of a `NAME=value` entry: everything before its first `=`.
fn entry_name(entry: &[u16]) -> &[u16] {
	&entry[..entry.iter().position(|&unit| unit == b'=' as u16).unwrap_or(entry.len())]
}

/// libuv's `make_program_env`: deduplicates case-insensitively equal variable names keeping the
/// last entry in input order (matching Node.js `child_process` on Windows), adds each of
/// [`REQUIRED_VARIABLES`] the entries lack from `lookup` where it is set, and sorts by name
/// ignoring case; ends in an empty entry.
pub(super) fn environment_block(
	entries: Vec<Vec<u16>>,
	compare: impl Fn(&[u16], &[u16]) -> Order,
	lookup: impl Fn(&str) -> Option<Vec<u16>>,
) -> Vec<u16> {
	let mut indexed: Vec<(usize, Vec<u16>)> = entries.into_iter().enumerate().collect();
	indexed.sort_by(|left, right| {
		compare(entry_name(&left.1), entry_name(&right.1)).then_with(|| left.0.cmp(&right.0))
	});
	let mut deduped: Vec<Vec<u16>> = Vec::with_capacity(indexed.len());
	for (_, entry) in indexed {
		if let Some(prev) = deduped.last_mut()
			&& compare(entry_name(prev), entry_name(&entry)).is_eq()
		{
			*prev = entry;
		} else {
			deduped.push(entry);
		}
	}
	for name in REQUIRED_VARIABLES {
		let name_units: Vec<u16> = name.encode_utf16().collect();
		if deduped.iter().any(|entry| compare(entry_name(entry), &name_units).is_eq()) {
			continue;
		}
		if let Some(value) = lookup(name) {
			let mut entry = name_units;
			entry.push(b'=' as u16);
			entry.extend(value);
			deduped.push(entry);
		}
	}
	deduped.sort_by(|left, right| compare(entry_name(left), entry_name(right)));
	let mut block = Vec::new();
	for entry in deduped {
		block.extend(entry);
		block.push(0);
	}
	block.push(0);
	block
}

/// `CompareStringOrdinal` ignoring case, as libuv sorts environment names.
fn ordinal_ignoring_case(left: &[u16], right: &[u16]) -> Order {
	match unsafe {
		CompareStringOrdinal(left.as_ptr(), left.len() as i32, right.as_ptr(), right.len() as i32, 1)
	} {
		CSTR_LESS_THAN => Order::Less,
		CSTR_GREATER_THAN => Order::Greater,
		_ => Order::Equal,
	}
}

/// This process's value of `name`; an empty variable is set, as `GetEnvironmentVariableW` reports it.
fn current_variable(name: &str) -> Option<Vec<u16>> {
	let name: Vec<u16> = terminated(name.encode_utf16().collect());
	let size = unsafe { GetEnvironmentVariableW(name.as_ptr(), null_mut(), 0) };
	if size == 0 {
		return None;
	}
	let mut value = vec![0u16; size as usize];
	let written = unsafe { GetEnvironmentVariableW(name.as_ptr(), value.as_mut_ptr(), size) };
	if written == 0 && size != 1 {
		return None;
	}
	value.truncate(written as usize);
	Some(value)
}

/// The working directory, shortened as libuv shortens one of `MAX_PATH` units or more.
fn working_directory(cwd: &str) -> napi::Result<Vec<u16>, String> {
	let cwd = terminated(wide(cwd)?);
	if cwd.len() - 1 < MAX_PATH {
		return Ok(cwd);
	}
	let mut short = vec![0u16; cwd.len()];
	let length = unsafe { GetShortPathNameW(cwd.as_ptr(), short.as_mut_ptr(), short.len() as u32) };
	if length == 0 || length as usize >= short.len() {
		return Err(os_error(io::Error::last_os_error()));
	}
	short.truncate(length as usize + 1);
	Ok(short)
}

fn null_device(write: bool) -> io::Result<File> {
	std::fs::OpenOptions::new().read(!write).write(write).open("NUL")
}

/// Waits for the exit and reports it, or for the host's release, after which nothing more is reported.
fn supervise(shared: &Shared) {
	// Valid until `supervisor_done` becomes true below.
	let Some(waited) = locked(&shared.handles)
		.handles
		.as_ref()
		.map(|handles| [raw(&handles.process), raw(&handles.stop)])
	else {
		return;
	};
	let woke = unsafe { WaitForMultipleObjects(2, waited.as_ptr(), 0, INFINITE) };
	if woke == WAIT_OBJECT_0 && !shared.stopping.load(Ordering::Acquire) {
		let mut status = 0u32;
		let read = unsafe { GetExitCodeProcess(waited[0], &mut status) } != 0;
		let signal = shared.killed_with.load(Ordering::Acquire);
		shared.emit(HostProcessEvent {
			code: (signal == 0).then_some(if read { i64::from(status) } else { -1 }),
			signal: (signal != 0).then_some(signal),
			..HostProcessEvent::of(HostProcessEventKind::Exit)
		});
	}
	// Release the JS callback first so it never keeps the Node/Bun event loop alive while a handle is retained.
	drop(locked(&shared.callback).take());
	let mut state = locked(&shared.handles);
	state.supervisor_done = true;
	let to_drop = if !shared.retain_handle_until_release || state.released {
		state.handles.take()
	} else {
		None
	};
	drop(state);
	drop(to_drop);
}

/// The program's standard stream `index`: the client end of the host's pipe server when piped, else the null device.
fn stream(options: &HostProcessOptions, piped: bool, index: u8) -> napi::Result<File, String> {
	if !piped {
		return null_device(index != 0).map_err(os_error);
	}
	let (Some(name), Some(prefix)) = (options.pipe.as_deref(), options.pipe_prefix.as_deref())
	else {
		return Err(code_error("EINVAL", "a piped stream needs the host's pipe and prefix"));
	};
	// A pipe that is not there, is busy or is not this process's: nothing ran, and `child_process` can start it.
	connect_stream(&terminated(wide(name)?), index, prefix).map_err(unsupported)
}

pub(super) fn start(
	options: HostProcessOptions,
	on_event: EventCallback,
) -> napi::Result<HostProcess, String> {
	if options.detached {
		if let Some(pid) = options.watch_pid {
			let Some(creation_time) = options.watch_creation_time else {
				return Err(code_error("EINVAL", "watchPid requires watchCreationTime"));
			};
			return watch(pid, creation_time, on_event);
		}
		return start_detached(options, on_event);
	}
	let file = wide(&options.file)?;
	let mut arguments = vec![file.clone()];
	for argument in &options.args {
		arguments.push(wide(argument)?);
	}
	let mut line = command_line(&arguments);
	let mut entries = Vec::with_capacity(options.env.len());
	for (key, value) in &options.env {
		let mut entry = wide(key)?;
		entry.push(b'=' as u16);
		entry.extend(wide(value)?);
		entries.push(entry);
	}
	let environment = environment_block(entries, ordinal_ignoring_case, current_variable);
	let cwd = options.cwd.as_deref().map(working_directory).transpose()?;
	let Some(application) = program_path(&file) else {
		return Err(code_error("ENOENT", format!("spawn {} ENOENT", options.file)));
	};
	let job = Job::create().map_err(unsupported)?;
	let stdin_child = stream(&options, options.pipe_stdin, 0)?;
	let stdout_child = stream(&options, options.pipe_stdout, 1)?;
	let stderr_child = stream(&options, options.pipe_stderr, 2)?;
	let inherited = [raw(&stdin_child), raw(&stdout_child), raw(&stderr_child)];
	for handle in inherited {
		if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
			return Err(os_error(io::Error::last_os_error()));
		}
	}
	let mut attribute_size = 0;
	unsafe {
		InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_size);
	}
	let mut attributes = vec![0usize; attribute_size.div_ceil(std::mem::size_of::<usize>())];
	let attribute_list = attributes.as_mut_ptr().cast();
	if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_size) } == 0 {
		return Err(os_error(io::Error::last_os_error()));
	}
	// Only the three standard streams are inherited, whatever else this process holds that is inheritable.
	let listed = unsafe {
		UpdateProcThreadAttribute(
			attribute_list,
			0,
			PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
			inherited.as_ptr().cast(),
			std::mem::size_of_val(&inherited),
			null_mut(),
			null(),
		)
	};
	if listed == 0 {
		let error = io::Error::last_os_error();
		unsafe {
			DeleteProcThreadAttributeList(attribute_list);
		}
		return Err(os_error(error));
	}
	let mut startup = STARTUPINFOEXW::default();
	startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
	startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
	startup.StartupInfo.wShowWindow = SW_HIDE as u16;
	startup.StartupInfo.hStdInput = inherited[0];
	startup.StartupInfo.hStdOutput = inherited[1];
	startup.StartupInfo.hStdError = inherited[2];
	startup.lpAttributeList = attribute_list;
	let mut info = PROCESS_INFORMATION::default();
	let created = unsafe {
		CreateProcessW(
			application.as_ptr(),
			line.as_mut_ptr(),
			null(),
			null(),
			1,
			CREATE_SUSPENDED
				| CREATE_UNICODE_ENVIRONMENT
				| CREATE_NO_WINDOW
				| EXTENDED_STARTUPINFO_PRESENT,
			environment.as_ptr().cast(),
			cwd.as_ref().map_or(null(), |cwd| cwd.as_ptr()),
			&startup.StartupInfo,
			&mut info,
		)
	};
	let create_error = io::Error::last_os_error();
	unsafe {
		DeleteProcThreadAttributeList(attribute_list);
	}
	drop((stdin_child, stdout_child, stderr_child));
	if created == 0 {
		return Err(os_error(create_error));
	}
	let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess) };
	let thread = unsafe { OwnedHandle::from_raw_handle(info.hThread) };
	let creation_time = handle_creation_time(raw(&process));
	// Nothing of the program has run yet: the job holds it before its first instruction, or it never runs.
	if let Err(error) = job.assign(raw(&process)) {
		unsafe {
			TerminateProcess(raw(&process), 1);
			WaitForSingleObject(raw(&process), 3000);
		}
		return Err(unsupported(error));
	}
	if unsafe { ResumeThread(raw(&thread)) } == u32::MAX {
		let error = io::Error::last_os_error();
		job.terminate();
		return Err(os_error(error));
	}
	drop(thread);
	let stop = unsafe { CreateEventW(null(), 1, 0, null()) };
	if stop.is_null() {
		let error = io::Error::last_os_error();
		job.terminate();
		return Err(os_error(error));
	}
	let shared = Arc::new(Shared {
		pid: info.dwProcessId,
		handles: Mutex::new(HandleState {
			handles: Some(Handles { process, stop: unsafe { OwnedHandle::from_raw_handle(stop) } }),
			supervisor_done: false,
			released: false,
		}),
		retain_handle_until_release: false,
		job: Mutex::new(Some(job)),
		callback: Mutex::new(Some(on_event)),
		stopping: AtomicBool::new(false),
		killed_with: AtomicI32::new(0),
	});
	let worker = shared.clone();
	if let Err(error) =
		std::thread::Builder::new().name("host-process".into()).spawn(move || supervise(&worker))
	{
		// No thread can report it: end it and what it started rather than leave them running unowned.
		shared.end_tree();
		locked(&shared.handles).supervisor_done = true;
		shared.release_by_host();
		return Err(os_error(error));
	}
	Ok(HostProcess { pid: info.dwProcessId, creation_time, shared })
}

/// Starts a detached, hidden Windows process that survives parent exit, parent console close, and breakaway-allowing
/// parent job objects, inheriting only NUL stdin/stdout and an optional append-only stderr log handle.
fn start_detached(
	options: HostProcessOptions,
	on_event: EventCallback,
) -> napi::Result<HostProcess, String> {
	if options.pipe_stdin || options.pipe_stdout || options.pipe_stderr {
		return Err(code_error("EINVAL", "a detached Windows process cannot use piped streams"));
	}
	let file = wide(&options.file)?;
	let mut raw_args = Vec::with_capacity(options.args.len());
	for argument in &options.args {
		raw_args.push(wide(argument)?);
	}
	let line = if options.verbatim_arguments.unwrap_or(false) {
		verbatim_command_line(&file, &raw_args)
	} else {
		let mut arguments = Vec::with_capacity(1 + raw_args.len());
		arguments.push(file.clone());
		arguments.extend(raw_args);
		command_line(&arguments)
	};
	let mut entries = Vec::with_capacity(options.env.len());
	for (key, value) in &options.env {
		let mut entry = wide(key)?;
		entry.push(b'=' as u16);
		entry.extend(wide(value)?);
		entries.push(entry);
	}
	let environment = environment_block(entries, ordinal_ignoring_case, current_variable);
	let cwd = options.cwd.as_deref().map(working_directory).transpose()?;
	let Some(application) = resolve_program_path(&file, &options.env)? else {
		return Err(code_error("ENOENT", format!("spawn {} ENOENT", options.file)));
	};
	let stdin_child = null_device(false).map_err(os_error)?;
	let stdout_child = null_device(true).map_err(os_error)?;
	let stderr_child = match options.stderr_log_path.as_deref() {
		Some(path) => open_stderr_append(&terminated(wide(path)?)).map_err(os_error)?,
		None => null_device(true).map_err(os_error)?,
	};
	let inherited = [raw(&stdin_child), raw(&stdout_child), raw(&stderr_child)];
	for handle in inherited {
		if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
			return Err(os_error(io::Error::last_os_error()));
		}
	}
	let mut attribute_size = 0;
	unsafe {
		InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_size);
	}
	let mut attributes = vec![0usize; attribute_size.div_ceil(std::mem::size_of::<usize>())];
	let attribute_list = attributes.as_mut_ptr().cast();
	if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_size) } == 0 {
		return Err(os_error(io::Error::last_os_error()));
	}
	let listed = unsafe {
		UpdateProcThreadAttribute(
			attribute_list,
			0,
			PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
			inherited.as_ptr().cast(),
			std::mem::size_of_val(&inherited),
			null_mut(),
			null(),
		)
	};
	if listed == 0 {
		let error = io::Error::last_os_error();
		unsafe {
			DeleteProcThreadAttributeList(attribute_list);
		}
		return Err(os_error(error));
	}
	let mut startup = STARTUPINFOEXW::default();
	startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
	startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
	startup.StartupInfo.wShowWindow = SW_HIDE as u16;
	startup.StartupInfo.hStdInput = inherited[0];
	startup.StartupInfo.hStdOutput = inherited[1];
	startup.StartupInfo.hStdError = inherited[2];
	startup.lpAttributeList = attribute_list;

	// DETACHED_PROCESS and CREATE_NO_WINDOW are mutually exclusive in CreateProcessW. Default direct executables use
	// DETACHED_PROCESS (zero conhost.exe). Custom scripts/wrappers request `no_window: true` so they receive a
	// windowless console (`CREATE_NO_WINDOW`) independent of any parent console, which their console descendants
	// inherit silently instead of allocating a visible console window.
	let console_flag =
		if options.no_window.unwrap_or(false) { CREATE_NO_WINDOW } else { DETACHED_PROCESS };
	let base_flags = console_flag
		| CREATE_NEW_PROCESS_GROUP
		| CREATE_UNICODE_ENVIRONMENT
		| EXTENDED_STARTUPINFO_PRESENT;
	let mut info = PROCESS_INFORMATION::default();
	let mut line_first = line.clone();
	let mut created = unsafe {
		CreateProcessW(
			application.as_ptr(),
			line_first.as_mut_ptr(),
			null(),
			null(),
			1,
			base_flags | CREATE_BREAKAWAY_FROM_JOB,
			environment.as_ptr().cast(),
			cwd.as_ref().map_or(null(), |cwd| cwd.as_ptr()),
			&startup.StartupInfo,
			&mut info,
		)
	};
	let mut create_error = io::Error::last_os_error();
	if created == 0 && create_error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
		// A parent job object may forbid breakaway; retry without CREATE_BREAKAWAY_FROM_JOB using a fresh command buffer.
		let mut line_retry = line;
		created = unsafe {
			CreateProcessW(
				application.as_ptr(),
				line_retry.as_mut_ptr(),
				null(),
				null(),
				1,
				base_flags,
				environment.as_ptr().cast(),
				cwd.as_ref().map_or(null(), |cwd| cwd.as_ptr()),
				&startup.StartupInfo,
				&mut info,
			)
		};
		create_error = io::Error::last_os_error();
	}
	unsafe {
		DeleteProcThreadAttributeList(attribute_list);
	}
	drop((stdin_child, stdout_child, stderr_child));
	if created == 0 {
		return Err(os_error(create_error));
	}
	let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess) };
	let thread = unsafe { OwnedHandle::from_raw_handle(info.hThread) };
	drop(thread);
	let creation_time = handle_creation_time(raw(&process));
	let stop = unsafe { CreateEventW(null(), 1, 0, null()) };
	if stop.is_null() {
		let error = io::Error::last_os_error();
		unsafe {
			TerminateProcess(raw(&process), 1);
		}
		return Err(os_error(error));
	}
	let shared = Arc::new(Shared {
		pid: info.dwProcessId,
		handles: Mutex::new(HandleState {
			handles: Some(Handles { process, stop: unsafe { OwnedHandle::from_raw_handle(stop) } }),
			supervisor_done: false,
			released: false,
		}),
		retain_handle_until_release: true,
		job: Mutex::new(None),
		callback: Mutex::new(Some(on_event)),
		stopping: AtomicBool::new(false),
		killed_with: AtomicI32::new(0),
	});
	let worker = shared.clone();
	if let Err(error) =
		std::thread::Builder::new().name("host-process".into()).spawn(move || supervise(&worker))
	{
		shared.kill(9, false);
		locked(&shared.handles).supervisor_done = true;
		shared.release_by_host();
		return Err(os_error(error));
	}
	Ok(HostProcess { pid: info.dwProcessId, creation_time, shared })
}

/// Opens existing process `pid`, verifies its creation time matches `expected_creation_time`, and supervises its exit
/// until the host calls `release()`. Even an already-exited process whose handle is still held by a relay opens cleanly
/// and reports its exact exit code immediately.
pub(super) fn watch(
	pid: u32,
	expected_creation_time: String,
	on_event: EventCallback,
) -> napi::Result<HostProcess, String> {
	if pid == 0 {
		return Err(code_error("ENOENT", "process 0 cannot be watched"));
	}
	let raw_process = unsafe {
		OpenProcess(
			PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
			0,
			pid,
		)
	};
	if raw_process.is_null() {
		return Err(os_error(io::Error::last_os_error()));
	}
	let process = unsafe { OwnedHandle::from_raw_handle(raw_process) };
	if unsafe { GetProcessId(raw(&process)) } != pid {
		return Err(code_error("ENOENT", format!("process {pid} does not match opened handle")));
	}
	let actual = handle_creation_time(raw(&process));
	if actual.as_deref() != Some(expected_creation_time.as_str()) {
		return Err(code_error("ENOENT", format!("process {pid} creation time does not match")));
	}
	let stop = unsafe { CreateEventW(null(), 1, 0, null()) };
	if stop.is_null() {
		return Err(os_error(io::Error::last_os_error()));
	}
	let shared = Arc::new(Shared {
		pid,
		handles: Mutex::new(HandleState {
			handles: Some(Handles { process, stop: unsafe { OwnedHandle::from_raw_handle(stop) } }),
			supervisor_done: false,
			released: false,
		}),
		retain_handle_until_release: true,
		job: Mutex::new(None),
		callback: Mutex::new(Some(on_event)),
		stopping: AtomicBool::new(false),
		killed_with: AtomicI32::new(0),
	});
	let worker = shared.clone();
	if let Err(error) =
		std::thread::Builder::new().name("host-process".into()).spawn(move || supervise(&worker))
	{
		locked(&shared.handles).supervisor_done = true;
		shared.release_by_host();
		return Err(os_error(error));
	}
	Ok(HostProcess { pid, creation_time: Some(expected_creation_time), shared })
}

#[cfg(test)]
mod tests {
	use super::*;

	fn units(text: &str) -> Vec<u16> {
		text.encode_utf16().collect()
	}

	fn quoted(argument: &str) -> String {
		let mut target = Vec::new();
		quote_argument(&units(argument), &mut target);
		String::from_utf16(&target).unwrap()
	}

	#[test]
	fn quotes_an_argument_as_libuv_does() {
		// libuv's own examples (quote_cmd_arg), and the cases before them.
		for (argument, expected) in [
			("", r#""""#),
			("plain", "plain"),
			("a b", r#""a b""#),
			("a\tb", "\"a\tb\""),
			(r#"hello"world"#, r#""hello\"world""#),
			(r#"hello""world"#, r#""hello\"\"world""#),
			(r"hello\world", r"hello\world"),
			(r"hello\\world", r"hello\\world"),
			(r#"hello\"world"#, r#""hello\\\"world""#),
			(r#"hello\\"world"#, r#""hello\\\\\"world""#),
			(r"hello world\", r#""hello world\\""#),
			(r"C:\Program Files\Git\bin\bash.exe", r#""C:\Program Files\Git\bin\bash.exe""#),
		] {
			assert_eq!(quoted(argument), expected, "{argument:?}");
		}
	}

	#[test]
	fn joins_the_program_and_its_arguments_with_spaces() {
		let line = command_line(&[units(r"C:\Git\bin\bash.exe"), units("-c"), units("echo 'a b'")]);
		assert_eq!(
			String::from_utf16(&line[..line.len() - 1]).unwrap(),
			r#"C:\Git\bin\bash.exe -c "echo 'a b'""#
		);
		assert_eq!(line.last(), Some(&0));
	}

	#[test]
	fn sorts_the_environment_by_name_and_adds_the_variables_windows_programs_need() {
		let ascii = |left: &[u16], right: &[u16]| {
			let upper = |text: &[u16]| String::from_utf16(text).unwrap().to_ascii_uppercase();
			upper(left).cmp(&upper(right))
		};
		let lookup = |name: &str| match name {
			"SYSTEMROOT" => Some(units(r"C:\Windows")),
			"TEMP" => Some(units("")),
			// Already in the child's environment under another case: never looked up into it.
			"PATH" => Some(units("from this process")),
			_ => None,
		};
		let block =
			environment_block(vec![units("b=1"), units("A=x=y"), units("path=p")], ascii, lookup);
		let text = String::from_utf16(&block).unwrap();
		assert_eq!(text, "A=x=y\0b=1\0path=p\0SYSTEMROOT=C:\\Windows\0TEMP=\0\0");
	}

	#[test]
	fn deduplicates_case_insensitive_environment_keys_deterministically_keeping_last_entry() {
		let ascii = |left: &[u16], right: &[u16]| {
			let upper = |text: &[u16]| String::from_utf16(text).unwrap().to_ascii_uppercase();
			upper(left).cmp(&upper(right))
		};
		let lookup = |_: &str| None;

		let forward = environment_block(
			vec![
				units(r"atomic_coding_agent_dir=.\rel"),
				units("path=first"),
				units(r"ATOMIC_CODING_AGENT_DIR=C:\abs"),
				units("PATH=second"),
			],
			ascii,
			lookup,
		);
		assert_eq!(
			String::from_utf16(&forward).unwrap(),
			"ATOMIC_CODING_AGENT_DIR=C:\\abs\0PATH=second\0\0"
		);

		// Reversing order deterministically picks the last entry in input order (matching Node child_process).
		let reversed = environment_block(
			vec![units(r"ATOMIC_CODING_AGENT_DIR=C:\abs"), units(r"atomic_coding_agent_dir=.\rel")],
			ascii,
			lookup,
		);
		assert_eq!(String::from_utf16(&reversed).unwrap(), "atomic_coding_agent_dir=.\\rel\0\0");

		// Also verify with Win32 CompareStringOrdinal directly.
		let ordinal = environment_block(
			vec![units(r"atomic_coding_agent_dir=.\rel"), units(r"ATOMIC_CODING_AGENT_DIR=C:\abs")],
			ordinal_ignoring_case,
			lookup,
		);
		assert_eq!(String::from_utf16(&ordinal).unwrap(), "ATOMIC_CODING_AGENT_DIR=C:\\abs\0\0");
	}

	#[test]
	fn finds_a_program_as_libuv_does_for_a_path() {
		let directory =
			std::env::temp_dir().join(format!("atomic-program-path-{}", std::process::id()));
		std::fs::create_dir_all(directory.join("folder.exe")).unwrap();
		std::fs::write(directory.join("tool.exe"), b"").unwrap();
		let path = |name: &str| units(&directory.join(name).to_string_lossy());
		let found =
			|name: &str| program_path(&path(name)).map(|found| String::from_utf16(&found).unwrap());
		let expected = |name: &str| format!("{}\0", directory.join(name).to_string_lossy());
		assert_eq!(found("tool.exe"), Some(expected("tool.exe")));
		assert_eq!(
			found("tool"),
			Some(expected("tool.exe")),
			"a name without an extension gets .com, then .exe"
		);
		assert_eq!(found("folder.exe"), None, "a directory is not a program");
		assert_eq!(found("missing.exe"), None);
		std::fs::remove_dir_all(&directory).unwrap();
	}

	#[test]
	fn builds_a_verbatim_command_line_without_requoting_arguments() {
		let line = verbatim_command_line(
			&units(r"C:\Windows\System32\cmd.exe"),
			&[units("/d"), units("/s"), units("/c"), units(r#""C:\my tools\broker.cmd" "arg 1""#)],
		);
		assert_eq!(
			String::from_utf16(&line[..line.len() - 1]).unwrap(),
			r#"C:\Windows\System32\cmd.exe /d /s /c "C:\my tools\broker.cmd" "arg 1""#
		);
		assert_eq!(line.last(), Some(&0));
	}

	#[test]
	fn resolves_a_bare_program_name_from_path_entries() {
		let directory = std::env::temp_dir().join(format!("atomic-bare-path-{}", std::process::id()));
		std::fs::create_dir_all(&directory).unwrap();
		std::fs::write(directory.join("custom-broker.exe"), b"").unwrap();
		let env = OrderedEnv(vec![
			("path".to_string(), r"C:\nonexistent-first".to_string()),
			("PATH".to_string(), format!("\"{}\";C:\\nonexistent", directory.display())),
		]);
		let found = resolve_program_path(&units("custom-broker"), &env)
			.unwrap()
			.map(|path| String::from_utf16(&path).unwrap());
		assert_eq!(
			found,
			Some(format!("{}\0", directory.join("custom-broker.exe").to_string_lossy()))
		);
		std::fs::remove_dir_all(&directory).unwrap();
	}
}
