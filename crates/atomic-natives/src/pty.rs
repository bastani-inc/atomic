use std::{
	collections::HashMap,
	io::{Read, Write},
	str,
	sync::{Arc, Mutex, mpsc},
	time::{Duration, Instant},
};

use napi::{
	Env, Error, Result,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use portable_pty::{Child, CommandBuilder, PtySize, native_pty_system};

#[napi(object)]
pub struct PtyStartOptions<'env> {
	pub command: String,
	pub cwd: Option<String>,
	pub env: Option<HashMap<String, String>>,
	pub timeout_ms: Option<u32>,
	pub signal: Option<Unknown<'env>>,
	pub cols: Option<u16>,
	pub rows: Option<u16>,
	pub shell: Option<String>,
	pub shell_args: Option<Vec<String>>,
	pub command_transport: Option<String>,
	pub close_stdin_after_command: Option<bool>,
}

#[napi(object)]
pub struct PtyRunResult {
	pub exit_code: Option<i32>,
	pub cancelled: bool,
	pub timed_out: bool,
}

#[derive(Clone)]
struct PtyRunConfig {
	command: String,
	cwd: Option<String>,
	env: Option<HashMap<String, String>>,
	cols: u16,
	rows: u16,
	shell: Option<String>,
	shell_args: Option<Vec<String>>,
	command_transport: Option<String>,
	timeout_ms: Option<u32>,
	close_stdin_after_command: bool,
}

enum ReaderEvent {
	Chunk(String),
	Done,
}

enum ControlMessage {
	Input(String),
	Resize { cols: u16, rows: u16 },
	Kill,
}

struct PtySessionCore {
	control_tx: mpsc::Sender<ControlMessage>,
}

#[napi]
pub struct PtySession {
	core: Arc<Mutex<Option<PtySessionCore>>>,
}

impl Default for PtySession {
	fn default() -> Self {
		Self::new()
	}
}

#[napi]
impl PtySession {
	#[napi(constructor)]
	pub fn new() -> Self {
		Self { core: Arc::new(Mutex::new(None)) }
	}

	#[napi]
	pub fn start<'env>(
		&self,
		env: &'env Env,
		options: PtyStartOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String>>,
	) -> Result<PromiseRaw<'env, PtyRunResult>> {
		let _ = options.signal;
		let run_config = PtyRunConfig {
			command: options.command,
			cwd: options.cwd,
			env: options.env,
			cols: options.cols.unwrap_or(120).clamp(20, 400),
			rows: options.rows.unwrap_or(40).clamp(5, 200),
			shell: options.shell,
			shell_args: options.shell_args,
			command_transport: options.command_transport,
			timeout_ms: options.timeout_ms,
			close_stdin_after_command: options.close_stdin_after_command.unwrap_or(false),
		};
		let core = Arc::clone(&self.core);
		let (control_tx, control_rx) = mpsc::channel::<ControlMessage>();
		{
			let mut guard =
				core.lock().map_err(|_| Error::from_reason("PTY session lock poisoned"))?;
			if guard.is_some() {
				return Err(Error::from_reason("PTY session already running"));
			}
			*guard = Some(PtySessionCore { control_tx });
		}
		env.spawn_future(async move {
			let result =
				tokio::task::spawn_blocking(move || run_pty_sync(run_config, on_chunk, control_rx))
					.await;
			let mut guard =
				core.lock().map_err(|_| Error::from_reason("PTY session lock poisoned"))?;
			*guard = None;
			match result {
				Ok(inner) => inner,
				Err(error) => Err(Error::from_reason(format!("PTY execution task failed: {error}"))),
			}
		})
	}

	#[napi]
	pub fn write(&self, data: String) -> Result<()> {
		self.send_control(ControlMessage::Input(data))
	}

	#[napi]
	pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
		self.send_control(ControlMessage::Resize {
			cols: cols.clamp(20, 400),
			rows: rows.clamp(5, 200),
		})
	}

	#[napi]
	pub fn kill(&self) -> Result<()> {
		self.send_control(ControlMessage::Kill)
	}
}

impl PtySession {
	fn send_control(&self, message: ControlMessage) -> Result<()> {
		let guard = self.core.lock().map_err(|_| Error::from_reason("PTY session lock poisoned"))?;
		let core = guard.as_ref().ok_or_else(|| Error::from_reason("PTY session is not running"))?;
		core
			.control_tx
			.send(message)
			.map_err(|_| Error::from_reason("PTY session is no longer available"))
	}
}

