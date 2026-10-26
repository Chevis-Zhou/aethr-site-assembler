import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Security response headers for a static export on Cloudflare Workers static assets.
 *
 * Static assets serve no headers of their own beyond what `out/_headers` declares, so a
 * client site ships with none — Mozilla HTTP Observatory grades that D (30). This writes
 * the file after `next build`, so the build is the single source of truth for what the
 * page inlines.
 *
 * Why hashes and not `'unsafe-inline'`: a Next static export inlines its own bootstrap
 * (`self.__next_f.push(...)`, the RSC payload) into every page. `'unsafe-inline'` in
 * script-src costs 20 Observatory points and defeats the point of a CSP; the payloads are
 * fixed at build time, so each page's inline scripts are hashed into that page's own
 * policy. `style-src` stays `'self'`; only the *attribute* form (`style="…"`, which React
 * emits for dynamic values) gets `style-src-attr 'unsafe-inline'`, and inline `<style>`
 * elements are hashed like scripts.
 *
 * Cost: one `_headers` rule per page (Cloudflare caps a file at 100 rules and each line at
 * 2,000 characters — both checked here, loudly). Pages the build has no rule for (the 404,
 * served for any unknown path) get the 404 page's own CSP through `/:seg` and `/:seg/*`;
 * every page rule detaches that inherited CSP first, because browsers AND multiple CSP
 * headers and a shared catch-all would block each page's hashes. The root `/` is the one
 * route those two patterns do not match, so it sets its CSP with no detach — measured on
 * a deployed Worker (2026-09-30): a `/*` catch-all plus a detaching `/` rule served the
 * root TWO CSP headers, while detach on every other route worked.
 *
 * Spec: Business/CLAUDE.md → the shared-layer rule; scoring reference is
 * https://github.com/mdn/mdn-http-observatory (grader/charts.js).
 */

export const HEADERS_RULE_LIMIT = 100;
export const HEADERS_LINE_LIMIT = 2000;

const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com";
const GOOGLE_FONTS_FILES = "https://fonts.gstatic.com";
const TURNSTILE = "https://challenges.cloudflare.com";
// Cloudflare Web Analytics: the beacon is injected at the edge, after the build, so it never
// appears in `out/` to be detected. Granted on every site — without it the beacon is blocked
// and analytics silently stops (tasteled.com, 2026-09-30, the first deploy with this CSP).
const CF_ANALYTICS_SCRIPT = "https://static.cloudflareinsights.com";
const CF_ANALYTICS_BEACON = "https://cloudflareinsights.com";

export interface SecurityHeadersOptions {
  /** Origins the site's own JS `fetch`es or a form posts to (e.g. the portal API). */
  connectOrigins?: string[];
  /** Origins allowed as embedded frames, beyond anything detected. */
  frameOrigins?: string[];
  /** Only these exported preview shells may be embedded by their registered editor. */
  previewFrames?: Array<{ route: string; editorOrigin: string }>;
}

export interface PageAssets {
  /** `sha256-…` tokens for each executable inline `<script>`. */
  scriptHashes: string[];
  /** `sha256-…` tokens for each inline `<style>` element. */
  styleHashes: string[];
  /** Origins named by `<script src>`, `<link rel=stylesheet>`, `<iframe src>`. */
  scriptOrigins: string[];
  styleOrigins: string[];
  frameOrigins: string[];
}

function sriHash(content: string): string {
  return `'sha256-${crypto.createHash("sha256").update(content, "utf-8").digest("base64")}'`;
}

