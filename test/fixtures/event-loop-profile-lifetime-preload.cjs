const { Session } = require('node:inspector');
const post = Session.prototype.post;
const completed = [];
let debuggerCommands = 0;
Session.prototype.post = function(method, ...args) {
  if (method.startsWith('Debugger.')) debuggerCommands++;
  if (method === 'Profiler.stop' && typeof args.at(-1) === 'function') {
    const callback = args.at(-1);
    args[args.length - 1] = (error, result) => {
      if (result?.profile) completed.push(new WeakRef(result.profile));
      callback(error, result);
    };
  }
  return post.call(this, method, ...args);
};
globalThis.profileLifetimeReport = () => ({
  completed: completed.length,
  retained: completed.filter(ref => ref.deref() !== undefined).length,
  debuggerCommands,
});