fn run_pty_sync(
	config: PtyRunConfig,
	on_chunk: Option<ThreadsafeFunction<String>>,
	control_rx: mpsc::Receiver<ControlMessage>,
) -> Result<PtyRunResult> {
	let pty_system = native_pty_system();
	let pair = open_pair(pty_system.as_ref(), config.cols, config.rows)?;
	let command = build_command(&config);
	let mut child = pair
		.slave
		.spawn_command(command)
		.map_err(|err| Error::from_reason(format!("Failed to spawn PTY command: {err}")))?;
	drop(pair.slave);
	let master = pair.master;
	let mut writer = Some(
		master
			.take_writer()
			.map_err(|err| Error::from_reason(format!("Failed to create PTY writer: {err}")))?,
	);
	#[cfg(windows)]
	{
		if let Some(writer) = writer.as_mut() {
			let _ = writer.write_all(b"\x1b[1;1R");
			let _ = writer.flush();
		}
	}
	let stdin_transport = config.command_transport.as_deref() == Some("stdin");
	if stdin_transport && let Some(writer_ref) = writer.as_mut() {
		writer_ref
			.write_all(config.command.as_bytes())
			.map_err(|err| Error::from_reason(format!("Failed writing PTY stdin command: {err}")))?;
		writer_ref
			.write_all(if config.close_stdin_after_command { b"\n\x04" } else { b"\n" })
			.map_err(|err| {
				Error::from_reason(format!("Failed finalizing PTY stdin command: {err}"))
			})?;
		writer_ref
			.flush()
			.map_err(|err| Error::from_reason(format!("Failed flushing PTY stdin command: {err}")))?;
	}
	let mut reader = master
		.try_clone_reader()
		.map_err(|err| Error::from_reason(format!("Failed to create PTY reader: {err}")))?;
	let (reader_tx, reader_rx) = mpsc::channel::<ReaderEvent>();
	let reader_thread = std::thread::spawn(move || reader_loop(&mut reader, reader_tx));
	let child_pid = child.process_id().and_then(|value| i32::try_from(value).ok());
	#[cfg(unix)]
	let process_group_id = master.process_group_leader().filter(|pgid| *pgid > 0);
	#[cfg(not(unix))]
	let process_group_id: Option<i32> = None;
	let started = Instant::now();
	let timeout = config
		.timeout_ms
		.filter(|value| *value > 0)
		.map(|value| Duration::from_millis(u64::from(value)));
	let mut timed_out = false;
	let mut cancelled = false;
	let mut reader_done = false;
	let mut exit_code: Option<i32> = None;
	let mut terminate_requested = false;
	let mut reader_drain_deadline: Option<Instant> = None;
	while exit_code.is_none() || !reader_done {
		if !terminate_requested && timeout.is_some_and(|limit| started.elapsed() >= limit) {
			timed_out = true;
			terminate_pty_processes(&mut child, child_pid, process_group_id);
			terminate_requested = true;
			reader_drain_deadline = Some(Instant::now() + Duration::from_millis(300));
		}
		let mut sink_writer = std::io::sink();
		let writer_ref = writer.as_deref_mut().unwrap_or(&mut sink_writer);
		let control_state = PtyControlState {
			cancelled: &mut cancelled,
			terminate_requested: &mut terminate_requested,
			reader_drain_deadline: &mut reader_drain_deadline,
		};
		drain_control(
			&control_rx,
			writer_ref,
			master.as_ref(),
			&mut child,
			child_pid,
			process_group_id,
			control_state,
		);
		drain_reader(&reader_rx, &on_chunk, &mut reader_done);
		if exit_code.is_none()
			&& let Some(status) = child
				.try_wait()
				.map_err(|err| Error::from_reason(format!("Failed checking PTY status: {err}")))?
		{
			exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
			if !reader_done && reader_drain_deadline.is_none() {
				reader_drain_deadline = Some(Instant::now() + Duration::from_millis(300));
			}
		}
		if reader_drain_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
			break;
		}
		if exit_code.is_none() || !reader_done {
			let wait = reader_drain_deadline.map_or(Duration::from_millis(16), |deadline| {
				deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(16))
			});
			match reader_rx.recv_timeout(wait) {
				Ok(ReaderEvent::Chunk(chunk)) => emit_chunk(&chunk, on_chunk.as_ref()),
				Ok(ReaderEvent::Done) | Err(mpsc::RecvTimeoutError::Disconnected) => reader_done = true,
				Err(mpsc::RecvTimeoutError::Timeout) => {},
			}
		}
	}
	if exit_code.is_none() && !terminate_requested {
		let status = child
			.wait()
			.map_err(|err| Error::from_reason(format!("Failed waiting PTY process: {err}")))?;
		exit_code = Some(i32::try_from(status.exit_code()).unwrap_or(i32::MAX));
	}
	drop(writer);
	drop(master);
	finalize_reader(&reader_rx, &on_chunk, &mut reader_done);
	let _ = reader_thread.join();
	Ok(PtyRunResult { exit_code, cancelled, timed_out })
}

