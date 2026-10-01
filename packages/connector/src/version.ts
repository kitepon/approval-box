declare const __KESSAIBAKO_VERSION__: string | undefined;

export const VERSION: string = typeof __KESSAIBAKO_VERSION__ === "string" ? __KESSAIBAKO_VERSION__ : "0.0.0-dev";

export function osName(): "macos" | "windows" | "linux" | string {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
}
