export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Network failure, missing worker, or a 5xx. The phone flow continues offline. */
export function isApiUnavailable(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 0 || err.status >= 500);
}
