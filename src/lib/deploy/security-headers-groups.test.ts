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
    const headers = generateHeadersFile(root, { groups: [{ prefix: "/template-demos/", blobWorkers: true, blobAssets: true, wasmEvaluation: true }] });
    const demo = headers.split("\n\n").find(block => block.startsWith("/template-demos/"))!;
    assert.match(demo, /connect-src 'self' blob:/);
    assert.match(demo, /worker-src 'self' blob:/);
    assert.match(demo, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.doesNotMatch(demo.match(/script-src [^;]+/)![0], /'unsafe-eval'|'unsafe-inline'/);
    assert.doesNotMatch(headers.split("\n\n").find(block => block.startsWith("/\n"))!, /wasm-unsafe-eval|worker-src|connect-src [^;]*blob:/);
    const defaults = generateHeadersFile(root, { groups: [{ prefix: "/template-demos/" }] });
    assert.doesNotMatch(defaults, /connect-src [^;]*blob:/);
    assert.doesNotMatch(defaults, /script-src [^;]*'unsafe-eval'/);
    assert.doesNotMatch(defaults, /media-src [^;]*data:/);
    const evaluated = generateHeadersFile(root, { groups: [{ prefix: "/template-demos/", scriptEvaluation: true, dataMedia: true }] });
    assert.match(evaluated.split("\n\n").find(block => block.startsWith("/template-demos/"))!, /script-src 'self' 'unsafe-eval'/);
    assert.match(evaluated.split("\n\n").find(block => block.startsWith("/template-demos/"))!, /media-src 'self' https: data:/);
    assert.doesNotMatch(evaluated.split("\n\n").find(block => block.startsWith("/\n"))!, /media-src [^;]*data:/);
    assert.doesNotMatch(evaluated.split("\n\n").find(block => block.startsWith("/\n"))!, /script-src [^;]*'unsafe-eval'/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("React style elements survive script externalization when styles are disabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hydration-headers-"));
  try {
    const dir = path.join(root, "template-demos/portfolio");
    fs.mkdirSync(dir, { recursive: true });
    const style = '<style data-selection-default="true">::selection { background: #bfdbfe; }</style>';
    fs.writeFileSync(path.join(dir, "index.html"), `<head>${style}</head><body><script>first()</script>${style}<script>second()</script><script type="application/ld+json">{}</script></body>`);
    assert.equal(externalizeInlineAssets(root, ["/template-demos/"], { styles: false }), 2);
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    assert.equal(html.split(style).length - 1, 2);
    assert.doesNotMatch(html, /<link/);
    const scanned = scanHtml(html);
    assert.deepEqual(scanned.scriptHashes, []);
    assert.equal(scanned.styleHashes.length, 1);
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => fs.readFileSync(path.join(root, m[1]), "utf8"));
    assert.deepEqual(scripts, ["first()", "second()"]);
    assert.match(html, /application\/ld\+json/);
    assert.throws(() => generateHeadersFile(root, { groups: [{ prefix: "/template-demos/" }] }), /Externalize/);
    assert.doesNotThrow(() => generateHeadersFile(root, { groups: [{ prefix: "/template-demos/", inlineStyles: true }] }));
    fs.appendFileSync(path.join(dir, "index.html"), '<script>stillInline()</script>');
    assert.throws(() => generateHeadersFile(root, { groups: [{ prefix: "/template-demos/", inlineStyles: true }] }), /Externalize/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an isolated demo group can remove the storefront API grant", () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'isolated-connect-'));
 try {
  fs.mkdirSync(path.join(root,'template-demos/demo'),{recursive:true});
  fs.writeFileSync(path.join(root,'index.html'),'home');
  fs.writeFileSync(path.join(root,'template-demos/demo/index.html'),'demo');
  const headers=generateHeadersFile(root,{connectOrigins:['https://app.tasteled.com'],groups:[{prefix:'/template-demos/',connectOrigins:[]}]});
  const demo=headers.split('\n\n').find(block=>block.startsWith('/template-demos/'))!;
  assert.doesNotMatch(demo,/app\.tasteled\.com/);
  assert.match(headers.split('\n\n').find(block=>block.startsWith('/\n'))!,/app\.tasteled\.com/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