fn open_pair(
	system: &(dyn portable_pty::PtySystem + Send),
	cols: u16,
	rows: u16,
) -> Result<portable_pty::PtyPair> {
	const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
	if cfg!(windows) {
		let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
		let (tx, rx) = mpsc::channel();
		std::thread::spawn(move || {
			let result = native_pty_system().openpty(size);
			let _ = tx.send(result);
		});
		return match rx.recv_timeout(STARTUP_TIMEOUT) {
			Ok(Ok(pair)) => Ok(pair),
			Ok(Err(error)) => Err(Error::from_reason(format!("Failed to open PTY: {error}"))),
			Err(_) => Err(Error::from_reason(
				"PTY creation timed out (5s). ConPTY may be unavailable on this system.",
			)),
		};
	}
	system
		.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
		.map_err(|err| Error::from_reason(format!("Failed to open PTY: {err}")))
}

fn build_command(config: &PtyRunConfig) -> CommandBuilder {
	let shell = config.shell.as_deref().unwrap_or("sh");
	let lower = shell.to_lowercase();
	let mut cmd = CommandBuilder::new(shell);
	if let Some(args) = config.shell_args.as_ref() {
		for arg in args {
			cmd.arg(arg);
		}
	} else if config.command_transport.as_deref() != Some("stdin")
		&& (lower.ends_with("cmd.exe") || lower.ends_with("cmd"))
	{
		cmd.arg("/c");
	} else if config.command_transport.as_deref() != Some("stdin")
		&& (lower.contains("powershell") || lower.contains("pwsh"))
	{
		cmd.arg("-Command");
	} else if config.command_transport.as_deref() != Some("stdin") {
		cmd.arg("-c");
	}
	if config.command_transport.as_deref() != Some("stdin") {
		cmd.arg(&config.command);
	}
	if let Some(cwd) = config.cwd.as_ref() {
		cmd.cwd(cwd);
	}
	if let Some(env) = config.env.as_ref() {
		for (key, value) in env {
			cmd.env(key, value);
		}
	}
	cmd
}

struct PtyControlState<'a> {
	cancelled: &'a mut bool,
	terminate_requested: &'a mut bool,
	reader_drain_deadline: &'a mut Option<Instant>,
}

fn drain_control(
	control_rx: &mpsc::Receiver<ControlMessage>,
	writer: &mut dyn Write,
	master: &(dyn portable_pty::MasterPty + Send),
	child: &mut Box<dyn Child + Send + Sync>,
	child_pid: Option<i32>,
	process_group_id: Option<i32>,
	control_state: PtyControlState<'_>,
) {
	for _ in 0..64 {
		match control_rx.try_recv() {
			Ok(ControlMessage::Input(data)) => {
				let _ = writer.write_all(data.as_bytes());
				let _ = writer.flush();
			},
			Ok(ControlMessage::Resize { cols, rows }) => {
				let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
			},
			Ok(ControlMessage::Kill) => {
				*control_state.cancelled = true;
				if !*control_state.terminate_requested {
					terminate_pty_processes(child, child_pid, process_group_id);
					*control_state.terminate_requested = true;
					*control_state.reader_drain_deadline =
						Some(Instant::now() + Duration::from_millis(300));
				}
			},
			Err(mpsc::TryRecvError::Empty) | Err(mpsc::TryRecvError::Disconnected) => break,
		}
	}
}

