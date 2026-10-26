/**
 * The image optimizer, and the rules it enforces, for every AethrDesign and TasteLed site
 * that can reach this repo — `qa-specification.md` §6. One copy (Business `CLAUDE.md` →
 * "One feature, one build"). Consumers:
 *
 * - this template's `scripts/publish-client.ts` and asset check (`asset-check.ts`);
 * - `tasteled`, whose `pnpm optimize-images` runs this file with `--manifest .imageoptim-manifest.json`;
 * - `portfolio-2026`, whose `scripts/optimize-images.mjs` imports it and adds only what is
 *   specific to that site (which images open in its zoom viewer, its placeholder exemption).
 *
 * Change behaviour here and it changes for all of them. `tasteled-portfolio-template` keeps
 * its own copy on purpose — it is sold as a standalone package and cannot reach a sibling repo.
 *
 * The rules (quality over bytes — sources are never lossy-compressed):
 *
 * 1. sharp — resize anything wider than 2500px; strip EXIF/IPTC/XMP and keep the ICC
 *    profile (P3 from phone photos, sRGB from screenshots), applying EXIF orientation first.
 *    Re-encodes are lossless or as close as the format allows: PNG at compression level 9,
 *    JPEG at quality 100 (mozjpeg), WebP lossless with `exact` (keeps the colour under
 *    transparent pixels) at effort 6, AVIF lossless. Size guard: when only metadata would
 *    change and the re-encode is not smaller, the original stays.
 *    Animated WebP/GIF keep every frame: they are read with `animated: true`, measured per
 *    frame, never auto-rotated, and re-encoded with their animation (WebP lossless, GIF on
 *    its own palette). Without this a resize or metadata strip silently kept frame 1 only.
 *    A site may opt named files into a larger *bounded* budget (`OptimizeOptions.bounded`):
 *    those are held to a long-edge and decoded-pixel limit instead of the 2500px cap, and
 *    `boundedBudgetViolations()` also checks their encoded size.
 * 2. Lossless byte-level compression. On macOS that is ImageOptim.app. On Linux it is the
 *    binaries ImageOptim wraps — `oxipng` and `jpegtran` — run directly, both keeping the ICC profile, which is what lets a
 *    client's own upload be processed by the shared cloud builder (ticket 012 §3 reason 3)
 *    rather than serialised through one Mac.
 *
 * A SHA-256 manifest (`{ relPath: sha256 }`, default `.image-manifest.json` at the project
 * root) records every file that has been through both stages; only files whose hash differs
 * are touched. The asset check reads the same file. Any `raw/` directory under `public/` holds
 * untouched compose sources and is never touched (see `isRawCapture`). Never pre-convert to
 * WebP or AVIF here — serving formats are the site's image layer's job.
 *
 * Deliberately NOT here: any next/image awareness. This template sets
 * `images: { unoptimized: true }` and renders plain `<img>`; the optimizer works on `public/`
 * directly, so it suits a static export and a next/image site alike. See `prewarm.ts` for the
 * part that did need a Cloudflare rewrite.
 *
 * One sharp per process: a consumer that imports this module must not load its own copy of
 * sharp in the same process (portfolio-2026, `scripts/verify-sharp.mjs`: two libvips binaries
 * hang). Everything a consumer needs from sharp is exported here.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
export { sharp };

const execFileAsync = promisify(execFile);

export const MAX_WIDTH = 2500;
export const RASTER_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".tiff"]);
const IMAGEOPTIM_EXT = new Set([".png", ".jpg", ".jpeg", ".gif"]);

export const DEFAULT_MANIFEST = ".image-manifest.json";

/** A larger budget for images a site opts in, e.g. portfolio-2026's zoomable detail images. */
export interface BoundedBudget {
  /** Longest allowed edge, either axis. */
  maxEdge: number;
  /** Decoded area limit, which bounds memory however small the file is. */
  maxPixels: number;
  /** Encoded size limit, checked by `boundedBudgetViolations()`. */
  maxBytes?: number;
}

