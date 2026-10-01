export type ErrorCode =
  | "validation_failed"
  | "unauthorized"
  | "subscription_expired"
  | "not_found"
  | "conflict"
  | "setup_not_verified"
  | "duplicate_suspected"
  | "confirm_required"
  | "rate_limited"
  | "internal";

const statusOf: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthorized: 401,
  subscription_expired: 402,
  not_found: 404,
  conflict: 409,
  setup_not_verified: 409,
  duplicate_suspected: 409,
  confirm_required: 409,
  rate_limited: 429,
  internal: 500,
};

/** api.md の「エラー」の形で返す誤り。message は利用者にそのまま見せてよい日本語の文。 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extra: Record<string, unknown>;
  readonly retryAfter: number | undefined;

  constructor(code: ErrorCode, message: string, extra: Record<string, unknown> = {}, retryAfter?: number) {
    super(message);
    this.code = code;
    this.status = statusOf[code];
    this.extra = extra;
    this.retryAfter = retryAfter;
  }

  body() {
    return { error: { code: this.code, message: this.message, ...this.extra } };
  }
}
