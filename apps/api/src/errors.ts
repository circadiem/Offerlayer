export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function jsonError(
  code: string,
  message: string,
  status = 400,
  extra: Record<string, unknown> = {},
): ApiError {
  return new ApiError(status, code, message, extra);
}
