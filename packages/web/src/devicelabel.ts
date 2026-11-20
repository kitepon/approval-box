/** "Chrome on Windows": browser and OS family only, never a version, a device name or anything personal (library rule for deviceLabel). */
export function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\/|Opera/.test(userAgent) ? "Opera" : /Firefox\/|FxiOS/.test(userAgent) ? "Firefox"
    : /Chrome\/|CriOS/.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  // Android and iOS UAs also say Linux / Mac OS X, and ChromeOS says X11, so the narrower names come first.
  const os = /Windows/.test(userAgent) ? "Windows" : /Android/.test(userAgent) ? "Android" : /iPhone|iPad|iPod/.test(userAgent) ? "iOS"
    : /Mac OS X|Macintosh/.test(userAgent) ? "macOS" : /CrOS/.test(userAgent) ? "ChromeOS" : /Linux|X11/.test(userAgent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
