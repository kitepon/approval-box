import { errorMessagesEn } from "./error-messages-en.ts";
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
  | "too_large"
  | "unsupported_type"
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
  too_large: 413,
  unsupported_type: 415,
  internal: 500,
};

const english: Record<ErrorCode, string> = {
  validation_failed: "Check the request fields and try again.",
  unauthorized: "Your session is invalid or has expired. Sign in again.",
  subscription_expired: "Your subscription has expired.",
  not_found: "The requested item was not found.",
  conflict: "This operation conflicts with the current state. Refresh and review the latest information.",
  setup_not_verified: "Verify setup before continuing.",
  duplicate_suspected: "A similar request already exists. Review it before creating another.",
  confirm_required: "Review the request and confirm before continuing.",
  rate_limited: "Too many requests. Wait before trying again.",
  too_large: "This upload exceeds the permitted size or attachment count.",
  unsupported_type: "This file type is not supported.",
  internal: "A server error occurred. Please try again later.",
};

/** api.md の「エラー」の形で返す誤り。message は表示言語へ翻訳する固定の案内。code/extra は不変。 */
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

  body(locale: "ja" | "en" = "ja") {
    return { error: { code: this.code, message: locale === "en" ? (Object.hasOwn(errorMessagesEn, this.message) ? errorMessagesEn[this.message]! : english[this.code]) : this.message, ...this.extra } };
  }
}
