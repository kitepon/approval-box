import type { Locale } from "./locales.ts";
import { errorMessagesKo, errorMessagesHans, errorMessagesHant } from "./error-messages-east-asian.ts";
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

const fallback: Record<Exclude<Locale, "ja" | "en">, Record<ErrorCode, string>> = {
  ko: {
    validation_failed: "입력 내용을 확인한 뒤 다시 시도해 주세요.", unauthorized: "로그인 정보가 유효하지 않거나 만료되었습니다. 다시 로그인해 주세요.",
    subscription_expired: "구독이 만료되었습니다.", not_found: "항목을 찾을 수 없습니다.", conflict: "현재 상태와 충돌합니다. 새로고침한 뒤 최신 내용을 확인해 주세요.",
    setup_not_verified: "설정을 확인한 뒤 계속해 주세요.", duplicate_suspected: "비슷한 요청이 있습니다. 새로 요청하기 전에 확인해 주세요.",
    confirm_required: "요청 내용을 확인한 뒤 진행해 주세요.", rate_limited: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    too_large: "업로드 크기 또는 첨부 파일 수가 한도를 초과했습니다.", unsupported_type: "지원하지 않는 파일 형식입니다.", internal: "서버에 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.",
  },
  "zh-Hans": {
    validation_failed: "请检查输入内容后重试。", unauthorized: "登录信息无效或已过期，请重新登录。", subscription_expired: "订阅已过期。", not_found: "找不到所需项目。",
    conflict: "此操作与当前状态冲突，请刷新并确认最新内容。", setup_not_verified: "请验证设置后继续。", duplicate_suspected: "已有相似请求，请确认后再提交新请求。",
    confirm_required: "请确认请求内容后继续。", rate_limited: "请求过多，请稍后重试。", too_large: "上传大小或附件数量超出限制。", unsupported_type: "不支持此文件类型。", internal: "服务器发生错误，请稍后重试。",
  },
  "zh-Hant": {
    validation_failed: "請檢查輸入內容後再試。", unauthorized: "登入資訊無效或已到期，請重新登入。", subscription_expired: "訂閱已到期。", not_found: "找不到所需項目。",
    conflict: "此操作與目前狀態衝突，請重新整理並確認最新內容。", setup_not_verified: "請驗證設定後繼續。", duplicate_suspected: "已有相似請求，請確認後再提交新請求。",
    confirm_required: "請確認請求內容後繼續。", rate_limited: "請求過多，請稍後再試。", too_large: "上傳大小或附件數量超出限制。", unsupported_type: "不支援此檔案類型。", internal: "伺服器發生錯誤，請稍後再試。",
  },
};

/** Resolve only known fixed product messages; never translate arbitrary response/user text. */
export function fixedErrorTranslation(message: string, locale: Locale): string | undefined {
  const catalogs = { en: errorMessagesEn, ko: errorMessagesKo, "zh-Hans": errorMessagesHans, "zh-Hant": errorMessagesHant };
  for (const catalog of Object.values(catalogs)) {
    for (const [key, value] of Object.entries(catalog)) {
      if (message === key || message === value) return locale === "ja" ? key : catalogs[locale][key];
    }
  }
  const japanese: Record<ErrorCode, string> = {
    validation_failed: "入力内容を確かめて、もう一度お試しください。", unauthorized: "ログイン情報が無効か期限切れです。もう一度ログインしてください。",
    subscription_expired: "契約の期限が切れています。", not_found: "項目が見つかりません。", conflict: "現在の状態と競合しています。最新の内容を確かめてください。",
    setup_not_verified: "セットアップを確認してから続けてください。", duplicate_suspected: "似た申請があります。内容を確認してください。", confirm_required: "申請内容を確認してから続けてください。",
    rate_limited: "要求が多すぎます。少し待ってお試しください。", too_large: "アップロードの大きさか添付の数が上限を超えています。", unsupported_type: "対応していないファイル形式です。", internal: "サーバーで問題が起きました。時間を置いて試してください。",
  };
  for (const catalog of [english, japanese, ...Object.values(fallback)]) {
    const entry = Object.entries(catalog).find(([, value]) => value === message);
    if (entry) {
      const code = entry[0] as ErrorCode;
      return locale === "ja" ? japanese[code] : locale === "en" ? english[code] : fallback[locale][code];
    }
  }
  return undefined;
}

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
    const catalog = locale === "ja" ? undefined : ({ en: errorMessagesEn, ko: errorMessagesKo, "zh-Hans": errorMessagesHans, "zh-Hant": errorMessagesHant })[locale];
    const message = !catalog ? this.message : Object.hasOwn(catalog, this.message) ? catalog[this.message]! : locale === "en" ? english[this.code] : fallback[locale as keyof typeof fallback][this.code];
    return { error: { code: this.code, message, ...this.extra } };
  }
}
