/** Preserve failure status even when cleanup empties the event loop before grace. */
export function createBrowserShutdown({ closeServer, sockets, children, graceMs = 1000 }) {
  let stopping = false;
  return {
    isStopping: () => stopping,
    stop(code = 0) {
      if (stopping) return;
      stopping = true;
      process.exitCode = code;
      closeServer();
      for (const socket of sockets) socket.destroy();
      for (const child of [...children].reverse()) child.kill('SIGTERM');
      setTimeout(() => process.exit(code), graceMs).unref();
    },
  };
}
