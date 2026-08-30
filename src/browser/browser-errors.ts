export type BrowserLifecycleErrorCode =
  | "PROFILE_IN_USE"
  | "BACKGROUND_LAUNCH_FAILED"
  | "STARTUP_TIMEOUT"
  | "CDP_CONNECT_FAILED"
  | "PERSISTENT_CONTEXT_MISSING"
  | "CLEANUP_UNCONFIRMED";

export class BrowserLifecycleError extends Error {
  readonly code: BrowserLifecycleErrorCode;

  constructor(
    code: BrowserLifecycleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BrowserLifecycleError";
    this.code = code;
  }
}
