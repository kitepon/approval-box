import type { Locale } from "./shared/locales.ts";
import { errorMessage, type ErrorCode } from "./shared/error-translations.ts";
export type { ErrorCode } from "./shared/error-translations.ts";

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

  body(locale: Locale = "ja") {
    const message = errorMessage(this.code, this.message, locale);
    return { error: { code: this.code, message, ...this.extra } };
  }
}
