import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  HEADERS_RULE_LIMIT,
  buildPolicy,
  generateHeadersFile,
  routeFor,
  scanHtml,
} from "./security-headers";

const hash = (s: string) => `'sha256-${crypto.createHash("sha256").update(s).digest("base64")}'`;

function site(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-headers-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

describe("scanHtml", () => {
  it("hashes executable inline scripts and skips data blocks and src scripts", () => {
    const html = `
      <script>self.__next_f.push([0])</script>
      <script type="application/ld+json">{"@type":"Thing"}</script>
      <script src="/_next/static/a.js"></script>
      <script src="https://cdn.example.com/x.js"></script>`;
    const a = scanHtml(html);
    assert.deepEqual(a.scriptHashes, [hash("self.__next_f.push([0])")]);
    assert.deepEqual(a.scriptOrigins, ["https://cdn.example.com"]);
  });

  it("hashes inline <style> and collects stylesheet and iframe origins", () => {
    const a = scanHtml(`
      <style>.a{color:red}</style>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
      <link rel="preconnect" href="https://fonts.gstatic.com">
      <iframe src="https://www.youtube-nocookie.com/embed/x"></iframe>`);
    assert.deepEqual(a.styleHashes, [hash(".a{color:red}")]);
    assert.deepEqual(a.styleOrigins, ["https://fonts.googleapis.com"]);
    assert.deepEqual(a.frameOrigins, ["https://www.youtube-nocookie.com"]);
  });
});

describe("buildPolicy", () => {
  const empty = scanHtml("");
  const base = { assets: empty, turnstile: false, connectOrigins: [], frameOrigins: [] };

  it("never puts 'unsafe-inline' in script-src or style-src", () => {
    const csp = buildPolicy({ ...base, assets: scanHtml("<script>a()</script><style>b{}</style>") });
    const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `))!;
    assert.ok(!directive("script-src").includes("unsafe"));
    assert.ok(!directive("style-src").includes("unsafe"));
    assert.equal(directive("style-src-attr"), "style-src-attr 'unsafe-inline'");
  });

  it("locks framing and sets default-src none", () => {
    const csp = buildPolicy(base);
    assert.match(csp, /^default-src 'none'; /);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /frame-src 'none'/);
  });

  it("grants Google Fonts files only when its stylesheet is used", () => {
    assert.ok(!buildPolicy(base).includes("gstatic"));
    const csp = buildPolicy({ ...base, assets: scanHtml('<link rel="stylesheet" href="https://fonts.googleapis.com/css2">') });
    assert.match(csp, /font-src [^;]*https:\/\/fonts\.gstatic\.com/);
  });

  it("opens Turnstile in script, connect and frame together", () => {
    const csp = buildPolicy({ ...base, turnstile: true });
    for (const d of ["script-src", "connect-src", "frame-src"]) {
      assert.match(csp, new RegExp(`${d} [^;]*https://challenges\\.cloudflare\\.com`));
    }
  });

  it("adds declared connect origins to connect-src and form-action", () => {
    const csp = buildPolicy({ ...base, connectOrigins: ["https://app.example.com"] });
    assert.match(csp, /connect-src 'self' https:\/\/app\.example\.com/);
    assert.match(csp, /form-action 'self' https:\/\/app\.example\.com/);
  });

  it("always lets Cloudflare Web Analytics load and report, since the edge injects it after the build", () => {
    const csp = buildPolicy(base);
    assert.match(csp, /script-src [^;]*https:\/\/static\.cloudflareinsights\.com/);
    assert.match(csp, /connect-src [^;]*https:\/\/cloudflareinsights\.com/);
    assert.ok(!/form-action [^;]*cloudflareinsights/.test(csp), "a beacon is not a form target");
  });
});

describe("routeFor", () => {
  it("maps files to the URL auto-trailing-slash serves them on", () => {
    assert.equal(routeFor("index.html"), "/");
    assert.equal(routeFor("about.html"), "/about");
    assert.equal(routeFor("work/acme.html"), "/work/acme");
    assert.equal(routeFor("brand-book/index.html"), "/brand-book/");
  });
});

