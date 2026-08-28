export class HttpError extends Error {
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(
    public readonly statusCode: number,
    message: string,
    options?: { code?: string; details?: unknown },
  ) {
    super(message);
    this.name = "HttpError";
    this.code = options?.code;
    this.details = options?.details;
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}
