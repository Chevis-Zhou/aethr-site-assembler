import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { siteSpecSchema, type SiteSpec } from "./site-spec";
import { generateClientConfig, generatePage } from "./generate";
import { prepareCollections, type AssemblyCmsInput, type CmsPage } from "./collections";
import { generateCollectionFiles } from "./generate-collections";

export interface AssemblyResult {
  filesWritten: string[];
  pagesGenerated: number;
  sectionsUsed: string[];
  cmsPages?: CmsPage[];
}

const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const managedManifest = ".deploy/assembly-cms-files.json";
function safeTarget(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error("Generated path escapes project root");
  let current = target;
  while (current !== path.resolve(root)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Generated path traverses a symlink: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
  return target;
}
function preflightManaged(root: string, files: Map<string, string>): Record<string, string> {
  const manifest = safeTarget(root, managedManifest);
  const previous: Record<string, string> = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : {};
  for (const [relative, hash] of Object.entries(previous)) {
    if (!/^src\/(?:app\/.*\.(?:tsx|ts)|lib\/edit\/shared\/cms\/site-data\.ts)$/.test(relative) || typeof hash !== "string") throw new Error("Invalid CMS generated-file manifest");
    const target = safeTarget(root, relative);
    if (fs.existsSync(target) && digest(fs.readFileSync(target, "utf8")) !== hash) throw new Error(`CMS assembler-owned file was manually changed: ${relative}`);
  }
  for (const relative of files.keys()) {
    const target = safeTarget(root, relative);
    if (fs.existsSync(target) && !Object.hasOwn(previous, relative)) throw new Error(`CMS output would overwrite a file it does not own: ${relative}`);
  }
  return previous;
}

function slugToFilePath(slug: string): string {
  if (slug === "/") return "src/app/page.tsx";
  const clean = slug.startsWith("/") ? slug.slice(1) : slug;
  return `src/app/${clean}/page.tsx`;
}

export async function assembleFromSpec(
  specPath: string,
  projectRoot: string,
  options: { cms?: AssemblyCmsInput } = {},
): Promise<AssemblyResult> {
  const resolvedSpec = path.resolve(specPath);
  const raw = fs.readFileSync(resolvedSpec, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${resolvedSpec}`);
  }

  const result = z.safeParse(siteSpecSchema, parsed);
  if (!result.success) {
    const issues = z.prettifyError(result.error);
    throw new Error(`Spec validation failed:\n${issues}`);
  }

  const spec: SiteSpec = result.data;
  if (spec.collections?.length && !options.cms) throw new Error("Configured collection bindings require frozen CMS build input");
  if (!spec.collections?.length && options.cms) throw new Error("CMS build input requires configured collection bindings");
  const prepared = options.cms ? prepareCollections(spec, options.cms) : undefined;
  const cmsFiles = prepared ? generateCollectionFiles(prepared, spec.pages) : new Map<string, string>();
  const previousCms = preflightManaged(projectRoot, cmsFiles);
  // Validate authored destinations before any file mutation too.
  for (const page of spec.pages) safeTarget(projectRoot, slugToFilePath(page.slug));
  safeTarget(projectRoot, "src/lib/client-config.ts");
  const filesWritten: string[] = [];
  const sectionsUsed = new Set<string>();

  for (const relative of Object.keys(previousCms)) {
    if (!cmsFiles.has(relative)) {
      const target = safeTarget(projectRoot, relative);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
  }

  const configContent = generateClientConfig(spec);
  const configPath = path.join(projectRoot, "src/lib/client-config.ts");
  fs.writeFileSync(configPath, configContent, "utf-8");
  filesWritten.push("src/lib/client-config.ts");

  for (const page of spec.pages) {
    const relPath = slugToFilePath(page.slug);
    const fullPath = path.join(projectRoot, relPath);

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const pageContent = generatePage(page);
    fs.writeFileSync(fullPath, pageContent, "utf-8");
    filesWritten.push(relPath);

    for (const section of page.sections) {
      sectionsUsed.add(section.type);
    }
  }

  for (const [relative, content] of cmsFiles) {
    const target = safeTarget(projectRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    filesWritten.push(relative);
  }
  if (cmsFiles.size || Object.keys(previousCms).length) {
    const manifest = safeTarget(projectRoot, managedManifest);
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify(Object.fromEntries([...cmsFiles].map(([relative, content]) => [relative, digest(content)])), null, 2) + "\n");
  }

  return {
    filesWritten,
    pagesGenerated: spec.pages.length + (prepared?.pages.length ?? 0),
    sectionsUsed: Array.from(sectionsUsed),
    ...(prepared ? { cmsPages: prepared.pages } : {}),
  };
}

// CLI entry point: npx tsx src/lib/assembly/assemble.ts <spec.json>
if (process.argv[1]?.replace(/\\/g, "/").includes("assembly/assemble")) {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error("Usage: npx tsx src/lib/assembly/assemble.ts <spec.json>");
    process.exit(1);
  }

  assembleFromSpec(specPath, process.cwd())
    .then((result) => {
      console.log("\nAssembly complete");
      console.log(`  Pages generated: ${result.pagesGenerated}`);
      console.log(`  Sections used: ${result.sectionsUsed.join(", ")}`);
      console.log(`  Files written:`);
      for (const f of result.filesWritten) {
        console.log(`    ${f}`);
      }
    })
    .catch((err: unknown) => {
      console.error("Assembly failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
