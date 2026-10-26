import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod/v4";

import { assembleFromSpec } from "../src/lib/assembly/assemble";
import { siteSpecSchema, type SiteSpec } from "../src/lib/assembly/site-spec";
import { optimizeImages } from "../src/lib/qa/image-pipeline/optimize-images";
import { runFastGate } from "../src/lib/qa/fast-gate";
import {
  generateWranglerConfig,
  hostnamesToPreserve,
  previewHostname,
  routesFor,
  validateSlug,
  workerName,
} from "../src/lib/deploy/wrangler-config";
import { listWorkerDomains } from "../src/lib/deploy/cloudflare-api";
import { assertRoutesAttached } from "../src/lib/deploy/deploy";
import { packArtifact } from "../src/lib/deploy/artifact-pack";
import type { CheckFinding } from "../src/lib/qa/types";
import { writeHeadersFile } from "../src/lib/deploy/security-headers";
import { cmsBuildEnvironment, deriveCmsBuildAssets, fetchCmsBuildAssets, isolatedCmsBuild, prepareCmsPublish, verifyCmsAssetBytes, writeCmsAssetManifest, type PreparedCmsPublish } from "./lib/cms-publish";

/**
 * The shared cloud builder — ticket 012 §3, the publish path behind the client's one
 * Publish button.
 *
 * ONE repo builds every client. The source of a client site *is* this template plus a
 * spec, so there is nothing durable to keep in forty repos and 010 §4's "no per-client
 * repo" ruling is untouched by this existing.
 *
 * Sequence, and the order is the ruling:
 *
 *   fetch spec → assemble → fetch client images → optimize → next build
 *     → FAST GATE (pre-upload, no opt-out) → wrangler deploy → report
 *
 * With `--job-id` (a *fenced* destination, ADR-0009 A3 in the portal) the run stops after the
 * gate: it packs `out/` into a deterministic artifact, uploads it to the portal under its hash
 * and exits. It never touches Cloudflare and needs no Cloudflare credential; the portal's deploy
 * coordinator is the only thing that can make that artifact live, and only if it is still the
 * newest accepted publish. The claim is a lease: a cancelled or superseded run cannot report.
 *
 * The gate sits before the upload because §4's whole point is that a client edit which
 * breaks the site never reaches a hostname. On a failure this exits non-zero having
 * uploaded nothing, and the report it posts back is what the editor renders inline — §4.3
 * blocks in the editor rather than parking the client, because the person who caused the
 * failure is sitting in it.
 *
 * Runs on a fresh CI checkout, so it neither resets stale generated pages nor restores the
 * files `assembleFromSpec` overwrites (`src/app/page.tsx`, `src/lib/client-config.ts`) the
 * way `qa/run.ts` does — there is nothing to restore on a runner. Running it locally WILL
 * leave the client's site sitting in the working tree; `git checkout --` those two paths.
 *
 * Runs on a Linux runner, which is also what makes client image uploads possible at all:
 * §7's manifest coverage is blocking and ImageOptim is a macOS GUI app, but the binaries
 * it wraps are native here (see `optimize-images.ts`).
 */

const PROJECT_ROOT = path.resolve(__dirname, "..");

const buildPayload = z.object({
  spec: z.unknown(),
  /** Version being published, echoed back on the report so a supersede is detectable. */
  version: z.number(),
  contactEmail: z.string(),
  /** Present for a production publish; absent for staging. */
  domain: z.string().optional(),
  /** Fenced claims only: the lease this run holds. */
  attempt: z.number().int().optional(),
  jobId: z.string().optional(),
  slug: z.string().optional(),
  stage: z.enum(["staging","production"]).optional(),
  vector: z.unknown().optional(),
  cms: z.unknown().optional(),
  /** Client uploads living in R2, fetched into `public/` before the build. */
  assets: z
    .array(z.object({ path: z.string(), url: z.string() }))
    .optional()
    .default([]),
});

