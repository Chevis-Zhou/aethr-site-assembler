import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { serveStatic, settlePage } from "tasteled-qa";
import { assembleFromSpec } from "../assemble";
import { siteSpecSchema } from "../site-spec";
import { runFastGate } from "../../qa/fast-gate";
import { writeHeadersFile } from "../../deploy/security-headers";
import { cmsFixture } from "./cms-fixture";

async function main() {
const root = path.resolve(__dirname, "../../../..");
const proof = path.join(root, ".deploy/assembly-cms-proof");
const site = path.join(proof, "site");
if (fs.existsSync(site) && fs.readdirSync(site).some(name => name !== "out")) throw new Error("Previous synthetic source exists; preserve it before rerunning");
if (fs.existsSync(path.join(site, "out"))) fs.rmSync(path.join(site, "out"), { recursive: true });
fs.mkdirSync(path.join(site, "src/app"), { recursive: true });
const write = (file: string, content: string) => { const full = path.join(site, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); };
const copy = (relative: string) => fs.cpSync(path.join(root, relative), path.join(site, relative), { recursive: true, filter: source => !source.includes("/__tests__") && !source.includes("/sample-specs") });
const sample = JSON.parse(fs.readFileSync(path.join(root, "src/lib/assembly/sample-specs/creative-studio.json"), "utf8"));
const spec = siteSpecSchema.parse({
  client: { name: "Synthetic journal", tagline: "Assembler verification", description: "Synthetic collection build verification.", email: "hello@collections.example" }, tokens: sample.tokens,
  seo: { siteName: "Synthetic journal" }, nav: [{ label: "Home", href: "/" }, { label: "Journal", href: "/journal/" }],
  pages: [{ slug: "/", title: "Synthetic journal", description: "Synthetic collection build verification.", sections: [{ type: "hero", props: { headline: "Synthetic journal", subheadline: "Synthetic collection build verification.", ctaText: "Read journal", ctaHref: "/journal/" } }] }],
  collections: [{ binding: "journal" }],
});
let previewHtml = "";
const previewParent = createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(previewHtml); });
await new Promise<void>(resolve => previewParent.listen(0, "127.0.0.1", resolve));
const parentAddress = previewParent.address(); assert.ok(parentAddress && typeof parentAddress !== "string");
const parentOrigin = `http://127.0.0.1:${parentAddress.port}`;
const cms = cmsFixture(); cms.editorOrigin = parentOrigin;
cms.view.assets["image-one"].src = "/assets/synthetic.svg";
cms.view.documents["unselected"] = { _id: "unselected", _type: "post", title: "UNSELECTED_DRAFT_SENTINEL" };
copy("src/components"); copy("src/lib/edit"); copy("src/lib/assembly"); copy("src/lib/utils.ts"); copy("src/lib/rich-text.ts"); copy("src/lib/theme");
copy("src/app/globals.css"); copy("postcss.config.mjs");
write("package.json", JSON.stringify({ name: "synthetic-assembler-proof", private: true, dependencies: { next: "16.3.8", react: "19.2.4", "react-dom": "19.2.4" } }));
write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], strict: true, noEmit: true, allowJs: true, skipLibCheck: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, jsx: "react-jsx", isolatedModules: true, paths: { "@/*": ["./src/*"] } }, include: ["src/**/*.ts", "src/**/*.tsx", "next-env.d.ts"], exclude: ["node_modules"] }));
write("next.config.mjs", "export default {output:'export',trailingSlash:true,images:{unoptimized:true}};\n");
write("src/app/layout.tsx", `import type {ReactNode} from "react"; import Link from "next/link"; import "./globals.css";
export default function Layout({children}:{children:ReactNode}) { return <html lang="en"><body><header><Link href="/">Home</Link> <Link href="/journal/">Journal</Link></header><main>{children}</main><footer><a href="mailto:hello@collections.example">hello@collections.example</a></footer></body></html>; }
`);
write("public/assets/synthetic.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#ddd"/><circle cx="400" cy="300" r="120" fill="#333"/></svg>');
write("spec.json", JSON.stringify(spec));
const assembled = await assembleFromSpec(path.join(site, "spec.json"), site, { cms });
// Changing the source object after assembly proves production remains at frozen N.
cms.view.documents["post-one"].title = "NEW_DRAFT_SENTINEL";
let buildLog = "";
try {
  buildLog = execFileSync(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build", "--webpack"], { cwd: site, encoding: "utf8", stdio: "pipe", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  fs.writeFileSync(path.join(proof, "build.log"), buildLog);
  const gate = await runFastGate({ spec, projectRoot: site, cmsPages: assembled.cmsPages, browserChannel: "chrome" });
  assert.equal(gate.passed, true, JSON.stringify(gate.findings));
  writeHeadersFile(path.join(site, "out"), { previewFrames: [{ route: "/cms-preview/", editorOrigin: parentOrigin }] });
  const upstream = await serveStatic(path.join(site, "out"));
  const rules = fs.readFileSync(path.join(site, "out/_headers"), "utf8").trim().split(/\n\n+/).map(block => { const [route, ...headers] = block.split("\n"); return { route, headers }; });
  const matches = (route: string, url: string) => route === "/*" || route === url || route === "/:seg" && /^\/[^/]+$/.test(url) || route === "/:seg/*" && /^\/[^/]+\/.*$/.test(url);
  const proxy = createServer(async (request, response) => {
    try {
      const route = new URL(request.url ?? "/", upstream.url).pathname;
      const fetched = await fetch(upstream.url + (request.url ?? "/"));
      response.statusCode = fetched.status;
      for (const [name, value] of fetched.headers) if (!["content-length", "transfer-encoding", "connection"].includes(name)) response.setHeader(name, value);
      for (const rule of rules) if (matches(rule.route, route)) for (const raw of rule.headers) {
        const header = raw.trim();
        if (header.startsWith("! ")) response.removeHeader(header.slice(2));
        else { const split = header.indexOf(":"); response.setHeader(header.slice(0, split), header.slice(split + 1).trim()); }
      }
      response.end(Buffer.from(await fetched.arrayBuffer()));
    } catch { response.writeHead(500); response.end("Fixture proxy failed"); }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress !== "string");
  const server = { url: `http://127.0.0.1:${proxyAddress.port}`, close: async () => { await new Promise<void>(resolve => proxy.close(() => resolve())); await upstream.close(); } };
  const productionHeaders = (await fetch(server.url + "/journal/")).headers;
  const previewHeaders = (await fetch(server.url + "/cms-preview/")).headers;
  assert.match(productionHeaders.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(productionHeaders.get("x-frame-options"), "DENY");
  assert.ok(previewHeaders.get("content-security-policy")?.includes("frame-ancestors " + parentOrigin));
  assert.equal(previewHeaders.get("x-frame-options"), null);
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1504, height: 846 } });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url + "/journal/", { waitUntil: "load" }); await settlePage(page);
    await page.evaluate(() => { (window as unknown as {proofNavigation:string}).proofNavigation = "hydrated"; });
    await page.getByRole("link", { name: "Frozen first entry", exact: true }).click();
    await page.waitForURL("**/journal/first-entry/"); await settlePage(page);
    assert.equal(await page.evaluate(() => (window as unknown as {proofNavigation:string}).proofNavigation), "hydrated");
    assert.equal(await page.locator("h1").innerText(), "Frozen first entry");
    assert.equal(await page.locator("article").innerText().then(value => value.includes("Synthetic author")), true);
    assert.equal(await page.locator("img").evaluate(img => (img as HTMLImageElement).naturalWidth), 800);
    assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), "https://collections.example/journal/first-entry/");
    await page.reload(); await settlePage(page); assert.equal(await page.locator("h1").innerText(), "Frozen first entry");
    await page.screenshot({ path: path.join(proof, "detail-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(proof, "detail-mobile.png"), fullPage: true });
    const draft = structuredClone(cms.view); draft.documents["post-one"].title = "Authorized draft preview";
    previewHtml = `<iframe src="${server.url}/cms-preview/"></iframe><script>window.addEventListener('message',event=>{if(event.origin==='${server.url}' && event.data?.type==='ready')event.source.postMessage({ae:1,type:'render',payload:{content:${JSON.stringify(draft).replace(/</g, "\\u003c")},page:'/journal/first-entry',readOnly:true}},'${server.url}');});</script>`;
    await page.goto(parentOrigin + "/");
    await page.frameLocator("iframe").getByRole("heading", { name: "Authorized draft preview", exact: true }).waitFor();
    const untrustedParent = createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(`<iframe src="${server.url}/cms-preview/"></iframe>`); });
    await new Promise<void>(resolve => untrustedParent.listen(0, "127.0.0.1", resolve));
    try {
      const address = untrustedParent.address(); assert.ok(address && typeof address !== "string");
      const blocked = page.waitForEvent("console", { predicate: message => message.text().includes("frame-ancestors"), timeout: 5000 });
      await page.goto(`http://127.0.0.1:${address.port}/`); await blocked;
    } finally { await new Promise<void>(resolve => untrustedParent.close(() => resolve())); }
    assert.deepEqual(errors, []);
    const files: string[] = [];
    const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else files.push(file); } };
    walk(path.join(site, "out"));
    for (const file of files) assert.equal(/UNSELECTED_DRAFT_SENTINEL|NEW_DRAFT_SENTINEL/.test(fs.readFileSync(file, "utf8")), false, file);
    const artifactHash = createHash("sha256"); for (const file of files.sort()) { artifactHash.update(path.relative(path.join(site, "out"), file)); artifactHash.update(fs.readFileSync(file)); }
    fs.writeFileSync(path.join(proof, "result.json"), JSON.stringify({ status: "LOCAL_PASS", pages: assembled.cmsPages, gate, artifactHash: artifactHash.digest("hex"), checks: ["true-next-build", "frozen-html-rsc", "hydrated-navigation", "reload", "reference", "image", "canonical", "mobile", "authorized-preview-under-generated-csp", "untrusted-preview-parent-blocked", "production-framing-denied", "draft-sentinel-scan"] }, null, 2) + "\n");
    fs.rmSync(path.join(proof, "failure.log"), { force: true });
    console.log("LOCAL_PASS " + proof);
  } finally { await browser.close(); await server.close(); }
} catch (error) {
  fs.writeFileSync(path.join(proof, "failure.log"), buildLog + "\n" + String(error) + "\n" + String((error as {stdout?:string;stderr?:string}).stdout ?? "") + "\n" + String((error as {stderr?:string}).stderr ?? ""));
  throw error;
} finally {
  await new Promise<void>(resolve => previewParent.close(() => resolve()));
  for (const entry of fs.readdirSync(site)) if (entry !== "out") fs.rmSync(path.join(site, entry), { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
