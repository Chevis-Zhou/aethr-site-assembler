import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CheckFinding } from "./types";
import { RASTER_EXT, hashFile, readManifest } from "./image-pipeline/optimize-images";

/**
 * The asset check, `qa-specification.md` §7. Every raster asset in the build output must
 * appear in the optimization manifest, hash-matched — blocking. This replaces a byte cap:
 * the real unattended failure is the optimizer silently not running (ImageOptim is a
 * macOS GUI app driven from a script), not a client's heavy photo. Manifest coverage is
 * deterministic and has no threshold to argue about.
 */

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (RASTER_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

export async function checkAssetManifest(outDir: string, projectRoot: string): Promise<CheckFinding[]> {
  const manifest = await readManifest(projectRoot);
  const rasterFiles = await walk(outDir);
  const findings: CheckFinding[] = [];

  for (const file of rasterFiles) {
    // Next copies public/<path> to out/<path>; optimizer keys are project-relative.
    const relFromOut = path.relative(outDir, file);
    const sourceKey = path.join("public", relFromOut);
    const hash = await hashFile(file);

    if (manifest[sourceKey] !== hash) {
      findings.push({
        severity: "blocker",
        check: "asset-manifest-coverage",
        message: `Raster asset "${relFromOut}" is not covered by the optimization manifest — the optimizer may not have run on it.`,
        expected: "hash present in .image-manifest.json",
        actual: manifest[sourceKey] ? "hash mismatch" : "no manifest entry",
      });
    }
  }

  return findings;
}
