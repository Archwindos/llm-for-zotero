import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manifest includes every required Zotero 10 field, including update_url", async () => {
  const manifest = JSON.parse(await readFile(new URL("../addon/manifest.json", import.meta.url), "utf8"));
  const app = manifest.applications.zotero;
  for (const key of ["id", "update_url", "strict_min_version", "strict_max_version"]) assert.equal(typeof app[key], "string", key);
  assert.equal(new URL(app.update_url).protocol, "https:");
  assert.equal(app.strict_min_version, "10.0"); assert.equal(app.strict_max_version, "10.*");
});
