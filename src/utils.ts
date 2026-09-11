export type Try<T> = { ok: true; value: T } | { ok: false; error: unknown }

export function runCatching<T>(fn: () => T): Try<T> {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

export async function runCatchingAsync<T>(fn: () => Promise<T>): Promise<Try<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
