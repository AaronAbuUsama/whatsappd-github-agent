export const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined;
