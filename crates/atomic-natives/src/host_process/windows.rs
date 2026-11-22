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
//! sees what it saw before. Output is read as libuv reads a pipe: one thread per output pipe waits until it holds data
//! and tells the host, whose thread then reads what it holds. One thread writes standard input, and one waits for the
//! exit; the host's release (after its `close`) stops them and closes this process's ends of the pipes.
use super::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use std::cmp::Ordering as Order;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;
use windows_sys::Win32::Foundation::{
	ERROR_ACCESS_DENIED, ERROR_BAD_EXE_FORMAT, ERROR_BROKEN_PIPE, ERROR_DIRECTORY,
	ERROR_ELEVATION_REQUIRED, ERROR_FILE_NOT_FOUND, ERROR_FILENAME_EXCED_RANGE, ERROR_INVALID_DRIVE,
	ERROR_INVALID_NAME, ERROR_INVALID_PARAMETER, ERROR_NO_DATA, ERROR_NOT_ENOUGH_MEMORY,
	ERROR_OPERATION_ABORTED, ERROR_OUTOFMEMORY, ERROR_PATH_NOT_FOUND, ERROR_TOO_MANY_OPEN_FILES,
	HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0,
};
use windows_sys::Win32::Globalization::{CSTR_GREATER_THAN, CSTR_LESS_THAN, CompareStringOrdinal};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
	FILE_ATTRIBUTE_DIRECTORY, GetFileAttributesW, GetShortPathNameW, INVALID_FILE_ATTRIBUTES,
	ReadFile,
};
use windows_sys::Win32::System::Environment::GetEnvironmentVariableW;
use windows_sys::Win32::System::IO::CancelSynchronousIo;
use windows_sys::Win32::System::JobObjects::{
	AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
	JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
	JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
	CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateEventW, CreateProcessW,
	DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
	InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION,
	ResumeThread, STARTF_USESHOWWINDOW, STARTF_USESTDHANDLES, STARTUPINFOEXW, SetEvent,
	TerminateProcess, UpdateProcThreadAttribute, WaitForMultipleObjects, WaitForSingleObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

/// The most one read of a pipe takes, and the size of each pipe, as libuv's.
const READ_CHUNK_BYTES: usize = 64 * 1024;
/// The longest current directory `CreateProcessW` takes; libuv shortens a longer one.
const MAX_PATH: usize = 260;

/// This process's end of an output pipe, and whether the host is to read it.
#[derive(Default)]
struct StreamOutput {
	/// Closed once the stream's thread finished, when the host released the process.
	file: Option<File>,
	/// What the host's thread reads the pipe into.
	buffer: Vec<u8>,
	/// The pipe holds data and the host's thread has not read it yet: the stream's thread waits until it has.
	readable: bool,
}

/// What goes to the host: an event, or a stream's data, read as the host's thread converts it.
pub(super) enum Delivery {
	Event(HostProcessEvent),
	Readable(Arc<Shared>, usize),
}

impl napi::bindgen_prelude::ToNapiValue for Delivery {
	unsafe fn to_napi_value(
		env: napi::sys::napi_env,
		delivery: Self,
	) -> napi::Result<napi::sys::napi_value> {
		let event = match delivery {
			Delivery::Event(event) => event,
			Delivery::Readable(shared, index) => shared.read_output(index),
		};
		unsafe { <HostProcessEvent as napi::bindgen_prelude::ToNapiValue>::to_napi_value(env, event) }
	}
}

/// The data and end events of stream `index` (0 standard output, 1 standard error).
fn stream_kinds(index: usize) -> (HostProcessEventKind, HostProcessEventKind) {
	if index == 0 {
		(HostProcessEventKind::Stdout, HostProcessEventKind::StdoutEnd)
	} else {
		(HostProcessEventKind::Stderr, HostProcessEventKind::StderrEnd)
	}
}

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

/// An anonymous pipe: its read end and its write end, neither inheritable.
fn pipe() -> io::Result<(File, File)> {
	let mut read = null_mut();
	let mut write = null_mut();
	let attributes = SECURITY_ATTRIBUTES {
		nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
		lpSecurityDescriptor: null_mut(),
		bInheritHandle: 0,
	};
	if unsafe { CreatePipe(&mut read, &mut write, &attributes, 65536) } == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(unsafe { (File::from_raw_handle(read), File::from_raw_handle(write)) })
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
	mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Input {
	chunks: VecDeque<Vec<u8>>,
	ended: bool,
	/// Set once standard input is closed: by its end, a failed write, the process's exit or the host's release.
	closed: bool,
}

/// What the host and the process's threads share.
pub(super) struct Shared {
	pid: u32,
	/// Held until this is dropped, so `pid` names the process all along.
	process: OwnedHandle,
	/// The job, until the host released the processes in it.
	job: Mutex<Option<Job>>,
	input: Mutex<Input>,
	input_changed: Condvar,
	callback: Mutex<Option<EventCallback>>,
	/// Standard output's and standard error's way to the host.
	outputs: Mutex<[StreamOutput; 2]>,
	outputs_changed: Condvar,
	/// A manual-reset event set by the host's release.
	stop: OwnedHandle,
	stopping: AtomicBool,
	/// The signal `kill` ended the process with, reported with its exit as `child_process` reports it.
	killed_with: AtomicI32,
}

impl Shared {
	pub(super) fn write(&self, chunk: Vec<u8>) -> bool {
		let mut input = locked(&self.input);
		if input.ended || input.closed {
			return false;
		}
		input.chunks.push_back(chunk);
		drop(input);
		self.input_changed.notify_all();
		true
	}

	pub(super) fn end(&self) {
		locked(&self.input).ended = true;
		self.input_changed.notify_all();
	}

	fn close_input(&self) {
		let mut input = locked(&self.input);
		input.closed = true;
		input.chunks.clear();
		drop(input);
		self.input_changed.notify_all();
	}

	fn exited(&self) -> bool {
		(unsafe { WaitForSingleObject(raw(&self.process), 0) }) == WAIT_OBJECT_0
	}

	/// As libuv kills a child on Windows: `SIGINT`, `SIGQUIT`, `SIGKILL` and `SIGTERM` end the process with exit code 1,
	/// and signal 0 asks whether it still runs. Only the process itself: its job is ended by `end_tree`.
	pub(super) fn kill(&self, signal: i32, _group: bool) -> bool {
		if self.exited() {
			return false;
		}
		match signal {
			0 => true,
			2 | 3 | 9 | 15 => {
				let ended = unsafe { TerminateProcess(raw(&self.process), 1) } != 0;
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
		if !self.exited()
			&& let Some(mut below) = crate::process_tree::hold_process_descendants(self.pid)
		{
			below.end_all();
		}
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

	/// The host handled the process's `close`, or dropped its handle: its threads stop and let go of the pipes.
	pub(super) fn release_by_host(&self) {
		self.stopping.store(true, Ordering::Release);
		unsafe {
			SetEvent(raw(&self.stop));
		}
		self.input_changed.notify_all();
		self.outputs_changed.notify_all();
	}

	fn emit(&self, event: HostProcessEvent) {
		if let Some(callback) = locked(&self.callback).as_ref() {
			callback.call(Delivery::Event(event), ThreadsafeFunctionCallMode::NonBlocking);
		}
	}

	/// Tells the host that the pipe of stream `index` holds data, and waits until the host's thread read it. False once
	/// the host released the process.
	fn hand_readable(self: &Arc<Self>, index: usize) -> bool {
		let mut outputs = locked(&self.outputs);
		if self.stopping.load(Ordering::Acquire) {
			return false;
		}
		outputs[index].readable = true;
		drop(outputs);
		let sent = locked(&self.callback).as_ref().is_some_and(|callback| {
			callback
				.call(Delivery::Readable(self.clone(), index), ThreadsafeFunctionCallMode::NonBlocking)
				== Status::Ok
		});
		let mut outputs = locked(&self.outputs);
		if !sent {
			outputs[index].readable = false;
			return false;
		}
		while outputs[index].readable && !self.stopping.load(Ordering::Acquire) {
			outputs = self.outputs_changed.wait(outputs).unwrap_or_else(PoisonError::into_inner);
		}
		!self.stopping.load(Ordering::Acquire)
	}

	/// What the pipe of stream `index` holds, up to [`READ_CHUNK_BYTES`], read as the host's thread converts the event,
	/// as libuv reads a pipe once its loop gets to it. The pipe holds data, so the read does not wait; nothing is
	/// read once the host released the process.
	fn read_output(&self, index: usize) -> HostProcessEvent {
		let mut outputs = locked(&self.outputs);
		let output = &mut outputs[index];
		let mut data = Vec::new();
		if output.readable
			&& !self.stopping.load(Ordering::Acquire)
			&& let Some(mut file) = output.file.as_ref()
		{
			output.buffer.resize(READ_CHUNK_BYTES, 0);
			if let Ok(count) = file.read(&mut output.buffer) {
				data.extend_from_slice(&output.buffer[..count]);
			}
		}
		output.readable = false;
		drop(outputs);
		self.outputs_changed.notify_all();
		HostProcessEvent {
			data: Some(Buffer::from(data)),
			..HostProcessEvent::of(stream_kinds(index).0)
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

/// libuv's `make_program_env`: the `NAME=value` entries sorted by name, ignoring case, with each of
/// [`REQUIRED_VARIABLES`] the entries lack added from `lookup` where it is set; ends in an empty entry.
pub(super) fn environment_block(
	entries: Vec<Vec<u16>>,
	compare: impl Fn(&[u16], &[u16]) -> Order,
	lookup: impl Fn(&str) -> Option<Vec<u16>>,
) -> Vec<u16> {
	let mut entries = entries;
	for name in REQUIRED_VARIABLES {
		let name_units: Vec<u16> = name.encode_utf16().collect();
		if entries.iter().any(|entry| compare(entry_name(entry), &name_units).is_eq()) {
			continue;
		}
		if let Some(value) = lookup(name) {
			let mut entry = name_units;
			entry.push(b'=' as u16);
			entry.extend(value);
			entries.push(entry);
		}
	}
	entries.sort_by(|left, right| compare(entry_name(left), entry_name(right)));
	let mut block = Vec::new();
	for entry in entries {
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

/// Cancels the synchronous read or write `thread` is blocked in until it has finished; it checks `stopping` before
/// each, so a cancel that came before it blocked is followed by another.
fn cancel_until_finished(thread: &JoinHandle<()>) {
	while !thread.is_finished() {
		unsafe {
			CancelSynchronousIo(thread.as_raw_handle());
		}
		std::thread::sleep(Duration::from_millis(1));
	}
}

/// Waits, as libuv does, with a read of no bytes until the pipe of stream `index` holds data, which the host's thread
/// then reads; the pipe's end follows the last read.
fn watch_output(shared: &Arc<Shared>, index: usize) {
	// Valid while this thread runs: the file closes only after it finished.
	let Some(pipe) = locked(&shared.outputs)[index].file.as_ref().map(raw) else { return };
	loop {
		if shared.stopping.load(Ordering::Acquire) {
			return;
		}
		let mut count = 0u32;
		if unsafe { ReadFile(pipe, null_mut(), 0, &mut count, null_mut()) } == 0 {
			if io::Error::last_os_error().raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32) {
				continue;
			}
			break;
		}
		if !shared.hand_readable(index) {
			return;
		}
	}
	shared.emit(HostProcessEvent::of(stream_kinds(index).1));
}

fn write_input(shared: &Shared, mut file: File) {
	loop {
		let chunk = {
			let mut input = locked(&shared.input);
			loop {
				if input.closed || shared.stopping.load(Ordering::Acquire) {
					return;
				}
				if let Some(chunk) = input.chunks.pop_front() {
					break chunk;
				}
				if input.ended {
					input.closed = true;
					return;
				}
				input = shared.input_changed.wait(input).unwrap_or_else(PoisonError::into_inner);
			}
		};
		if let Err(error) = file.write_all(&chunk) {
			let mut input = locked(&shared.input);
			let closed_meanwhile = input.closed;
			input.closed = true;
			input.chunks.clear();
			drop(input);
			if !closed_meanwhile && !shared.stopping.load(Ordering::Acquire) {
				let errno = match error.raw_os_error().map(|code| code as u32) {
					Some(ERROR_BROKEN_PIPE | ERROR_NO_DATA) => "EPIPE".to_string(),
					_ => "EIO".to_string(),
				};
				shared.emit(HostProcessEvent {
					errno: Some(errno),
					..HostProcessEvent::of(HostProcessEventKind::StdinError)
				});
			}
			return;
		}
	}
}

/// Waits for the exit and reports it, closes standard input as `child_process` does then, and waits for the output
/// to end, or for the host's release, after which nothing more is reported and the pipes are let go.
fn supervise(shared: &Shared, readers: Vec<JoinHandle<()>>, writer: Option<JoinHandle<()>>) {
	let waited = [raw(&shared.process), raw(&shared.stop)];
	let woke = unsafe { WaitForMultipleObjects(2, waited.as_ptr(), 0, INFINITE) };
	if woke == WAIT_OBJECT_0 {
		let mut status = 0u32;
		let read = unsafe { GetExitCodeProcess(raw(&shared.process), &mut status) } != 0;
		let signal = shared.killed_with.load(Ordering::Acquire);
		shared.emit(HostProcessEvent {
			code: (signal == 0).then_some(if read { i64::from(status) } else { -1 }),
			signal: (signal != 0).then_some(signal),
			..HostProcessEvent::of(HostProcessEventKind::Exit)
		});
		shared.close_input();
		if let Some(writer) = &writer {
			cancel_until_finished(writer);
		}
		loop {
			let mut handles = vec![raw(&shared.stop)];
			handles.extend(
				readers
					.iter()
					.filter(|reader| !reader.is_finished())
					.map(|reader| reader.as_raw_handle()),
			);
			if handles.len() == 1 {
				break;
			}
			let woke =
				unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, INFINITE) };
			if woke == WAIT_OBJECT_0 || woke >= WAIT_OBJECT_0 + handles.len() as u32 {
				break;
			}
		}
	}
	shared.stopping.store(true, Ordering::Release);
	shared.close_input();
	for thread in readers.iter().chain(writer.iter()) {
		cancel_until_finished(thread);
	}
	for thread in readers.into_iter().chain(writer) {
		let _ = thread.join();
	}
	for output in locked(&shared.outputs).iter_mut() {
		*output = StreamOutput::default();
	}
	drop(locked(&shared.callback).take());
}

/// The child's end of a standard stream and this process's end, if it is a pipe.
type Stream = (File, Option<File>);

fn stream(piped: bool, child_writes: bool) -> io::Result<Stream> {
	if !piped {
		return Ok((null_device(child_writes)?, None));
	}
	let (read, write) = pipe()?;
	Ok(if child_writes { (write, Some(read)) } else { (read, Some(write)) })
}

pub(super) fn start(
	options: HostProcessOptions,
	on_event: EventCallback,
) -> napi::Result<HostProcess, String> {
	if options.detached {
		return Err(code_error("ENOSYS", "a detached process starts through child_process here"));
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
	let (stdin_child, stdin) = stream(options.pipe_stdin, false).map_err(os_error)?;
	let (stdout_child, stdout) = stream(options.pipe_stdout, true).map_err(os_error)?;
	let (stderr_child, stderr) = stream(options.pipe_stderr, true).map_err(os_error)?;
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
		process,
		job: Mutex::new(Some(job)),
		input: Mutex::new(Input { chunks: VecDeque::new(), ended: false, closed: stdin.is_none() }),
		input_changed: Condvar::new(),
		callback: Mutex::new(Some(on_event)),
		outputs: Mutex::new(Default::default()),
		outputs_changed: Condvar::new(),
		stop: unsafe { OwnedHandle::from_raw_handle(stop) },
		stopping: AtomicBool::new(false),
		killed_with: AtomicI32::new(0),
	});
	let threads = (|| -> io::Result<()> {
		let mut readers = Vec::with_capacity(2);
		for (index, output) in [stdout, stderr].into_iter().enumerate() {
			if let Some(file) = output {
				locked(&shared.outputs)[index].file = Some(file);
				let worker = shared.clone();
				readers.push(
					std::thread::Builder::new()
						.name("host-process-output".into())
						.spawn(move || watch_output(&worker, index))?,
				);
			}
		}
		let writer = match stdin {
			Some(file) => {
				let worker = shared.clone();
				Some(
					std::thread::Builder::new()
						.name("host-process-input".into())
						.spawn(move || write_input(&worker, file))?,
				)
			},
			None => None,
		};
		let worker = shared.clone();
		std::thread::Builder::new()
			.name("host-process".into())
			.spawn(move || supervise(&worker, readers, writer))?;
		Ok(())
	})();
	if let Err(error) = threads {
		// No thread can report it: end it and what it started rather than leave them running unowned.
		shared.end_tree();
		shared.release_by_host();
		return Err(os_error(error));
	}
	Ok(HostProcess { pid: info.dwProcessId, shared })
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
}
