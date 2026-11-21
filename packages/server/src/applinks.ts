// アプリのリンク（Android App Links・Apple Universal Links）の宣言。中身は設定（環境変数）だけから作る。形は docs/architecture/login-pass.md の「Webのサインインの戻り先」。
// 開くのは /app/websignin（ライブラリ 1.20 の Web サインインの戻り）だけ。webcredentials は使わない。

export const WEBSIGNIN_PATH = "/app/websignin";

export type AppLinks = { android: { packageName: string; fingerprints: string[] }[]; appleAppIds: string[] };

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const APPLE_APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/;

/**
 * AB_ANDROID_APP_LINKS: `<package>=<SHA-256 fingerprint>[,<fingerprint>…]`, apps separated by `;`
 *   (fingerprints as Play Console shows them: 32 hex pairs joined by `:`).
 * AB_APPLE_APP_IDS: `<TeamID>.<bundleId>`, comma-separated.
 * A malformed entry is left out and named in `problems` (no values in the message).
 */
export function parseAppLinks(android = "", apple = ""): { links: AppLinks; problems: string[] } {
  const problems: string[] = [];
  const links: AppLinks = { android: [], appleAppIds: [] };
  for (const [i, entry] of android.split(";").map((s) => s.trim()).filter(Boolean).entries()) {
    const [name = "", list = ""] = entry.split("=", 2).map((s) => s.trim());
    const fingerprints = list.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!PACKAGE.test(name) || !fingerprints.length || !fingerprints.every((f) => FINGERPRINT.test(f))) problems.push(`AB_ANDROID_APP_LINKS entry ${i + 1}`);
    else links.android.push({ packageName: name, fingerprints });
  }
  for (const [i, id] of apple.split(",").map((s) => s.trim()).filter(Boolean).entries()) {
    if (APPLE_APP_ID.test(id)) links.appleAppIds.push(id);
    else problems.push(`AB_APPLE_APP_IDS entry ${i + 1}`);
  }
  return { links, problems };
}

/** /.well-known/assetlinks.json（Android が開く道は、アプリの manifest で /app/websignin に絞る）。設定が無ければ null（404）。 */
export function assetLinks(links: AppLinks) {
  if (!links.android.length) return null;
  return links.android.map((a) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: a.packageName, sha256_cert_fingerprints: a.fingerprints },
  }));
}

/** /.well-known/apple-app-site-association（applinks だけ、/app/websignin だけ）。設定が無ければ null（404）。 */
export function appleAppSiteAssociation(links: AppLinks) {
  if (!links.appleAppIds.length) return null;
  return { applinks: { details: [{ appIDs: links.appleAppIds, components: [{ "/": WEBSIGNIN_PATH, comment: "web sign-in return (login-billing 1.20)" }] }] } };
}