type BuildPayload = z.infer<typeof buildPayload> & { spec: SiteSpec };

interface Args {
  slug: string;
  stage: "staging" | "production";
  publishId: string;
  portalBase: string;
  buildSecret: string;
  dryRun: boolean;
  /** A fenced deploy job. Present → build and upload an artifact only. */
  jobId?: string;
  /** Lease owner for a fenced claim: the Actions run, or this machine and process. */
  runner: string;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }

  const need = (name: string, envName: string): string => {
    const value = (flags[name] as string) || process.env[envName];
    if (!value) throw new Error(`Missing --${name} (or ${envName})`);
    return value;
  };

  const stage = (flags.stage as string) ?? "staging";
  if (stage !== "staging" && stage !== "production") {
    throw new Error(`--stage must be "staging" or "production", got "${stage}"`);
  }

  const jobId = (flags["job-id"] as string) || process.env.PUBLISH_JOB_ID || undefined;
  return {
    slug: need("slug", "PUBLISH_SLUG"),
    stage,
    publishId: jobId ? (flags["publish-id"] as string) || process.env.PUBLISH_ID || "" : need("publish-id", "PUBLISH_ID"),
    portalBase: (flags["portal-base"] as string) ?? process.env.PORTAL_BASE ?? "https://portal.aethrdesign.com",
    buildSecret: need("build-secret", "PORTAL_BUILD_SECRET"),
    dryRun: flags["dry-run"] === true,
    jobId,
    runner: process.env.GITHUB_RUN_ID
      ? `gha-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
      : `local-${os.hostname()}-${process.pid}`,
  };
}

async function fetchPayload(args: Args): Promise<BuildPayload> {
  const url = args.jobId
    ? `${args.portalBase}/api/deploy/build?job=${encodeURIComponent(args.jobId)}&runner=${encodeURIComponent(args.runner)}`
    : `${args.portalBase}/api/edit/build?slug=${encodeURIComponent(args.slug)}&publishId=${encodeURIComponent(args.publishId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${args.buildSecret}` } });
  if (!res.ok) {
    throw new Error(`Portal returned ${res.status} fetching the build payload: ${await res.text()}`);
  }
  const payload = buildPayload.parse(await res.json());
  if (payload.cms && (!args.jobId || payload.jobId !== args.jobId || payload.slug !== args.slug || payload.stage !== args.stage))
    throw new Error("CMS payload does not match this fenced build job");
  const spec = z.safeParse(siteSpecSchema, payload.spec);
  if (!spec.success) {
    // The portal validates on every write, so this is a corrupt row rather than a bad
    // edit — worth failing loudly instead of building something shaped wrong.
    throw new Error(`Portal sent a spec that does not validate:\n${z.prettifyError(spec.error)}`);
  }
  return { ...payload, spec: spec.data };
}

/** Client uploads land in `public/` under the same relative path the spec references. */
async function fetchAssets(assets: { path: string; url: string }[],args:Args,projectRoot = PROJECT_ROOT): Promise<void> {
  for (const asset of assets) {
    const target = path.resolve(projectRoot, "public", asset.path.replace(/^\/+/, ""));
    if (!target.startsWith(path.join(projectRoot, "public") + path.sep)) {
      throw new Error(`Asset path escapes public/: ${asset.path}`);
    }
    const url = new URL(asset.url),portal = new URL(args.portalBase);
    if (url.origin !== portal.origin || url.username || url.password || url.pathname !== "/api/edit/asset" || url.searchParams.get("slug") !== args.slug)
      throw new Error("Site asset address does not belong to this Portal build");
    const res = await fetch(url,{headers:{Authorization:`Bearer ${args.buildSecret}`},redirect:"error"});
    if (!res.ok) throw new Error(`Could not fetch asset ${asset.path}: ${res.status}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    console.log(`  asset ${asset.path}`);
  }
}

/**
 * The commit whose Worker source the coordinator will deploy alongside this artifact. A dirty
 * checkout has no such commit, so a live fenced run refuses one.
 */
function sourceCommit(args: Args): string {
  const commit = process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT }).toString().trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "src/worker.ts", "package.json", "pnpm-lock.yaml"], { cwd: PROJECT_ROOT }).toString().trim();
  if (dirty && !args.dryRun && !process.env.GITHUB_SHA) {
    throw new Error(`Worker inputs are uncommitted, so no commit describes this build:\n${dirty}`);
  }
  return commit;
}

