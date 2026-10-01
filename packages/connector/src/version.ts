declare const __APPROVAL_BOX_VERSION__: string | undefined;

export const VERSION: string = typeof __APPROVAL_BOX_VERSION__ === "string" ? __APPROVAL_BOX_VERSION__ : "0.0.0-dev";

export function osName(): "macos" | "windows" | "linux" | string {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
}