function originOf(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/** Data blocks (`application/ld+json`, `application/json`) are not executed, so CSP skips them. */
function isExecutable(type: string | null): boolean {
  if (type === null || type === "") return true;
  return /^(module|(text|application)\/(x-)?(java|ecma)script)$/i.test(type.trim());
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function scanHtml(html: string): PageAssets {
  const scriptHashes: string[] = [];
  const scriptOrigins: string[] = [];
  const styleHashes: string[] = [];
  const styleOrigins: string[] = [];
  const frameOrigins: string[] = [];

  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = m;
    const src = attr(attrs, "src");
    if (src !== null) {
      const origin = originOf(src);
      if (origin) scriptOrigins.push(origin);
    } else if (isExecutable(attr(attrs, "type"))) {
      scriptHashes.push(sriHash(body));
    }
  }

  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    styleHashes.push(sriHash(m[1]));
  }

  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    if (!/\bstylesheet\b/i.test(attr(m[1], "rel") ?? "")) continue;
    const origin = originOf(attr(m[1], "href") ?? "");
    if (origin) styleOrigins.push(origin);
  }

  for (const m of html.matchAll(/<iframe\b([^>]*)>/gi)) {
    const origin = originOf(attr(m[1], "src") ?? "");
    if (origin) frameOrigins.push(origin);
  }

  return {
    scriptHashes: unique(scriptHashes),
    styleHashes: unique(styleHashes),
    scriptOrigins: unique(scriptOrigins),
    styleOrigins: unique(styleOrigins),
    frameOrigins: unique(frameOrigins),
  };
}

function walk(dir: string, base = dir): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, base));
    else if (entry.isFile()) found.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return found.sort();
}

/**
 * Third-party runtime loads that never appear in the HTML: Turnstile is injected by JS.
 * Detected from the built chunks, so a site that drops the contact form drops the grant.
 */
function usesTurnstile(outDir: string, files: string[]): boolean {
  return files
    .filter((f) => f.startsWith("_next/static/") && f.endsWith(".js"))
    .some((f) => fs.readFileSync(path.join(outDir, f), "utf-8").includes("challenges.cloudflare.com"));
}

export interface PolicyInput {
  assets: PageAssets;
  turnstile: boolean;
  connectOrigins: string[];
  frameOrigins: string[];
  frameAncestors?: string[];
}

