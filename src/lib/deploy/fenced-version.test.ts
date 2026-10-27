import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadedVersionId, uploadAndSwitchVersion } from "./fenced-version";

const version = "7a855196-5840-4b22-8d3d-02f49d4af7ef";
const output = `Uploaded site-synthetic (1.2 sec)\nWorker Version ID: ${version}\nPreview URL: https://example.workers.dev\n`;

test("upload marker accepts only one exact version, including colored Wrangler output", () => {
  assert.equal(uploadedVersionId(output), version);
  assert.equal(uploadedVersionId(`\u001b[32mWorker Version ID: ${version.toUpperCase()}\u001b[0m\n`), version);
  for (const invalid of ["", `Current Version ID: ${version}`, `Worker Version ID: latest`, `${output}${output}`, `Worker Version ID: ${version} trailing`, `Worker Version ID: ${version}\nWorker Version ID: missing`]) {
    assert.throws(() => uploadedVersionId(invalid), /exactly one/);
  }
});

test("upload finishes before the fence check; only its exact version receives 100% traffic", async () => {
  const events: unknown[] = [];
  const selected = await uploadAndSwitchVersion({worker:"site-synthetic",message:"Synthetic fenced publish",checkFence:async()=>{events.push("check");},run(args,capture){events.push({args,capture});return output;}});
  assert.equal(selected,version);
  assert.deepEqual(events,[
    {args:["versions","upload","--name","site-synthetic","--message","Synthetic fenced publish"],capture:true},
    "check",
    {args:["versions","deploy",`${version}@100%`,"--name","site-synthetic","--yes"],capture:false},
  ]);
});

test("revoked fence after upload never switches traffic", async () => {
  const commands: string[][] = [];
  await assert.rejects(uploadAndSwitchVersion({worker:"site-synthetic",message:"Synthetic",checkFence:async()=>{throw new Error("Fence revoked");},run(args){commands.push(args);return output;}}),/Fence revoked/);
  assert.equal(commands.length,1);assert.equal(commands[0][1],"upload");
});

test("upload failure or ambiguous receipt never reaches the fence or deploy", async () => {
  for (const failure of ["upload failed","ambiguous"]) {
    const events: string[]=[];
    await assert.rejects(uploadAndSwitchVersion({worker:"site-synthetic",message:"Synthetic",checkFence:async()=>{events.push("check");},run(args){events.push(args[1]);if(failure==="upload failed")throw new Error(failure);return `${output}${output}`;}}));
    assert.deepEqual(events,["upload"]);
  }
});
