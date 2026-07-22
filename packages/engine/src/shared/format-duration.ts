export const formatDuration = (durationMs: number | undefined): string => {
  const milliseconds = durationMs ?? 0;
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${Number((milliseconds / 1_000).toFixed(1))}s`;
};