export function buildPolicy({ assets, turnstile, connectOrigins, frameOrigins, frameAncestors = [] }: PolicyInput): string {
  const scriptSrc = ["'self'", ...assets.scriptHashes, ...assets.scriptOrigins, CF_ANALYTICS_SCRIPT];
  const styleSrc = ["'self'", ...assets.styleHashes, ...assets.styleOrigins];
  const fontSrc = ["'self'", "data:"];
  const connectSrc = ["'self'", ...connectOrigins, CF_ANALYTICS_BEACON];
  const frames = [...frameOrigins, ...assets.frameOrigins];

  if (assets.styleOrigins.includes(GOOGLE_FONTS_CSS)) fontSrc.push(GOOGLE_FONTS_FILES);
  if (turnstile) {
    scriptSrc.push(TURNSTILE);
    connectSrc.push(TURNSTILE);
    frames.push(TURNSTILE);
  }

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'none'"]],
    ["script-src", unique(scriptSrc)],
    ["style-src", unique(styleSrc)],
    ["style-src-attr", ["'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["font-src", unique(fontSrc)],
    ["connect-src", unique(connectSrc)],
    ["media-src", ["'self'", "https:"]],
    ["manifest-src", ["'self'"]],
    ["frame-src", frames.length ? unique(frames) : ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'", ...connectOrigins]],
    ["frame-ancestors", frameAncestors.length ? unique(frameAncestors) : ["'none'"]],
  ];

  return [...directives.map(([name, values]) => `${name} ${values.join(" ")}`), "upgrade-insecure-requests"].join("; ");
}

const STATIC_HEADERS: Array<[string, string]> = [
  // No includeSubDomains/preload: a client apex can share a zone with hosts that are not ours.
  ["Strict-Transport-Security", "max-age=31536000"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
];

/** The public URL each HTML file answers on, under Cloudflare's `auto-trailing-slash`. */
export function routeFor(htmlFile: string): string {
  if (htmlFile === "index.html") return "/";
  if (htmlFile.endsWith("/index.html")) return `/${htmlFile.slice(0, -"index.html".length)}`;
  return `/${htmlFile.slice(0, -".html".length)}`;
}

export function generateHeadersFile(outDir: string, options: SecurityHeadersOptions = {}): string {
  const resolved = path.resolve(outDir);
  if (!fs.existsSync(resolved)) throw new Error(`No build output at ${resolved} — build first.`);

  const files = walk(resolved);
  const htmlFiles = files.filter((f) => f.endsWith(".html"));
  const turnstile = usesTurnstile(resolved, files);
  const connectOrigins = options.connectOrigins ?? [];
  const frameOrigins = options.frameOrigins ?? [];
  const previewFrames = new Map<string, string>();
  for (const preview of options.previewFrames ?? []) {
    const origin = new URL(preview.editorOrigin);
    if (origin.origin !== preview.editorOrigin || origin.username || origin.password
      || !(origin.protocol === "https:" || origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))
      throw new Error("Preview editorOrigin must be an exact secure origin");
    if (!/^\/(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)*(cms-preview|ae-preview)\/?$/.test(preview.route)
      || !htmlFiles.some(file => !["404.html", "_not-found.html"].includes(file) && routeFor(file) === preview.route)
      || previewFrames.has(preview.route)) throw new Error("Preview framing requires a unique exported preview route");
    previewFrames.set(preview.route, preview.editorOrigin);
  }
  const policyFor = (assets: PageAssets, editorOrigin?: string) => buildPolicy({ assets, turnstile, connectOrigins, frameOrigins, frameAncestors: editorOrigin ? [editorOrigin] : [] });

  // The catch-all serves the 404 page for any unknown path, so it carries that page's hashes.
  const notFound = htmlFiles.find((f) => f === "404.html");
  const fallback = notFound
    ? scanHtml(fs.readFileSync(path.join(resolved, notFound), "utf-8"))
    : scanHtml("");

  const cspLine = (assets: PageAssets, editorOrigin?: string) => `  Content-Security-Policy: ${policyFor(assets, editorOrigin)}`;
  const blocks: string[] = [
    ["/*", ...STATIC_HEADERS.map(([k, v]) => `  ${k}: ${v}`)].join("\n"),
    ["/:seg", cspLine(fallback)].join("\n"),
    ["/:seg/*", cspLine(fallback)].join("\n"),
  ];

  for (const file of htmlFiles) {
    if (file === "404.html" || file === "_not-found.html") continue;
    const route = routeFor(file);
    const assets = scanHtml(fs.readFileSync(path.join(resolved, file), "utf-8"));
    const detach = route === "/" ? [] : ["  ! Content-Security-Policy"];
    const editorOrigin = previewFrames.get(route);
    blocks.push([route, ...detach, ...(editorOrigin ? ["  ! X-Frame-Options"] : []), cspLine(assets, editorOrigin)].join("\n"));
  }

  if (blocks.length > HEADERS_RULE_LIMIT) {
    throw new Error(
      `${blocks.length} _headers rules; Cloudflare allows ${HEADERS_RULE_LIMIT}. ` +
        "Fewer per-page rules needed — group pages under a shared path prefix or drop pages.",
    );
  }

  const content = blocks.join("\n\n") + "\n";
  for (const line of content.split("\n")) {
    if (line.length > HEADERS_LINE_LIMIT) {
      throw new Error(`A _headers line is ${line.length} chars; Cloudflare allows ${HEADERS_LINE_LIMIT}: ${line.slice(0, 80)}…`);
    }
  }
  return content;
}

export function writeHeadersFile(outDir: string, options: SecurityHeadersOptions = {}): string {
  const content = generateHeadersFile(outDir, options);
  const target = path.join(path.resolve(outDir), "_headers");
  fs.writeFileSync(target, content, "utf-8");
  return target;
}

function parseArgs(argv: string[]): { outDir: string; options: SecurityHeadersOptions } {
  const options: SecurityHeadersOptions = { connectOrigins: [], frameOrigins: [] };
  let outDir = "out";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--connect") options.connectOrigins!.push(argv[++i]);
    else if (a === "--frame") options.frameOrigins!.push(argv[++i]);
    else if (a === "--out") outDir = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { outDir, options };
}

if (/\/deploy\/security-headers\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "")) {
  const { outDir, options } = parseArgs(process.argv.slice(2));
  const target = writeHeadersFile(outDir, options);
  const rules = fs.readFileSync(target, "utf-8").split(/\n\n/).length;
  console.log(`  wrote ${path.relative(process.cwd(), target)} (${rules} rules)`);
}
