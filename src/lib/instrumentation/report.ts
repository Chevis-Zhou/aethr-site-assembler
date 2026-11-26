import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Phase 6's single read surface. Three numbers the business has never recorded
 * (`Business/tasteled/MAP.md` §"Measure actual gate time, and the add-on attach rate"):
 *
 * 1. REVIEW / APPROVE gate hours, from `state.md`'s `*-entered`/`*-exited` timestamps.
 * 2. Add-on attach rate, from `state.md`'s `addon-cents`.
 * 3. REVIEW rejection rate — NOT a field. `analysis/run.ts` already rules that two run
 *    folders under one client IS the rejection record, so this counts folders directly.
 *
 * An instrument, not a dashboard: one flat report, no aggregation across clients beyond
 * a mean and a rate.
 *
 *   npx tsx src/lib/instrumentation/report.ts [--vault-root <path>]
 */

interface ClientFrontmatter {
  slug: string;
  fields: Record<string, string>;
  analysisRunCount: number;
}

function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*"?(.*?)"?\s*$/);
    if (kv) fields[kv[1]] = kv[2];
  }
  return fields;
}

function loadClients(clientsDir: string): ClientFrontmatter[] {
  const out: ClientFrontmatter[] = [];
  for (const slug of fs.readdirSync(clientsDir)) {
    if (slug.startsWith("_")) continue;
    const dir = path.join(clientsDir, slug);
    const stateFile = path.join(dir, "state.md");
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(stateFile)) continue;
    const fields = parseFrontmatter(fs.readFileSync(stateFile, "utf-8"));
    const analysisDir = path.join(dir, "analysis");
    const analysisRunCount = fs.existsSync(analysisDir)
      ? fs.readdirSync(analysisDir).filter((d) => fs.statSync(path.join(analysisDir, d)).isDirectory()).length
      : 0;
    out.push({ slug, fields, analysisRunCount });
  }
  return out;
}

function gateHours(entered: string, exited: string): number | null {
  if (!entered || !exited) return null;
  const start = Date.parse(entered);
  const end = Date.parse(exited);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return (end - start) / 3_600_000;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function buildReport(clientsDir: string): string {
  const clients = loadClients(clientsDir);

  const reviewHours = clients
    .map((c) => gateHours(c.fields["review-entered"], c.fields["review-exited"]))
    .filter((h): h is number => h !== null);
  const approveHours = clients
    .map((c) => gateHours(c.fields["approve-entered"], c.fields["approve-exited"]))
    .filter((h): h is number => h !== null);

  const withAddonData = clients.filter((c) => c.fields["addon-cents"] !== undefined && c.fields["addon-cents"] !== "");
  const attached = withAddonData.filter((c) => Number(c.fields["addon-cents"]) > 0);

  const withAnalysis = clients.filter((c) => c.analysisRunCount > 0);
  const rejected = withAnalysis.filter((c) => c.analysisRunCount > 1);

  const fmt = (n: number | null) => (n === null ? "no data" : n.toFixed(1));
  const rate = (num: number, den: number) => (den === 0 ? "no data" : `${num}/${den} (${((num / den) * 100).toFixed(0)}%)`);

  return [
    "Phase 6 instrument — gate time, add-on attach, REVIEW rejection",
    "",
    `REVIEW gate hours (mean, n=${reviewHours.length}):  ${fmt(mean(reviewHours))}`,
    `APPROVE gate hours (mean, n=${approveHours.length}): ${fmt(mean(approveHours))}`,
    `Add-on attach rate: ${rate(attached.length, withAddonData.length)}`,
    `REVIEW rejection rate: ${rate(rejected.length, withAnalysis.length)}`,
  ].join("\n");
}

if (require.main === module) {
  const vaultRootIdx = process.argv.indexOf("--vault-root");
  const vaultRoot = vaultRootIdx !== -1 ? process.argv[vaultRootIdx + 1] : "/Volumes/Main/Developer";
  const clientsDir = path.join(vaultRoot, "Business/clients");
  console.log(buildReport(clientsDir));
}
