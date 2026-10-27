import { stripVTControlCharacters } from "node:util";

/** Wrangler 4.128 versions upload prints this marker after uploading the immutable version. */
export function uploadedVersionId(stdout: string): string {
  const markers = stripVTControlCharacters(stdout).split(/\r?\n/).filter((line) => line.includes("Worker Version ID:"));
  const match = markers.length === 1
    ? /^\s*Worker Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i.exec(markers[0])
    : null;
  if (!match) throw new Error("Wrangler upload did not identify exactly one Worker version; traffic was not switched");
  return match[1].toLowerCase();
}

/** Upload alone does not change traffic. A revoked fence leaves only an unused version. */
export async function uploadAndSwitchVersion(input: {
  worker: string;
  message: string;
  checkFence: () => Promise<void>;
  run: (args: string[], capture: boolean) => string;
}): Promise<string> {
  const stdout = input.run(["versions", "upload", "--name", input.worker, "--message", input.message], true);
  const version = uploadedVersionId(stdout);
  await input.checkFence();
  input.run(["versions", "deploy", `${version}@100%`, "--name", input.worker, "--yes"], false);
  return version;
}
