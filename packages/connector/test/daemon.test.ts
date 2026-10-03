import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldReplaceDaemon, versionOfEntry } from "../src/daemon.ts";

const entry = (version: string) => `/home/u/.approval-box/runtime/${version}/cli.mjs`;

test("デーモンの入れ替え: 古い版は新しい版へ替えるが、新しい版を古い版へ戻さない", () => {
  assert.deepEqual(versionOfEntry(entry("0.1.10")), [0, 1, 10]);
  assert.deepEqual(versionOfEntry("C:\\Users\\u\\.approval-box\\runtime\\0.1.9\\cli.mjs"), [0, 1, 9]);
  assert.equal(versionOfEntry("/repo/packages/connector/dist/cli.mjs"), null);
  assert.equal(shouldReplaceDaemon(entry("0.1.10"), entry("0.1.10")), false);
  assert.equal(shouldReplaceDaemon(entry("0.1.9"), entry("0.1.10")), true);
  assert.equal(shouldReplaceDaemon(entry("0.1.10"), entry("0.1.9")), false);
  assert.equal(shouldReplaceDaemon(entry("0.2.0"), entry("0.1.11")), false);
  // 版が読めない置き場（開発中の dist）は、今までどおり自分へ入れ替える
  assert.equal(shouldReplaceDaemon("/repo/dist/cli.mjs", entry("0.1.10")), true);
  assert.equal(shouldReplaceDaemon(undefined, entry("0.1.10")), true);
});