/** Fenced: hand the gated build to the portal. Nothing here can make it live. */
async function uploadArtifact(args: Args, attempt: number,projectRoot = PROJECT_ROOT,pinnedCommit?:string): Promise<void> {
  const artifact = packArtifact(path.join(projectRoot, "out"));
  const commit = pinnedCommit ?? sourceCommit(args);
  console.log(`  artifact ${artifact.hash} (${artifact.files} files, ${artifact.bytes.length} bytes) at ${commit}`);
  if (args.dryRun) {
    console.log("  [dry-run] would upload the artifact to /api/deploy/artifact");
    return;
  }
  const params = new URLSearchParams({ job: args.jobId!, runner: args.runner, attempt: String(attempt), commit });
  const res = await fetch(`${args.portalBase}/api/deploy/artifact?${params}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${args.buildSecret}`,
      "Content-Type": "application/gzip",
      "x-artifact-sha256": artifact.hash,
    },
    body: new Uint8Array(artifact.bytes),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Portal refused the artifact: ${res.status} ${body}`);
  console.log(`  artifact accepted — the deploy coordinator makes it live: ${body}`);
}

async function report(
  args: Args,
  body: {
    status: "published" | "failed";
    version: number;
    attempt?: number;
    url?: string;
    findings?: CheckFinding[];
    error?: string;
  },
): Promise<void> {
  if (args.jobId) {
    if (body.status !== "failed") return;
    const res = await fetch(`${args.portalBase}/api/deploy/build`, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.buildSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: args.jobId, runner: args.runner, attempt: body.attempt, error: body.error, findings: body.findings }),
    });
    if (!res.ok) console.error(`Reporting back to the portal failed: ${res.status} ${await res.text()}`);
    return;
  }
  const res = await fetch(`${args.portalBase}/api/edit/build`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.buildSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ slug: args.slug, publishId: args.publishId, ...body }),
  });
  if (!res.ok) {
    // A failed report leaves the editor showing "Publishing…" forever, so it is loud.
    console.error(`Reporting back to the portal failed: ${res.status} ${await res.text()}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const problem = validateSlug(args.slug);
  if (problem) throw new Error(`Invalid slug "${problem.slug}": it ${problem.reason}.`);

  console.log(`PUBLISH ${args.slug} (${args.stage}) — publish ${args.publishId}${args.jobId ? ` — fenced job ${args.jobId} as ${args.runner}` : ""}`);
  const payload = await fetchPayload(args);
  if (args.jobId && payload.attempt === undefined) throw new Error("Portal did not grant a build lease");
  let projectRoot = PROJECT_ROOT;
  let cms:PreparedCmsPublish | undefined;
  try {
    if (payload.cms) {
      cms = await prepareCmsPublish(payload.cms,payload.spec,PROJECT_ROOT,payload.vector);
      const vector = payload.vector as {site?:{version?:unknown}};
      if (vector.site?.version !== payload.version) throw new Error("Frozen Site version does not match this CMS build");
      projectRoot = isolatedCmsBuild(cms);
    }
    const specPath = path.join(projectRoot, "spec.json");
    fs.writeFileSync(specPath, JSON.stringify(payload.spec, null, 2) + "\n", "utf-8");

    if (payload.assets.length > 0) {
      console.log(`  fetching ${payload.assets.length} client asset(s)…`);
      await fetchAssets(payload.assets,args,projectRoot);
    }
    if (cms) await fetchCmsBuildAssets(projectRoot,cms.assets,{jobId:args.jobId!,runner:args.runner,attempt:payload.attempt!,portalBase:args.portalBase,buildSecret:args.buildSecret});
    const derived = cms ? await deriveCmsBuildAssets(projectRoot,cms) : undefined;

    console.log("  assembling…");
    const assembled = await assembleFromSpec(specPath, projectRoot,cms ? {cms:cms.input} : {});

    console.log("  optimizing images…");
    const optimized = await optimizeImages(projectRoot, path.join(projectRoot, "public"));
    if (derived) verifyCmsAssetBytes(projectRoot,derived.assets);
    console.log(
      `  ${optimized.processed} processed, ${optimized.skipped} already optimized, manifest ${optimized.manifestEntries}`,
    );

    console.log("  building…");
    // `npx next build`, not `pnpm build`: pnpm re-checks the lockfile before running a
    // script and fails the whole publish over an unrelated ignored build script. This is
    // also the exact command `deploy/deploy.ts` runs on the Mac, which is the point —
    // §3's first reason for one shared builder is that the two paths cannot diverge.
    execFileSync("npx", ["next", "build"], { cwd: projectRoot, stdio: "inherit",...(cms ? {env:cmsBuildEnvironment(cms.buildEnv)} : {}) });
    if (derived) writeCmsAssetManifest(path.join(projectRoot,"out"),derived.manifest);
    writeHeadersFile(path.join(projectRoot,"out"), cms ? {previewFrames:[{route:"/cms-preview",editorOrigin:cms.input.editorOrigin}]} : {});

    console.log("  fast gate…");
    const gate = await runFastGate({ spec: payload.spec, projectRoot,cmsPages:assembled.cmsPages });
    if (!gate.passed) {
      console.error(`  GATE FAILED — ${gate.findings.length} blocker(s). Nothing uploaded.`);
      for (const finding of gate.findings) console.error(`    ${finding.check}: ${finding.message}`);
      await report(args, { status: "failed", version: payload.version, attempt: payload.attempt, findings: gate.findings });
      process.exitCode = 1;
      return;
    }
    console.log("  gate passed.");

    if (args.jobId) {
      await uploadArtifact(args, payload.attempt!,projectRoot,cms?.sourceCommit);
      return;
    }

    const extraHostnames =
      args.stage === "staging"
        ? hostnamesToPreserve(
            args.slug,
            (await listWorkerDomains(workerName(args.slug), args.dryRun)).map((d) => d.hostname),
          )
        : [];
    if (extraHostnames.length) {
      console.log(
        `  carrying forward ${extraHostnames.length} production route(s): ${extraHostnames.join(", ")}`,
      );
    }

    const target = {
      slug: args.slug,
      stage: args.stage,
      domain: payload.domain,
      contactEmail: payload.contactEmail,
      compatibilityDate: "2026-09-02",
      extraHostnames,
    } as const;
    fs.writeFileSync(path.join(PROJECT_ROOT, "wrangler.jsonc"), generateWranglerConfig(target), "utf-8");

    if (args.dryRun) {
      console.log("  [dry-run] would run: npx wrangler deploy");
    } else {
      execFileSync("npx", ["wrangler", "deploy"], { cwd: PROJECT_ROOT, stdio: "inherit" });
    }
    await assertRoutesAttached(args.slug, routesFor(target), args.dryRun);

    const url =
      args.stage === "production" && payload.domain
        ? `https://${payload.domain}`
        : `https://${previewHostname(args.slug)}`;
    console.log(`  published → ${url}`);
    await report(args, { status: "published", version: payload.version, url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await report(args, { status: "failed", version: payload.version, attempt: payload.attempt, error: message });
    throw err;
  } finally {
    if (projectRoot !== PROJECT_ROOT) fs.rmSync(projectRoot,{recursive:true,force:true});
  }
}

main().catch((err: unknown) => {
  console.error("publish-client failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
