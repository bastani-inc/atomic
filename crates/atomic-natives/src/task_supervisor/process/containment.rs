use napi_derive::napi;

#[cfg(windows)]
use super::windows::{ContainmentJob, raw};

#[napi]
pub struct ProcessTreeContainment {
	#[cfg(windows)]
	job: Option<ContainmentJob>,
}

#[napi]
impl ProcessTreeContainment {
	#[napi]
	pub fn terminate(&self) -> bool {
		#[cfg(windows)]
		if let Some(job) = &self.job {
			return job.terminate().is_ok();
		}
		false
	}

	#[napi]
	pub fn active_processes(&self) -> napi::Result<u32> {
		#[cfg(windows)]
		if let Some(job) = &self.job {
			return job
				.active()
				.map_err(|error| napi::Error::new(napi::Status::GenericFailure, error.to_string()));
		}
		Ok(0)
	}

	#[napi]
	pub fn release(&mut self) -> bool {
		#[cfg(windows)]
		if let Some(job) = self.job.take() {
			return job.release().is_ok();
		}
		false
	}

	#[napi]
	pub fn close(&mut self) {
		#[cfg(windows)]
		drop(self.job.take());
	}
}

#[napi(object)]
pub struct ContainmentOptions {
	/// Lets a process in the tree start a child outside it, which `CREATE_BREAKAWAY_FROM_JOB` asks for; without it such
	/// a start fails. Released, the job keeps allowing it.
	pub allow_breakaway: Option<bool>,
}

#[napi(js_name = "containProcessTree")]
pub fn contain_process_tree(
	pid: u32,
	options: Option<ContainmentOptions>,
) -> Option<ProcessTreeContainment> {
	#[cfg(windows)]
	{
		use std::os::windows::io::{FromRawHandle, OwnedHandle};
		use windows_sys::Win32::System::Threading::{
			OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
		};
		let allow_breakaway = options.and_then(|options| options.allow_breakaway) == Some(true);
		let job = if allow_breakaway {
			ContainmentJob::create_allowing_breakaway()
		} else {
			ContainmentJob::create()
		}
		.ok()?;
		let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
		if process.is_null() {
			return None;
		}
		let process = unsafe { OwnedHandle::from_raw_handle(process) };
		job.assign(raw(&process)).ok()?;
		Some(ProcessTreeContainment { job: Some(job) })
	}
	#[cfg(not(windows))]
	{
		let _ = (pid, options);
		None
	}
}
