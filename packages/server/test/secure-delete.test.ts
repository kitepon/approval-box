import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, get } from "../src/db.ts";

test("deleted rows leave no free pages after reopen, and secure_delete is on", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-secure-"));
  try {
    const file = join(dir, "a.db");
    let db = openDb(file);
    db.exec("create table t (x text)");
    db.exec("pragma secure_delete = off");
    for (let i = 0; i < 2000; i++) db.prepare("insert into t values (?)").run("secret-" + "x".repeat(200) + i);
    db.exec("delete from t");
    db.exec("pragma wal_checkpoint(truncate)");
    assert.ok((get<{ freelist_count: number }>(db, "pragma freelist_count")?.freelist_count ?? 0) > 0);
    db.close();
    db = openDb(file);
    assert.equal(get<{ secure_delete: number }>(db, "pragma secure_delete")?.secure_delete, 1);
    assert.equal(get<{ freelist_count: number }>(db, "pragma freelist_count")?.freelist_count, 0);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
