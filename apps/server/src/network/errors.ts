import type { ApiError } from "@rescu/live";

/** A failure a route turns into `{ error, code }` with this HTTP status (see services.ts's error handler). */
export class ApiFail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiFail";
  }

  body(): ApiError {
    return { error: this.message, code: this.code };
  }
}