fn drain_reader(
	reader_rx: &mpsc::Receiver<ReaderEvent>,
	on_chunk: &Option<ThreadsafeFunction<String>>,
	reader_done: &mut bool,
) {
	for _ in 0..256 {
		match reader_rx.try_recv() {
			Ok(ReaderEvent::Chunk(chunk)) => emit_chunk(&chunk, on_chunk.as_ref()),
			Ok(ReaderEvent::Done) | Err(mpsc::TryRecvError::Disconnected) => {
				*reader_done = true;
				break;
			},
			Err(mpsc::TryRecvError::Empty) => break,
		}
	}
}

fn finalize_reader(
	reader_rx: &mpsc::Receiver<ReaderEvent>,
	on_chunk: &Option<ThreadsafeFunction<String>>,
	reader_done: &mut bool,
) {
	let deadline = Instant::now() + Duration::from_millis(if cfg!(windows) { 500 } else { 50 });
	while !*reader_done && Instant::now() < deadline {
		match reader_rx.recv_timeout(Duration::from_millis(5)) {
			Ok(ReaderEvent::Chunk(chunk)) => emit_chunk(&chunk, on_chunk.as_ref()),
			Ok(ReaderEvent::Done) | Err(mpsc::RecvTimeoutError::Disconnected) => *reader_done = true,
			Err(mpsc::RecvTimeoutError::Timeout) => {},
		}
	}
}

fn reader_loop(reader: &mut Box<dyn Read + Send>, reader_tx: mpsc::Sender<ReaderEvent>) {
	const REPLACEMENT: &str = "\u{FFFD}";
	let mut buf = vec![0u8; 65540];
	let mut pending = 0;
	loop {
		match reader.read(&mut buf[pending..65536]) {
			Ok(0) | Err(_) => break,
			Ok(n) => {
				pending += n;
				pending = emit_utf8_chunks(&mut buf, pending, &reader_tx, REPLACEMENT);
			},
		}
	}
	for chunk in buf[..pending].utf8_chunks() {
		if !chunk.valid().is_empty() {
			let _ = reader_tx.send(ReaderEvent::Chunk(chunk.valid().to_string()));
		}
		if !chunk.invalid().is_empty() {
			let _ = reader_tx.send(ReaderEvent::Chunk(REPLACEMENT.to_string()));
		}
	}
	let _ = reader_tx.send(ReaderEvent::Done);
}

fn emit_utf8_chunks(
	buf: &mut [u8],
	mut pending: usize,
	reader_tx: &mpsc::Sender<ReaderEvent>,
	replacement: &str,
) -> usize {
	while pending > 0 {
		match str::from_utf8(&buf[..pending]) {
			Ok(text) => {
				let _ = reader_tx.send(ReaderEvent::Chunk(text.to_string()));
				return 0;
			},
			Err(error) => {
				let valid = error.valid_up_to();
				if valid > 0 {
					let text = unsafe { str::from_utf8_unchecked(&buf[..valid]) };
					let _ = reader_tx.send(ReaderEvent::Chunk(text.to_string()));
					buf.copy_within(valid..pending, 0);
					pending -= valid;
				}
				match error.error_len() {
					Some(invalid) => {
						let _ = reader_tx.send(ReaderEvent::Chunk(replacement.to_string()));
						buf.copy_within(invalid..pending, 0);
						pending -= invalid;
					},
					None => break,
				}
			},
		}
	}
	pending
}

fn terminate_pty_processes(
	child: &mut Box<dyn Child + Send + Sync>,
	_child_pid: Option<i32>,
	process_group_id: Option<i32>,
) {
	#[cfg(unix)]
	if let Some(pgid) = process_group_id {
		unsafe {
			libc::kill(-pgid, libc::SIGTERM);
		}
	}
	let _ = child.kill();
	#[cfg(unix)]
	if let Some(pgid) = process_group_id {
		std::thread::sleep(Duration::from_millis(50));
		unsafe {
			libc::kill(-pgid, libc::SIGKILL);
		}
	}
}

fn emit_chunk(text: &str, callback: Option<&ThreadsafeFunction<String>>) {
	if let Some(callback) = callback {
		callback.call(Ok(text.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
	}
}
