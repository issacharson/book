import { test } from "node:test";
import assert from "node:assert/strict";
import { LINKS, TARGET_BASE, files, forwardPage } from "./build.mjs";

test("each branded link forwards to lead-desk's fixed link of the same name", () => {
  for (const l of LINKS) {
    const html = forwardPage(l);
    const target = /http-equiv="refresh" content="0; url=([^"]+)"/.exec(html)[1];
    assert.equal(target, `${TARGET_BASE}${l.name}/`);
    assert.ok(html.includes(`location.replace(${JSON.stringify(target)})`));
    assert.ok(html.includes(`<a href="${target}">`));
    assert.match(html, /<meta name="robots" content="noindex">/);
  }
});

test("the site serves book.issacharson.com and every link", () => {
  const f = files();
  assert.equal(f.CNAME, "book.issacharson.com\n");
  for (const l of LINKS) assert.ok(f[`${l.name}/index.html`], l.name);
  assert.ok(f["index.html"].includes('href="/carematchr/"'));
});
