import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { externalizeInlineAssets, generateHeadersFile, scanHtml } from "./security-headers";

test("a large catalogue retains ordered bootstraps with a bounded strict CSP", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-headers-"));
  try {
    fs.writeFileSync(path.join(root, "index.html"), "<script>home()</script>");
    for (let i = 0; i < 535; i++) {
      const dir = path.join(root, "template", String(i));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "index.html"), `<script>first(${i})</script><script>second(${i})</script><style>p{color:red}</style><script type="application/ld+json">{}</script>`);
    }
    assert.throws(() => generateHeadersFile(root, { groups: [{ prefix: "/template/" }] }), /Externalize/);
    assert.equal(externalizeInlineAssets(root, ["/template/"]), 1605);
    const html = fs.readFileSync(path.join(root, "template/0/index.html"), "utf8");
    assert.deepEqual(scanHtml(html).scriptHashes, []);
    assert.match(html, /application\/ld\+json/);
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => fs.readFileSync(path.join(root, m[1]), "utf8"));
    assert.deepEqual(scripts, ["first(0)", "second(0)"]);
    const headers = generateHeadersFile(root, { groups: [{ prefix: "/template/", frameOrigins: ["'self'"] }] });
    assert.equal(headers.trim().split("\n\n").length, 5);
    assert.match(headers, /\/template\/\*/);
    assert.doesNotMatch(headers.match(/script-src [^;]+/)![0], /unsafe-inline/);
    assert.match(headers, /frame-src 'self'/);
    assert.match(headers, /frame-ancestors 'none'/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("only an explicit preview family permits embedding and dynamic CSS", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-headers-"));
  try {
    fs.mkdirSync(path.join(root, "template-demos/demo"), { recursive: true });
    fs.writeFileSync(path.join(root, "index.html"), "home");
    fs.writeFileSync(path.join(root, "template-demos/demo/index.html"), '<script src="preview.js"></script>');
    const headers = generateHeadersFile(root, { groups: [{ prefix: "/template-demos/", frameAncestors: ["'self'"], inlineStyles: true, styleOrigins: ["https://fonts.googleapis.com"], fontOrigins: ["https://cdn.fontshare.com"] }] });
    const demo = headers.split("\n\n").find(block => block.startsWith("/template-demos/"))!;
    assert.match(demo, /! X-Frame-Options/);
    assert.match(demo, /frame-ancestors 'self'/);
    assert.match(demo, /style-src 'self' https:\/\/fonts.googleapis.com 'unsafe-inline'/);
    assert.match(demo, /font-src [^;]*https:\/\/cdn.fontshare.com/);
    assert.match(demo, /font-src [^;]*https:\/\/fonts.gstatic.com/);
    assert.doesNotMatch(demo.match(/script-src [^;]+/)![0], /unsafe-inline/);
    assert.throws(() => generateHeadersFile(root, { groups: [{ prefix: "/" }] }), /literal non-root/);
    assert.throws(() => generateHeadersFile(root, { groups: [{ prefix: "/template-demos/", frameAncestors: ["https://example.com/path"] }] }), /exact HTTPS/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("3D preview workers and WASM are scoped to the requested group", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wasm-headers-"));
  try {
    fs.mkdirSync(path.join(root, "template-demos/demo"), { recursive: true });
    fs.writeFileSync(path.join(root, "index.html"), "home");
    fs.writeFileSync(path.join(root, "template-demos/demo/index.html"), "demo");
    const headers = generateHeadersFile(root, { groups: [{ prefix: "/template-demos/", blobWorkers: true, wasmEvaluation: true }] });
    const demo = headers.split("\n\n").find(block => block.startsWith("/template-demos/"))!;
    assert.match(demo, /worker-src 'self' blob:/);
    assert.match(demo, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.doesNotMatch(demo.match(/script-src [^;]+/)![0], /'unsafe-eval'|'unsafe-inline'/);
    assert.doesNotMatch(headers.split("\n\n").find(block => block.startsWith("/\n"))!, /wasm-unsafe-eval|worker-src/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
