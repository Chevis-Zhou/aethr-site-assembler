import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod/v4";

import { hashArtifact, unpackArtifact } from "../src/lib/deploy/artifact-pack";
import { currentDeployment, listWorkerDomains } from "../src/lib/deploy/cloudflare-api";
import { assertRoutesAttached } from "../src/lib/deploy/deploy";
import { uploadAndSwitchVersion } from "../src/lib/deploy/fenced-version";
import {
  generateWranglerConfig,
  hostnamesToPreserve,
  previewHostname,
  routesFor,
  validateSlug,
  workerName,
} from "../src/lib/deploy/wrangler-config";

/**
 * The deploy coordinator's switch — the only step anywhere that makes a fenced client build live
 * (ADR-0009 A3 in the portal).
 *
 * Runs inside the portal repo's `site-deploy.yml`, which holds the Cloudflare token, has already
 * called `begin` (granting this run the destination's current fence for the newest accepted,
 * built generation) and has checked this repo out at the exact commit the artifact was built
 * at. Generic and secret-free, so it lives in the public template beside the code it deploys.
 *
 *   verify checkout = pinned commit → download artifact (fence-checked) → verify hash
 *     → unpack into an empty out/ → compare Cloudflare's live deployment with the recorded one
 *     → verify existing routes → write wrangler.jsonc → re-check fence → upload version
 *     → re-check fence → deploy that exact version at 100% traffic
 *     → assert routes → commit (fence-conditional)
 *
 * What is and is not fenced, stated plainly: Cloudflare has no deploy precondition, so the upload
 * and traffic switch are not conditional. Exclusivity comes from (1) this being the only holder of the token,
 * (2) the workflow's per-site concurrency group, which serializes switches, and (3) the fence,
 * re-checked right before the traffic switch and enforced on commit, so a run that lost its fence can
 * never record its deployment and the next switch notices drift. Deterministic refusals call
 * `abort`; a transient failure exits without one, leaving the job re-dispatchable.
 */

const PROJECT_ROOT = path.resolve(__dirname, "..");
const COMPATIBILITY_DATE = "2026-09-02";

const beginSchema = z.object({
  status: z.literal("granted"),
  jobId: z.string(),
  fence: z.number().int(),
  generation: z.number().int(),
  slug: z.string(),
  stage: z.enum(["staging", "production"]),
  artifactHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  recordedDeployment: z.string().nullable(),
  contactEmail: z.string(),
  domain: z.string().optional(),
});
type Begin = z.infer<typeof beginSchema>;

class Refused extends Error {}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const portalBase = flag("portal-base") ?? process.env.PORTAL_BASE ?? "https://portal.aethrdesign.com";
const secret = process.env.DEPLOY_COORDINATOR_SECRET;
const acceptDrift = process.env.ACCEPT_DRIFT === "true";
const dryRun = process.argv.includes("--dry-run");

async function portal(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${portalBase}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

async function call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await portal("/api/deploy/switch", { method: "POST", body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Refused(`Portal refused ${body.action}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function abort(begin: Begin, error: string, liveDeploymentId?: string): Promise<void> {
  const res = await portal("/api/deploy/switch", {
    method: "POST",
    body: JSON.stringify({
      action: "abort",
      jobId: begin.jobId,
      fence: begin.fence,
      error,
      liveDeployment: liveDeploymentId
        ? { deploymentId: liveDeploymentId, generation: begin.generation, artifactHash: begin.artifactHash }
        : undefined,
    }),
  });
  console.error(`  abort recorded: ${res.status} ${await res.text()}`);
}

async function main(): Promise<void> {
  if (!secret) throw new Error("DEPLOY_COORDINATOR_SECRET is not set");
  const file = flag("begin");
  if (!file) throw new Error("Missing --begin <file> (the portal's begin response)");
  const begin = beginSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const problem = validateSlug(begin.slug);
  if (problem) throw new Error(`Invalid slug "${problem.slug}": it ${problem.reason}.`);
  console.log(`SWITCH ${begin.slug} (${begin.stage}) — job ${begin.jobId}, generation ${begin.generation}, fence ${begin.fence}`);

  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT }).toString().trim();
    if (head !== begin.commit) throw new Refused(`Checkout is ${head}, artifact was built at ${begin.commit}`);

    const res = await portal(`/api/deploy/artifact?job=${encodeURIComponent(begin.jobId)}&fence=${begin.fence}`);
    if (!res.ok) throw new Refused(`Artifact download refused: ${res.status} ${await res.text()}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (hashArtifact(bytes) !== begin.artifactHash) throw new Refused("Artifact bytes do not match the recorded hash");

    const out = path.join(PROJECT_ROOT, "out");
    fs.rmSync(out, { recursive: true, force: true });
    console.log(`  unpacked ${unpackArtifact(bytes, out)} files`);

    const worker = workerName(begin.slug);
    const live = await currentDeployment(worker, dryRun);
    if (begin.recordedDeployment && live !== begin.recordedDeployment && !acceptDrift) {
      throw new Refused(
        `Cloudflare is serving deployment ${live ?? "(none)"}, but the portal last made ${begin.recordedDeployment} live. ` +
          "Something deployed outside the coordinator. Check it, then re-run this workflow with accept_drift.",
      );
    }

    const extraHostnames =
      begin.stage === "staging"
        ? hostnamesToPreserve(begin.slug, (await listWorkerDomains(worker, dryRun)).map((d) => d.hostname))
        : [];
    const target = {
      slug: begin.slug,
      stage: begin.stage,
      domain: begin.domain,
      contactEmail: begin.contactEmail,
      compatibilityDate: COMPATIBILITY_DATE,
      extraHostnames,
    } as const;
    // This path updates an existing Worker only; route attachment belongs to initial provisioning.
    await assertRoutesAttached(begin.slug, routesFor(target), dryRun);
    fs.writeFileSync(path.join(PROJECT_ROOT, "wrangler.jsonc"), generateWranglerConfig(target), "utf-8");

    await call({ action: "check", jobId: begin.jobId, fence: begin.fence });
    if (dryRun) {
      console.log("  [dry-run] would upload a version, re-check the fence, and deploy that exact version at 100%");
      return;
    }
    await uploadAndSwitchVersion({
      worker,
      message: `Fenced publish ${begin.jobId} generation ${begin.generation}`,
      checkFence: async () => { await call({ action: "check", jobId: begin.jobId, fence: begin.fence }); },
      run: (args, capture) => {
        const stdout = execFileSync("npx", ["wrangler", ...args], {
          cwd: PROJECT_ROOT,
          stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
          maxBuffer: 16_000_000,
        });
        const text = stdout?.toString() ?? "";
        if (capture) process.stdout.write(text);
        return text;
      },
    });

    const deployed = await currentDeployment(worker, false);
    if (!deployed || deployed === live) throw new Error("wrangler exited 0 but Cloudflare shows no new deployment");

    try {
      await assertRoutesAttached(begin.slug, routesFor(target), false);
    } catch (err) {
      await abort(begin, err instanceof Error ? err.message : String(err), deployed);
      throw err;
    }

    const url =
      begin.stage === "production" && begin.domain ? `https://${begin.domain}` : `https://${previewHostname(begin.slug)}`;
    await call({
      action: "commit",
      jobId: begin.jobId,
      fence: begin.fence,
      generation: begin.generation,
      artifactHash: begin.artifactHash,
      deploymentId: deployed,
      url,
    });
    console.log(`  live → ${url} (deployment ${deployed})`);
  } catch (err) {
    if (err instanceof Refused) await abort(begin, err.message);
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error("deploy-artifact failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
