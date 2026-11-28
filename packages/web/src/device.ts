import { BrowserDevice, IndexedDbKeyStore, type Role } from "@kitepon/login-billing/web";

// The browser is a child device of the account (Owner 2026-11-28): one non-extractable key in this origin's IndexedDB, admitted by a phone of
// the same account that reads its QR (login-billing 0.28.1 browser part). Every /v1 request is signed with it (api.ts).
export const APP_ID = "dev.kitepon.approvalbox";

let device: BrowserDevice | undefined;
export const browserDevice = () => (device ??= new BrowserDevice(APP_ID, new IndexedDbKeyStore(APP_ID), { keysUrl: `${location.origin}/v1/keys/` }));

/** The entry (account) and role keys/me answered for the kept key; undefined while signed out. */
let current: { entry: string; role: Role } | undefined;
export const setAccount = (who: { entry: string; role: Role } | undefined) => { current = who; };
export const account = () => current;
