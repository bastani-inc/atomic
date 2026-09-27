//! ConPTY lifetime is independent of the job. Never close it on the output reader.
use super::windows::{PipeReader, pipe, raw};
use super::*;
use windows_sys::Win32::System::Console::{
	COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
};

#[derive(Default)]
struct ConsoleState {
	handle: Option<HPCON>,
	closer: Option<std::thread::JoinHandle<()>>,
	reader: Option<std::thread::JoinHandle<io::Result<()>>>,
	failure: Option<String>,
}
impl ConsoleState {
	fn begin_close(&mut self) {
		let Some(handle) = self.handle else { return };
		// ClosePseudoConsole may emit a final frame and block until it is drained.
		// The independent output worker must remain alive throughout this call.
		match std::thread::Builder::new().name("task-conpty-close".into()).spawn(move || unsafe {
			ClosePseudoConsole(handle);
		}) {
			Ok(worker) => {
				self.handle = None;
				self.closer = Some(worker);
			},
			Err(error) => self.failure = Some(error.to_string()),
		}
	}
	fn reaped(&mut self) -> bool {
		if self.closer.as_ref().is_some_and(std::thread::JoinHandle::is_finished)
			&& self.closer.take().unwrap().join().is_err()
		{
			self.failure = Some("ConPTY close worker panicked".into());
		}
		if self.reader.as_ref().is_some_and(std::thread::JoinHandle::is_finished) {
			match self.reader.take().unwrap().join() {
				Ok(Ok(())) => {},
				Ok(Err(error)) => self.failure = Some(error.to_string()),
				Err(_) => self.failure = Some("ConPTY output worker panicked".into()),
			}
		}
		self.handle.is_none() && self.closer.is_none() && self.reader.is_none()
	}
}
static FAILED_CONSOLES: Mutex<Vec<ConsoleState>> = Mutex::new(Vec::new());
pub(super) fn poll_failed_consoles() {
	FAILED_CONSOLES.lock().unwrap().retain_mut(|state| {
		state.begin_close();
		!state.reaped()
	});
}

pub(super) struct PseudoConsole(ConsoleState);
impl PseudoConsole {
	pub(super) fn create(
		command: &Arc<CommandTask>,
		columns: u16,
		rows: u16,
		console: &mut Option<Self>,
	) -> io::Result<File> {
		let size = dimensions(columns, rows)?;
		let (stdin_read, stdin_write) = pipe()?;
		let (stdout_read, stdout_write) = pipe()?;
		let output_writer = DetachedOutputWriter::register(command);
		let reader =
			std::thread::Builder::new().name("task-conpty-output".into()).spawn(move || {
				let mut reader = PipeReader(stdout_read);
				let mut eof = false;
				while !eof {
					drain_pipe(&mut reader, output_writer.command(), &mut eof)?;
					if !eof {
						std::thread::sleep(PROCESS_POLL);
					}
				}
				Ok(())
			})?;
		// Publish reader ownership before the fallible API so setup failure also
		// waits for its endpoint to close (or retains it with Cleanup::Failed).
		*console = Some(Self(ConsoleState { reader: Some(reader), ..Default::default() }));
		let mut handle = 0;
		let result =
			unsafe { CreatePseudoConsole(size, raw(&stdin_read), raw(&stdout_write), 0, &mut handle) };
		if result < 0 {
			return Err(io::Error::other(format!("CreatePseudoConsole HRESULT {result:#x}")));
		}
		console.as_mut().unwrap().0.handle = Some(handle);
		// ConPTY owns its duplicates; parent copies must not keep channels alive.
		drop(stdin_read);
		drop(stdout_write);
		Ok(stdin_write)
	}
	pub(super) fn handle(&self) -> HPCON {
		self.0.handle.unwrap()
	}
	pub(super) fn resize(&self, columns: u16, rows: u16) -> io::Result<()> {
		let size = dimensions(columns, rows)?;
		let Some(handle) = self.0.handle else { return Ok(()) };
		let result = unsafe { ResizePseudoConsole(handle, size) };
		if result < 0 {
			Err(io::Error::other(format!("ResizePseudoConsole HRESULT {result:#x}")))
		} else {
			Ok(())
		}
	}
	pub(super) fn begin_close(&mut self) {
		self.0.begin_close();
	}
	pub(super) fn reaped(&mut self) -> bool {
		self.0.reaped()
	}
	pub(super) fn failure(&mut self) -> Option<String> {
		self.0.reaped();
		self.0.failure.clone()
	}
	pub(super) fn close_until(&mut self, deadline: Instant) -> bool {
		loop {
			self.begin_close();
			if self.reaped() {
				return true;
			}
			if Instant::now() >= deadline {
				return false;
			}
			std::thread::sleep(PROCESS_POLL);
		}
	}
}
impl Drop for PseudoConsole {
	fn drop(&mut self) {
		self.begin_close();
		if !self.reaped() {
			// A failed setup/cleanup keeps both workers and the HPCON, not a detached
			// thread or a synchronous destructor that can deadlock environment exit.
			FAILED_CONSOLES.lock().unwrap().push(std::mem::take(&mut self.0));
		}
	}
}
pub(super) fn dimensions(columns: u16, rows: u16) -> io::Result<COORD> {
	if columns == 0 || rows == 0 || columns > i16::MAX as u16 || rows > i16::MAX as u16 {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"ConPTY dimensions must be 1..32767",
		));
	}
	Ok(COORD { X: columns as i16, Y: rows as i16 })
}

#[cfg(test)]
#[path = "windows_pty_tests.rs"]
mod tests;
