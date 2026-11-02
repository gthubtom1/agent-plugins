import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root,"plugins/pi/seep-workbench");
const source = JSON.parse(readFileSync(join(bundle,"SOURCE.json"),"utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const index = process.argv.indexOf("--seep-root");
const seep = index >= 0 ? resolve(process.argv[index+1]) : null;
for (const file of source.files) {
  assert.equal(hash(readFileSync(join(bundle,file.path))),file.sha256,file.path);
  if (seep) assert.equal(hash(readFileSync(join(seep,file.source))),file.sha256,file.source);
}
for (const rel of ["agent-dir.ts","inject.ts","personas.ts","pi-api.ts","session-state.ts"]) {
  assert.equal(hash(readFileSync(join(root,"plugins/pi/pi-prompt-compat/lib",rel))),
    hash(readFileSync(join(root,"plugins/pi/pi-seep-ext/lib",rel))), `shared helper ${rel}`);
}
console.log(`PASS: ${source.files.length} Seep source files; 5 shared helpers; ${seep ? "source checkout compared" : "recorded source hashes checked"}`);
