interface StoppableRuntime {
  readonly stop: () => Promise<void>;
}

export const stopRuntimeOnSignal = (runtime: StoppableRuntime): void => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const shutdown = () => {
      void runtime.stop().finally(() => {
        process.removeListener(signal, shutdown);
        process.kill(process.pid, signal);
      });
    };
    process.once(signal, shutdown);
  }
};
