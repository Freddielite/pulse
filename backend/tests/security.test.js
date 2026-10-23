import test from "node:test";
import assert from "node:assert/strict";
import { uuidParams } from "../src/lib/validateParams.js";
import { assertPublicHttpUrl } from "../src/lib/urlSafety.js";

test("uuidParams rejects non-UUID ids with 404 and passes real ones", () => {
  const handlers = {};
  uuidParams({ param: (name, fn) => (handlers[name] = fn) });
  let status = null;
  const res = { status: (s) => ((status = s), { json: () => {} }) };
  handlers.id({}, res, () => assert.fail("should not pass"), "not-a-uuid");
  assert.equal(status, 404);
  let passed = false;
  handlers.id({}, res, () => (passed = true), "0b0c3c7e-2f5e-4c43-9a61-3a8a1d3d6f10");
  assert.equal(passed, true);
});

test("monitor URLs pointing at private or metadata addresses are rejected", async () => {
  for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "http://localhost/"]) {
    await assert.rejects(() => assertPublicHttpUrl(url), undefined, url);
  }
});