export interface OptimizeOptions {
  manifestFile?: string;
  /** Process these files instead of walking `publicDir`. Non-raster paths are ignored. */
  files?: string[];
  /** Files to leave alone, on top of `raw/` capture directories. */
  exclude?: (file: string) => boolean;
  /** Files held to `budget` instead of the MAX_WIDTH cap. */
  bounded?: { budget: BoundedBudget; includes: (file: string) => boolean };
}

type ManifestArg = string | OptimizeOptions | undefined;
const asOptions = (arg: ManifestArg): OptimizeOptions => (typeof arg === "string" ? { manifestFile: arg } : (arg ?? {}));

export function manifestPath(projectRoot: string, manifestFile = DEFAULT_MANIFEST): string {
  return path.join(projectRoot, manifestFile);
}

export async function readManifest(projectRoot: string, manifestFile?: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(manifestPath(projectRoot, manifestFile), "utf8"));
  } catch {
    return {};
  }
}

async function writeManifest(projectRoot: string, data: Record<string, string>, manifestFile?: string): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(manifestPath(projectRoot, manifestFile), JSON.stringify(sorted, null, 2) + "\n");
}

export async function hashFile(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

/** Largest size inside the budget with the same aspect ratio; never upscales. */
export function boundedDimensions(
  width: number,
  height: number,
  budget: BoundedBudget,
  longEdge = budget.maxEdge,
): { width: number; height: number } {
  const scale = Math.min(1, longEdge / Math.max(width, height), Math.sqrt(budget.maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/**
 * Any `raw/` directory under `public/` holds untouched captures that compose scripts crop
 * from — never referenced by a site, and the MAX_WIDTH resize silently breaks any hard-coded
 * crop region against them (portfolio-2026, 2026-08-03: a 6000px source capped to 2500
 * killed a compose script mid-run).
 */
function isRawCapture(file: string, publicDir: string): boolean {
  const rel = path.relative(publicDir, path.dirname(file));
  return !rel.startsWith("..") && !path.isAbsolute(rel) && rel.split(path.sep).includes("raw");
}

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (RASTER_EXT.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

/** The files a run covers: the explicit list or the whole tree, minus raw captures and exclusions. */
async function collect(projectRoot: string, publicDir: string, options: OptimizeOptions): Promise<string[]> {
  const files = options.files
    ? options.files.map((f) => path.resolve(projectRoot, f)).filter((f) => RASTER_EXT.has(path.extname(f).toLowerCase()))
    : await walk(publicDir);
  return files.filter((f) => !isRawCapture(f, publicDir) && !options.exclude?.(f));
}

async function getQueueCount(): Promise<number> {
  const { stdout } = await execFileAsync("osascript", [
    "-e",
    'tell application "ImageOptim" to do queuecount command',
  ]);
  return parseInt(stdout.trim(), 10);
}

async function imageOptimHelpersRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("bash", [
      "-c",
      "ps aux | grep -iE 'optipng|advpng|pngout|zopfli|jpegoptim|jpegtran|gifsicle' | grep -v grep",
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * The Linux half of stage 2.
 *
 * ImageOptim is a GUI wrapper over `oxipng`/`zopfli`/`jpegtran`; a CI runner has them
 * natively. Each tool is optional — a missing binary logs and is skipped rather than
 * failing a client's publish, because the *manifest* is what the asset check gates on and
 * sharp (stage 1) has already run by this point.
 */
async function runLosslessLinux(files: string[]): Promise<void> {
  const has = async (bin: string) => {
    try {
      await execFileAsync("which", [bin]);
      return true;
    } catch {
      return false;
    }
  };

  const pngs = files.filter((f) => path.extname(f).toLowerCase() === ".png");
  const jpgs = files.filter((f) => [".jpg", ".jpeg"].includes(path.extname(f).toLowerCase()));

  if (pngs.length > 0 && (await has("oxipng"))) {
    // `--strip safe` keeps the ICC profile sharp deliberately preserved above.
    await execFileAsync("oxipng", ["-o", "4", "--strip", "safe", "-q", ...pngs]);
    console.log(`oxipng: ${pngs.length} png(s)`);
  } else if (pngs.length > 0) {
    console.log("oxipng not installed — skipping the PNG lossless pass");
  }

  if (jpgs.length > 0 && (await has("jpegtran"))) {
    for (const file of jpgs) {
      const tmp = `${file}.tmp`;
      try {
        // `-copy icc` keeps the colour profile and drops every other marker, matching stage 1.
        await execFileAsync("jpegtran", ["-copy", "icc", "-optimize", "-progressive", "-outfile", tmp, file]);
        const [before, after] = await Promise.all([fs.stat(file), fs.stat(tmp)]);
        if (after.size < before.size) await fs.rename(tmp, file);
        else await fs.unlink(tmp);
      } catch {
        await fs.unlink(tmp).catch(() => {});
      }
    }
    console.log(`jpegtran: ${jpgs.length} jpeg(s)`);
  } else if (jpgs.length > 0) {
    console.log("jpegtran not installed — skipping the JPEG lossless pass");
  }
}

/**
 * Returns whether the files are settled on disk. A run that is not settled must not record
 * hashes: ImageOptim keeps rewriting files after we stop watching, and a hash taken mid-pass
 * goes stale the moment it lands (aethrdesign-web, 2026-10-07: a fixed 20-minute cap recorded
 * 300 files while ImageOptim still had 20 queued, so 11 entries were wrong on the next check).
 */
async function runImageOptim(files: string[]): Promise<boolean> {
  if (process.platform !== "darwin") {
    await runLosslessLinux(files);
    return true;
  }
  const targets: string[] = [];
  for (const f of files) {
    if (!IMAGEOPTIM_EXT.has(path.extname(f).toLowerCase())) continue;
    try {
      await fs.access(f);
      targets.push(f);
    } catch {
      /* file gone */
    }
  }
  if (targets.length === 0) return true;

  try {
    await execFileAsync("open", ["-a", "ImageOptim", ...targets]);
  } catch (err) {
    console.warn(`ImageOptim pass skipped -- could not launch app: ${(err as Error).message}`);
    return true;
  }

  // No fixed cap: a big batch of zopfli passes legitimately runs for an hour. Wait while the
  // queue moves or a helper is working. ImageOptim can keep rows it never clears (seen: 20
  // left with nothing running), so a queue idle for STALL_MS with no helper counts as done:
  // nothing is writing, which is all the manifest needs.
  const STALL_MS = 3 * 60_000;
  let settled = false;
  let lastCount = -1;
  let lastProgress = Date.now();
  for (;;) {
    let count: number;
    try {
      count = await getQueueCount();
    } catch {
      console.warn("ImageOptim pass: lost contact with app");
      break;
    }
    if (count === 0) {
      settled = true;
      break;
    }
    if (count !== lastCount || (await imageOptimHelpersRunning())) {
      lastCount = count;
      lastProgress = Date.now();
    } else if (Date.now() - lastProgress > STALL_MS) {
      console.warn(`ImageOptim pass: ${count} row(s) left in the queue with nothing running; treating as done`);
      settled = true;
      break;
    }
    await sleep(3_000);
  }

  // queuecount can reach 0 while zopfli/advpng are still writing to disk.
  const helperStart = Date.now();
  while (await imageOptimHelpersRunning()) {
    if (Date.now() - helperStart > 5 * 60_000) {
      settled = false;
      break;
    }
    await sleep(3_000);
  }

  // Quit so the app does not keep its rows: handing files to an app that still holds an old
  // list re-runs the whole list (aethrdesign-web 2026-10-07: 3 new files queued ~1,400 steps
  // and a second pass started after this one had returned).
  if (settled) await execFileAsync("osascript", ["-e", 'tell application "ImageOptim" to quit']).catch(() => {});

  if (settled) console.log(`ImageOptim pass done on ${targets.length} file(s)`);
  else console.warn(`ImageOptim pass did not settle on ${targets.length} file(s); not recording them -- run again`);
  return settled;
}

/** Stage 1 on one file. Returns whether the file was rewritten. */
export async function optimizeImage(
  filePath: string,
  options: { budget?: BoundedBudget; projectRoot?: string } = {},
): Promise<boolean> {
  const meta = await sharp(filePath, { failOn: "none", animated: true }).metadata();
  const animated = (meta.pages ?? 1) > 1;
  const width = meta.width ?? 0;
  // With `animated: true`, `height` is the whole frame stack; one frame is `pageHeight`.
  const height = animated ? (meta.pageHeight ?? meta.height ?? 0) : (meta.height ?? 0);
  const { budget } = options;
  // sharp resizes after .rotate(), so a bounded target is computed in the upright orientation.
  const rotated = !animated && [5, 6, 7, 8].includes(meta.orientation ?? 1);
  const boundedSize = budget ? boundedDimensions(rotated ? height : width, rotated ? width : height, budget) : null;
  const needsResize = budget
    ? Math.max(width, height) > budget.maxEdge || width * height > budget.maxPixels
    : width > MAX_WIDTH;

  if (!needsResize && !meta.exif && !meta.iptc && !meta.xmp) return false;

  let pipeline = animated
    ? sharp(filePath, { animated: true }).keepIccProfile()
    : sharp(filePath).rotate().keepIccProfile();
  if (needsResize) pipeline = pipeline.resize(boundedSize ?? { width: MAX_WIDTH, withoutEnlargement: true });

  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  else if (ext === ".jpg" || ext === ".jpeg") pipeline = pipeline.jpeg({ quality: 100, mozjpeg: true });
  else if (ext === ".webp") pipeline = pipeline.webp({ lossless: true, exact: true, effort: 6 });
  else if (ext === ".avif") pipeline = pipeline.avif({ lossless: true });
  else if (ext === ".gif") pipeline = pipeline.gif({ reuse: true });

  const tmp = `${filePath}.tmp`;
  const oldSize = (await fs.stat(filePath)).size;
  await pipeline.toFile(tmp);
  const newSize = (await fs.stat(tmp)).size;

  if (!needsResize && newSize >= oldSize) {
    await fs.unlink(tmp);
    return false;
  }

  await fs.rename(tmp, filePath);

  const rel = path.relative(options.projectRoot ?? process.cwd(), filePath);
  if (needsResize) {
    const target = boundedSize ? `${boundedSize.width}×${boundedSize.height} (bounded)` : `<=${MAX_WIDTH}px`;
    console.log(`resized ${rel}: ${width}×${height} -> ${target}`);
  } else console.log(`stripped metadata ${rel} (${oldSize} -> ${newSize})`);
  return true;
}

const budgetFor = (file: string, options: OptimizeOptions) =>
  options.bounded?.includes(file) ? options.bounded.budget : undefined;

export interface OptimizeResult {
  processed: number;
  skipped: number;
  manifestEntries: number;
  /** False when the lossless pass did not finish; its files were left out of the manifest. */
  settled: boolean;
}

/**
 * Sharp + lossless pass + manifest, gated so only content-changed files are touched.
 * The third argument is a manifest filename (the original signature) or `OptimizeOptions`.
 */
export async function optimizeImages(
  projectRoot: string,
  publicDir: string,
  manifestOrOptions?: ManifestArg,
): Promise<OptimizeResult> {
  const options = asOptions(manifestOrOptions);
  const files = await collect(projectRoot, publicDir, options);
  const manifest = await readManifest(projectRoot, options.manifestFile);

  const toProcess: string[] = [];
  let skipped = 0;
  for (const f of files) {
    const rel = path.relative(projectRoot, f);
    const hash = await hashFile(f);
    if (manifest[rel] === hash) skipped++;
    else toProcess.push(f);
  }

  let processed = 0;
  for (const file of toProcess) {
    if (await optimizeImage(file, { budget: budgetFor(file, options), projectRoot })) processed++;
  }

  const settled = toProcess.length > 0 ? await runImageOptim(toProcess) : true;

  // Unsettled files stay out of the manifest, so the next run picks them up again.
  for (const f of settled ? toProcess : []) {
    const rel = path.relative(projectRoot, f);
    try {
      manifest[rel] = await hashFile(f);
    } catch {
      /* file removed during processing */
    }
  }
  await writeManifest(projectRoot, manifest, options.manifestFile);

  return { processed, skipped, manifestEntries: Object.keys(manifest).length, settled };
}

export interface SharpGuardResult {
  changed: number;
  total: number;
  /** Files whose hash is not in the manifest yet — stage 2 still owes them a pass. */
  pending: number;
}

/**
 * Stage 1 only, no manifest write — fast enough for a pre-commit hook. `pending` tells the
 * caller how many files still need the full `optimizeImages` pass before deploy.
 */
export async function sharpGuard(projectRoot: string, publicDir: string, options: OptimizeOptions = {}): Promise<SharpGuardResult> {
  const files = await collect(projectRoot, publicDir, options);
  let changed = 0;
  for (const file of files) {
    if (await optimizeImage(file, { budget: budgetFor(file, options), projectRoot })) changed++;
  }
  const manifest = await readManifest(projectRoot, options.manifestFile);
  let pending = 0;
  for (const f of files) if (manifest[path.relative(projectRoot, f)] !== (await hashFile(f))) pending++;
  return { changed, total: files.length, pending };
}

/**
 * Every published bounded file must sit inside its budget, manifest match or not. Returns one
 * message per violation; a missing file throws, because a published reference must resolve.
 */
export async function boundedBudgetViolations(publicDir: string, files: string[], budget: BoundedBudget): Promise<string[]> {
  const problems: string[] = [];
  for (const file of files) {
    const label = "/" + path.relative(publicDir, file).split(path.sep).join("/");
    const bytes = (await fs.stat(file)).size;
    if (budget.maxBytes && bytes > budget.maxBytes) {
      problems.push(`${label} is ${(bytes / 1e6).toFixed(1)} MB, over the ${budget.maxBytes / 1e6} MB budget; prepare a bounded derivative.`);
    }
    const meta = await sharp(file).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (Math.max(w, h) > budget.maxEdge || w * h > budget.maxPixels) {
      problems.push(`${label} is ${w}×${h}, over the ${budget.maxEdge}px / ${budget.maxPixels / 1e6}MP budget; optimize it before publishing.`);
    }
  }
  return problems;
}

/** Records every current file as optimized without touching it — for a tree already clean. */
export async function seedManifest(projectRoot: string, publicDir: string, manifestOrOptions?: ManifestArg): Promise<number> {
  const options = asOptions(manifestOrOptions);
  const manifest: Record<string, string> = {};
  for (const f of await collect(projectRoot, publicDir, { ...options, files: undefined })) {
    manifest[path.relative(projectRoot, f)] = await hashFile(f);
  }
  await writeManifest(projectRoot, manifest, options.manifestFile);
  return Object.keys(manifest).length;
}

// CLI: npx tsx src/lib/qa/image-pipeline/optimize-images.ts [--project-root <path>] [--public-dir <path>]
//      [--manifest <file>] [--seed-manifest | --sharp-only] [file ...]
// With no files it walks the public dir. `--sharp-only` runs stage 1 without touching the manifest.
if (process.argv[1]?.replace(/\\/g, "/").includes("qa/image-pipeline/optimize-images")) {
  const args = process.argv.slice(2);
  const valueFlags = new Set(["--project-root", "--public-dir", "--manifest"]);
  const flag = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const files = args.filter((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1]));
  const projectRoot = path.resolve(flag("--project-root", process.cwd()));
  const publicDir = path.resolve(flag("--public-dir", path.join(projectRoot, "public")));
  const options: OptimizeOptions = {
    manifestFile: flag("--manifest", DEFAULT_MANIFEST),
    ...(files.length ? { files } : {}),
  };

  const run = async () => {
    if (args.includes("--seed-manifest")) {
      const n = await seedManifest(projectRoot, publicDir, options);
      console.log(`optimize-images: seeded ${options.manifestFile} with ${n} file(s)`);
    } else if (args.includes("--sharp-only")) {
      const r = await sharpGuard(projectRoot, publicDir, options);
      console.log(`optimize-images: sharp pass -- ${r.changed} of ${r.total} file(s) updated`);
      if (r.pending) console.log(`${r.pending} image(s) not yet fully compressed -- run the full pass before deploying.`);
    } else {
      const r = await optimizeImages(projectRoot, publicDir, options);
      console.log(
        `optimize-images: ${r.processed} processed, ${r.skipped} already optimized, manifest has ${r.manifestEntries} entries`,
      );
      // Non-zero so a chained step (e.g. a hash re-record) does not run on files still being written.
      if (!r.settled) process.exitCode = 1;
    }
  };
  run().catch((err: unknown) => {
    console.error("optimize-images failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
