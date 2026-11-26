import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  generateWranglerConfig,
  hostnamesToPreserve,
  missingHostnames,
  previewHostname,
  routesFor,
  validateSlug,
  workerName,
  type DeployStage,
  type DeployTarget,
} from "./wrangler-config";
import { writeHeadersFile } from "./security-headers";
import {
  computeManifest,
  diffManifest,
  formatDrift,
  type ArtifactManifest,
} from "./artifact";
import { listWorkerDomains } from "./cloudflare-api";

/**
 * STAGING and DEPLOY.
 *
 * Both run on the Mac, at the end of the local build. MAP ruling 4 says *"deploy and any
 * monitoring run in the cloud"*, and this is not a violation of it: the ruling constrains
 * where the hosted **artifact** lives — a sleeping Mac cannot hold a staging SLA, and
 * Cloudflare holds it — never where `wrangler` runs. Uploading is a client of the Workers
 * API and does not need to outlive the session that ran it. Owner confirmed 2026-09-03.
 *
 * The shape that matters:
 *
 *   STAGING  build → record manifest → read attached domains → write config
 *            (preview + any production routes already attached) → wrangler deploy → verify
 *   DEPLOY   verify manifest unchanged → write config (+ apex, +www) → wrangler deploy → verify attach
 *
 * DEPLOY never rebuilds. It re-uploads the byte-identical `out/` the client approved and
 * adds two Custom Domains to a Worker that is already live. If `out/` has drifted from the
 * approved manifest, it refuses — see `artifact.ts` for why that guard is not paranoia.
 *
 * Spec: `docs/wayfinder-product/assets/deploy-specification.md`.
 */

export const PROJECT_ROOT = path.resolve(__dirname, "../../..");

/**
 * Pinned rather than "today": a compatibility date that moves on every deploy makes the
 * runtime a variable, so a redeploy of an unchanged site could behave differently from the
 * one the client approved. Bump deliberately, never automatically.
 */
const COMPATIBILITY_DATE = "2026-09-02";

/**
 * Post-attach verification: the API list is what detaches, not HTTP. Measured
 * 2026-09-09, the list updated in the same second wrangler exited; HTTP lagged
 * DNS. Five attempts / 2s is slack for Cloudflare lag, then fail loud —
 * wrangler exiting 0 is the lie this exists to catch.
 */
export const ATTACH_VERIFY_ATTEMPTS = 5;
export const ATTACH_VERIFY_INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function attachedHostnames(slug: string, dryRun: boolean): Promise<string[]> {
  const domains = await listWorkerDomains(workerName(slug), dryRun);
  return domains.map((d) => d.hostname).filter(Boolean);
}

export async function assertRoutesAttached(
  slug: string,
  expected: string[],
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(`  [dry-run] would verify attached hostnames: ${expected.join(", ")}`);
    return;
  }

  let attached: string[] = [];
  for (let attempt = 1; attempt <= ATTACH_VERIFY_ATTEMPTS; attempt++) {
    attached = await attachedHostnames(slug, false);
    const missing = missingHostnames(expected, attached);
    if (missing.length === 0) {
      console.log(`  routes verified (${attached.length}): ${attached.join(", ")}`);
      return;
    }
    if (attempt < ATTACH_VERIFY_ATTEMPTS) {
      console.log(
        `  waiting for attach (${attempt}/${ATTACH_VERIFY_ATTEMPTS}): missing ${missing.join(", ")}`,
      );
      await sleep(ATTACH_VERIFY_INTERVAL_MS);
    }
  }

  const missing = missingHostnames(expected, attached);
  throw new Error(
    `wrangler exited 0 but expected hostname(s) are not attached to ${workerName(slug)}:\n` +
      `  missing: ${missing.join(", ")}\n` +
      `  attached: ${attached.length ? attached.join(", ") : "(none)"}\n` +
      `Checked /accounts/{id}/workers/domains ${ATTACH_VERIFY_ATTEMPTS} times over ` +
      `${((ATTACH_VERIFY_ATTEMPTS - 1) * ATTACH_VERIFY_INTERVAL_MS) / 1000}s. ` +
      `The site may be off its own domain even though deploy reported success.`,
  );
}

function manifestPath(slug: string, vaultRoot?: string): string {
  const root = vaultRoot ?? "/Volumes/Main/Developer";
  return path.join(root, "Business/clients", slug, "approved-artifact.json");
}

/**
 * Shared by `zone-setup.ts` and `transform-rule.ts` for the wrangler commands among their
 * steps (`wrangler secret put` has no Cloudflare REST equivalent worth using — it already
 * handles the secret-scoped API call and the stdin convention). `input`, when given, is
 * never echoed — a secret value has no business appearing in a dry-run log either.
 */
function wranglerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  return env;
}

export function run(cmd: string, args: string[], dryRun: boolean, opts: { input?: string } = {}): void {
  const printable = `${cmd} ${args.join(" ")}`;
  if (dryRun) {
    console.log(`  [dry-run] ${printable}${opts.input !== undefined ? "  (stdin: <redacted>)" : ""}`);
    return;
  }
  console.log(`  $ ${printable}`);
  const result = spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    stdio: opts.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
    input: opts.input,
    // wrangler treats CLOUDFLARE_API_TOKEN as its login. The zone-setup token
    // fails Workers Routes list (auth 10000) after a successful asset upload.
    // OAuth in ~/.wrangler is what actually attaches custom domains. Strip both
    // names so a sourced shell cannot override that.
    env: wranglerEnv(process.env),
  });
  if (result.status !== 0) {
    throw new Error(`${printable} exited with ${result.status ?? "signal " + result.signal}`);
  }
}

function writeConfig(target: DeployTarget, dryRun: boolean): string {
  const configPath = path.join(PROJECT_ROOT, "wrangler.jsonc");
  const contents = generateWranglerConfig(target);
  if (dryRun) {
    console.log(`  [dry-run] would write ${configPath}:\n${indent(contents)}`);
  } else {
    fs.writeFileSync(configPath, contents, "utf-8");
    console.log(`  wrote wrangler.jsonc (${routesFor(target).length} custom domains)`);
  }
  return configPath;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

export interface StageOptions {
  slug: string;
  contactEmail: string;
  domain?: string;
  outDir?: string;
  vaultRoot?: string;
  dryRun?: boolean;
  /** Skip `next build` and stage whatever is already in `out/`. */
  skipBuild?: boolean;
}

export async function staging(opts: StageOptions): Promise<ArtifactManifest> {
  const { slug, contactEmail, dryRun = false, vaultRoot } = opts;
  const outDir = opts.outDir ?? path.join(PROJECT_ROOT, "out");

  const problem = validateSlug(slug);
  if (problem) throw new Error(`Invalid slug "${problem.slug}": it ${problem.reason}.`);

  console.log(`STAGING ${slug} → https://${previewHostname(slug)}`);

  if (!opts.skipBuild) {
    run("npx", ["next", "build"], dryRun);
  } else {
    console.log("  skipping build — staging the existing out/");
  }

  // Before the manifest, so the pinned artifact includes the headers DEPLOY will re-upload.
  if (!dryRun) {
    const target = writeHeadersFile(outDir);
    console.log(`  wrote ${path.relative(PROJECT_ROOT, target)}`);
  }

  // Recorded before upload, so what is pinned is what is about to be sent.
  const manifest = computeManifest(outDir, slug);
  console.log(
    `  artifact ${manifest.treeHash.slice(0, 12)} — ${manifest.fileCount} files, ` +
      `${(manifest.totalBytes / 1024 / 1024).toFixed(2)} MB`,
  );

  if (!dryRun) {
    const manifestDir = path.dirname(manifestPath(slug, vaultRoot));
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(manifestPath(slug, vaultRoot), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  }

  const extraHostnames = hostnamesToPreserve(slug, await attachedHostnames(slug, dryRun));
  if (extraHostnames.length) {
    console.log(
      `  carrying forward ${extraHostnames.length} production route(s): ${extraHostnames.join(", ")}`,
    );
  }

  const target: DeployTarget = {
    slug,
    stage: "staging",
    domain: opts.domain,
    contactEmail,
    compatibilityDate: COMPATIBILITY_DATE,
    extraHostnames,
  };
  writeConfig(target, dryRun);
  run("npx", ["wrangler", "deploy"], dryRun);
  await assertRoutesAttached(slug, routesFor(target), dryRun);

  console.log(`  staged. Send the client https://${previewHostname(slug)} for APPROVE.`);
  console.log(`  Paste into state.md: approve-entered: ${new Date().toISOString()}`);
  return manifest;
}

export interface DeployOptions {
  slug: string;
  contactEmail: string;
  /** The client's apex. Required — `production` has nowhere to go without it. */
  domain: string;
  outDir?: string;
  vaultRoot?: string;
  dryRun?: boolean;
  /**
   * Deploy despite artifact drift. Exists because a legitimate case will eventually
   * arrive; it prints what changed and says plainly that the client did not approve it.
   */
  force?: boolean;
}

export async function deploy(opts: DeployOptions): Promise<void> {
  const { slug, contactEmail, domain, dryRun = false, force = false, vaultRoot } = opts;
  const outDir = opts.outDir ?? path.join(PROJECT_ROOT, "out");

  const problem = validateSlug(slug);
  if (problem) throw new Error(`Invalid slug "${problem.slug}": it ${problem.reason}.`);

  console.log(`DEPLOY ${slug} → https://${domain}`);

  const approvedPath = manifestPath(slug, vaultRoot);
  if (!fs.existsSync(approvedPath)) {
    throw new Error(
      `No approved artifact recorded for "${slug}" at ${approvedPath}.\n` +
        `DEPLOY ships what STAGING recorded — run staging first, and have the client approve it.`,
    );
  }

  const approved = JSON.parse(fs.readFileSync(approvedPath, "utf-8")) as ArtifactManifest;
  const current = computeManifest(outDir, slug);
  const drift = diffManifest(approved, current);

  if (!drift.matches) {
    const detail =
      `out/ has drifted from the artifact approved at STAGING ` +
      `(${approved.treeHash.slice(0, 12)} → ${current.treeHash.slice(0, 12)}):\n` +
      formatDrift(drift);
    if (!force) {
      throw new Error(
        `${detail}\n\n` +
          `Refusing to attach ${domain} to bytes the client did not approve. ` +
          `Re-run staging and get a fresh approval, or pass --force if you know why this differs.`,
      );
    }
    console.warn(`  WARNING — proceeding with --force.\n${detail}`);
  } else {
    console.log(`  artifact verified ${current.treeHash.slice(0, 12)} — matches APPROVE.`);
  }

  // Same directory, same bytes; the only change is two more Custom Domains on a Worker
  // that is already live and already approved.
  const target: DeployTarget = {
    slug,
    stage: "production",
    domain,
    contactEmail,
    compatibilityDate: COMPATIBILITY_DATE,
  };
  writeConfig(target, dryRun);
  run("npx", ["wrangler", "deploy"], dryRun);
  await assertRoutesAttached(slug, routesFor(target), dryRun);

  console.log(`  live at https://${domain} (www redirects to apex).`);
  console.log(`  Paste into state.md: approve-exited: ${new Date().toISOString()}`);
  console.log(
    `  Retire https://${previewHostname(slug)} ~30 days from now — it keeps the ` +
      `100-Custom-Domains-per-zone ceiling clear and stops a stale pre-launch copy outliving the real site.`,
  );
}

export function rollback(slug: string, dryRun = false): void {
  console.log(`ROLLBACK ${workerName(slug)} — blast radius is exactly this one client.`);
  run("npx", ["wrangler", "rollback", "--name", workerName(slug)], dryRun);
}

// ---------------------------------------------------------------------------- CLI

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | true> } {
  const [command, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function required(flags: Record<string, string | true>, name: string): string {
  const value = flags[name];
  if (typeof value !== "string") throw new Error(`--${name} is required`);
  return value;
}

const USAGE = `Usage:
  npx tsx src/lib/deploy/deploy.ts staging  --slug <slug> --contact-email <addr> [--vault-root <path>] [--skip-build] [--dry-run]
  npx tsx src/lib/deploy/deploy.ts deploy   --slug <slug> --contact-email <addr> --domain <apex> [--vault-root <path>] [--force] [--dry-run]
  npx tsx src/lib/deploy/deploy.ts rollback --slug <slug> [--dry-run]

STAGING builds, records the artifact manifest and attaches <slug>-preview.aethrdesign.com.
A re-stage of a client past DEPLOY keeps any production Custom Domains already attached.
DEPLOY verifies the artifact still matches what was approved, then attaches the client's
apex and www to the same deployment and re-reads /workers/domains to confirm they stuck.
It does not rebuild.
--vault-root defaults to /Volumes/Main/Developer if omitted.
`;

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const dryRun = flags["dry-run"] === true;

  try {
    switch (command) {
      case "staging":
        await staging({
          slug: required(flags, "slug"),
          contactEmail: required(flags, "contact-email"),
          domain: typeof flags.domain === "string" ? flags.domain : undefined,
          vaultRoot: typeof flags["vault-root"] === "string" ? flags["vault-root"] : undefined,
          skipBuild: flags["skip-build"] === true,
          dryRun,
        });
        break;
      case "deploy":
        await deploy({
          slug: required(flags, "slug"),
          contactEmail: required(flags, "contact-email"),
          domain: required(flags, "domain"),
          vaultRoot: typeof flags["vault-root"] === "string" ? flags["vault-root"] : undefined,
          force: flags.force === true,
          dryRun,
        });
        break;
      case "rollback":
        rollback(required(flags, "slug"), dryRun);
        break;
      default:
        console.log(USAGE);
        process.exit(command ? 1 : 0);
    }
  } catch (err: unknown) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1]?.replace(/\\/g, "/").includes("deploy/deploy")) {
  void main();
}

export type { DeployStage };
