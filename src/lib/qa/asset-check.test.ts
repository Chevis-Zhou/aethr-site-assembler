import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkAssetManifest } from "./asset-check";
import { seedManifest } from "./image-pipeline/optimize-images";

test("static exports resolve image hashes through their canonical public source paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asset-manifest-"));
  try {
    const publicDir = path.join(root, "public"), outDir = path.join(root, "out");
    await fs.mkdir(path.join(publicDir, "assets"), { recursive: true });
    await fs.mkdir(path.join(outDir, "assets"), { recursive: true });
    const source = path.join(publicDir, "assets/image.webp"), exported = path.join(outDir, "assets/image.webp");
    await fs.writeFile(source, "synthetic-image-bytes"); await fs.copyFile(source, exported);
    await seedManifest(root, publicDir);
    const manifest = JSON.parse(await fs.readFile(path.join(root, ".image-manifest.json"), "utf8"));
    assert.ok(manifest["public/assets/image.webp"]);
    assert.deepEqual(await checkAssetManifest(outDir, root), []);
    await fs.writeFile(exported, "tampered-export-bytes");
    assert.equal((await checkAssetManifest(outDir, root))[0]?.actual, "hash mismatch");
    await fs.copyFile(source, exported);
    await fs.writeFile(path.join(root, ".image-manifest.json"), "{}");
    assert.equal((await checkAssetManifest(outDir, root))[0]?.actual, "no manifest entry");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