describe("generateHeadersFile", () => {
  it("allows only the recorded editor to frame the exact preview shell", () => {
    const dir = site({"index.html":"<p>home</p>","cms-preview.html":"<script>preview()</script>","404.html":"<p>missing</p>"});
    const rules = Object.fromEntries(generateHeadersFile(dir,{previewFrames:[{route:"/cms-preview",editorOrigin:"https://portal.example"}]}).trim().split("\n\n").map(rule=>[rule.split("\n")[0],rule]));
    assert.match(rules["/*"], /X-Frame-Options: DENY/);
    assert.match(rules["/cms-preview"], /! X-Frame-Options/);
    assert.match(rules["/cms-preview"], /frame-ancestors https:\/\/portal\.example(?:;|$)/);
    assert.match(rules["/cms-preview"], /img-src 'self' data: blob: https:/);
    for (const route of ["/", "/:seg", "/:seg/*"]) {
      assert.match(rules[route], /frame-ancestors 'none'/);
      assert.ok(!rules[route].includes("! X-Frame-Options"));
    }
  });

  it("refuses framing exceptions for production, nonexistent, duplicate or nonexact origins", () => {
    const dir = site({"index.html":"<p/>","about.html":"<p/>","cms-preview/index.html":"<p/>"});
    const valid = {route:"/cms-preview/",editorOrigin:"http://localhost:3000"};
    assert.doesNotThrow(()=>generateHeadersFile(dir,{previewFrames:[valid]}));
    for (const preview of [{...valid,route:"/about"},{...valid,route:"/cms-preview"},{...valid,editorOrigin:"https://portal.example/path"},{...valid,editorOrigin:"http://portal.example"},{...valid,editorOrigin:"https://portal.example; frame-ancestors *"}])
      assert.throws(()=>generateHeadersFile(dir,{previewFrames:[preview]}));
    assert.throws(()=>generateHeadersFile(dir,{previewFrames:[valid,valid]}),/unique exported/);
  });

  it("supports an exact exported preview under a registered renderer prefix", () => {
    const dir = site({"html-proof/cms-preview/index.html":"<p/>","html-proof/index.html":"<p/>"});
    const headers = generateHeadersFile(dir,{previewFrames:[{route:"/html-proof/cms-preview/",editorOrigin:"https://portal.example"}]});
    const blocks = Object.fromEntries(headers.trim().split("\n\n").map(rule=>[rule.split("\n")[0],rule]));
    assert.match(blocks["/html-proof/cms-preview/"], /frame-ancestors https:\/\/portal\.example/);
    assert.match(blocks["/html-proof/"], /frame-ancestors 'none'/);
    assert.throws(()=>generateHeadersFile(dir,{previewFrames:[{route:"/html-proof/*/cms-preview/",editorOrigin:"https://portal.example"}]}));
  });

  it("emits static headers, a 404-CSP fallback and one rule per page, 404 excluded", () => {
    const dir = site({
      "index.html": "<script>home()</script>",
      "about.html": "<script>about()</script>",
      "404.html": "<script>nf()</script>",
      "_not-found.html": "<script>nf()</script>",
    });
    const rules = generateHeadersFile(dir).trim().split("\n\n");
    const byPath = Object.fromEntries(rules.map((r) => [r.split("\n")[0], r]));
    assert.deepEqual(Object.keys(byPath), ["/*", "/:seg", "/:seg/*", "/about", "/"]);
    assert.match(byPath["/*"], /Strict-Transport-Security: max-age=\d{8,}/);
    assert.match(byPath["/*"], /X-Content-Type-Options: nosniff/);
    assert.ok(!byPath["/*"].includes("Content-Security-Policy"), "catch-all carries no CSP");
    assert.ok(byPath["/:seg"].includes(hash("nf()")), "fallback carries the 404 hashes");
    assert.equal(byPath["/:seg"].split("\n")[1], byPath["/:seg/*"].split("\n")[1]);
    assert.ok(byPath["/about"].includes("! Content-Security-Policy"));
    assert.ok(byPath["/about"].includes(hash("about()")));
    assert.ok(!byPath["/about"].includes(hash("home()")));
  });

  it("does not detach on the root, which the fallback patterns never match", () => {
    const dir = site({ "index.html": "<script>home()</script>" });
    const root = generateHeadersFile(dir).trim().split("\n\n").find((r) => r.startsWith("/\n"))!;
    assert.ok(!root.includes("!"));
    assert.ok(root.includes(hash("home()")));
  });

  it("detects Turnstile from built chunks", () => {
    const dir = site({
      "index.html": "<p>hi</p>",
      "_next/static/chunks/a.js": 'load("https://challenges.cloudflare.com/turnstile/v0/api.js")',
    });
    assert.match(generateHeadersFile(dir), /script-src [^;]*challenges\.cloudflare\.com/);
  });

  it("fails loudly past Cloudflare's 100-rule cap", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < HEADERS_RULE_LIMIT; i++) files[`p${i}.html`] = "<p/>";
    assert.throws(() => generateHeadersFile(site(files)), /_headers rules/);
  });

  it("fails loudly on a line over 2,000 characters", () => {
    const scripts = Array.from({ length: 45 }, (_, i) => `<script>s${i}()</script>`).join("");
    assert.throws(() => generateHeadersFile(site({ "index.html": scripts })), /2000/);
  });
});
