// Test-only device signer for login-billing's keyholes, written from the library's wire page (login-billing v0.21.1 docs/keyholes.md):
// P-256 keys and signatures through WebCrypto, 64-byte r || s with low s, canonical base64url. keyhole-signer.test.ts proves it on the library's vectors.
import { APP_ID } from "../src/keyholes.ts";

export type Role = "parent" | "child";
export type Add = { key: string; role: Role; issued: number; signer: string; s: string };
export type Device = {
  /** The 65-byte uncompressed point, base64url (87 characters). */
  publicKey: string;
  /** Header value `v1 k=… t=… n=… s=…` for one request; the nonce is random unless given. */
  sign(method: string, pathWithQuery: string, body?: string | Uint8Array, origin?: string, nowMs?: number, nonce?: string): Promise<string>;
  /** Signs a signed text (lbk1 lines) and returns the low-s r || s, base64url. */
  signText(text: string): Promise<string>;
};

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const utf8 = (text: string) => new TextEncoder().encode(text);
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));

/** s > n/2 becomes n - s, so one text has one signature form. */
export function lowS(rs: Uint8Array) {
  const s = BigInt("0x" + Buffer.from(rs.subarray(32)).toString("hex"));
  if (s <= N / 2n) return rs;
  return new Uint8Array([...rs.subarray(0, 32), ...Buffer.from((N - s).toString(16).padStart(64, "0"), "hex")]);
}

export const requestText = async (appId: string, key: string, method: string, pathWithQuery: string, body: string | Uint8Array, origin: string, t: number, nonce: string) =>
  ["lbk1", "req", appId, key, method.toUpperCase(), pathWithQuery, b64u(await sha256(typeof body === "string" ? utf8(body) : body)), origin, String(t), nonce].join("\n");

export const addText = (appId: string, add: Omit<Add, "s">) => ["lbk1", "add", appId, add.key, add.role, String(add.issued), add.signer].join("\n");

/** A new device key, or the one of private scalar `d` (base64url, the vectors' keys). */
export async function makeDevice(options: { d?: string; appId?: string; origin?: string } = {}): Promise<Device> {
  const appId = options.appId ?? APP_ID;
  let privateKey: CryptoKey;
  if (options.d) {
    // PKCS#8 of a P-256 scalar with no public part; WebCrypto derives the point.
    const pkcs8 = Buffer.concat([Buffer.from("3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420", "hex"), Buffer.from(options.d, "base64url")]);
    privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, P256, true, ["sign"]);
  } else {
    privateKey = (await crypto.subtle.generateKey(P256, true, ["sign", "verify"])).privateKey;
  }
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = b64u(new Uint8Array([4, ...Buffer.from(jwk.x!, "base64url"), ...Buffer.from(jwk.y!, "base64url")]));
  const signText = async (text: string) => b64u(lowS(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, utf8(text)))));
  return {
    publicKey,
    signText,
    async sign(method, pathWithQuery, body = "", origin = options.origin ?? "", nowMs = Date.now(), nonce = b64u(crypto.getRandomValues(new Uint8Array(16)))) {
      const s = await signText(await requestText(appId, publicKey, method, pathWithQuery, body, origin, nowMs, nonce));
      return `v1 k=${publicKey} t=${nowMs} n=${nonce} s=${s}`;
    },
  };
}

/** The add statement a parent signs for `childPub`, as keys/accept takes it in `{ "add": … }`. */
export async function parentAdd(parent: Device, childPub: string, role: Role, issuedMs = Date.now(), appId = APP_ID): Promise<Add> {
  const add = { key: childPub, role, issued: issuedMs, signer: parent.publicKey };
  return { ...add, s: await parent.signText(addText(appId, add)) };
}

/** Headers of one signed request (the device's origin is the server's). */
export const signed = async (device: Device, method: string, path: string, body = "", nowMs?: number) => ({ "login-billing-key": await device.sign(method, path, body, undefined, nowMs) });

type App = { request(path: string, init: RequestInit): Response | Promise<Response> };

/** POSTs a signed JSON body to one of the app's /v1/keys/* routes. */
export async function keysCall(app: App, device: Device, route: "start" | "accept" | "admit" | "others" | "leave" | "me", body: unknown = {}) {
  const path = `/v1/keys/${route}`, text = JSON.stringify(body);
  const res = await app.request(path, { method: "POST", body: text, headers: { ...(await signed(device, "POST", path, text)), "content-type": "application/json" } });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

/** A new parent device that starts its own entry on the app. */
export async function startParent(app: App, origin: string) {
  const device = await makeDevice({ origin });
  const res = await keysCall(app, device, "start", { role: "parent" });
  if (res.status !== 200) throw new Error(`start: ${res.status} ${JSON.stringify(res.json)}`);
  return { device, entry: res.json.entry as string };
}

/** A new device of `role` that `parent` adds to its entry (keys/accept). */
export async function joinAs(app: App, origin: string, parent: Device, role: Role = "child") {
  const device = await makeDevice({ origin });
  const res = await keysCall(app, device, "accept", { add: await parentAdd(parent, device.publicKey, role) });
  if (res.status !== 200) throw new Error(`accept: ${res.status} ${JSON.stringify(res.json)}`);
  return device;
}
