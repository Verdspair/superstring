import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCaseSlot } from "./case-rename.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const reports = path.join(root, "artifacts/desktop");
fs.mkdirSync(reports, { recursive: true });
const base = fs.mkdtempSync(path.join(reports, "case-slot-test-"));
const lines = [];
let total = 0;
function check(name, fn) {
  fn(); // A failing assertion must throw and produce a non-zero exit.
  total++;
  lines.push(`PASS ${name}`);
}
function scenario(name) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir);
  return dir;
}
const finalBase = "superstring.exe";
for (const spelling of ["Superstring.exe", "superstring.exe"]) {
  const dir = scenario(spelling === finalBase ? "lowercase" : "oldcase");
  const target = path.join(dir, finalBase);
  fs.writeFileSync(path.join(dir, spelling), "PRIOR");
  let slot = prepareCaseSlot(dir, finalBase);
  check(`${spelling}: protected before compiler`, () => {
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(slot.backup, "utf8"), "PRIOR");
  });
  fs.writeFileSync(target, "PARTIAL");
  slot.restore();
  check(`${spelling}: partial failure restores bytes and spelling`, () => {
    assert.deepEqual(fs.readdirSync(dir), [spelling]);
    assert.equal(fs.readFileSync(path.join(dir, spelling), "utf8"), "PRIOR");
  });
  for (let i = 0; i < 2; i++) {
    slot = prepareCaseSlot(dir, finalBase);
    fs.writeFileSync(target, `NEW${i}`);
    slot.commit();
    check(`${spelling}: successful rebuild ${i + 1}`, () => {
      assert.deepEqual(fs.readdirSync(dir), [finalBase]);
      assert.equal(fs.readFileSync(target, "utf8"), `NEW${i}`);
    });
  }
}
const empty = scenario("empty");
let slot = prepareCaseSlot(empty, finalBase);
check("missing output rejected", () => assert.throws(() => slot.commit(), /missing or empty/));
slot.restore();
slot = prepareCaseSlot(empty, finalBase);
fs.writeFileSync(path.join(empty, finalBase), "");
check("empty output rejected", () => assert.throws(() => slot.commit(), /missing or empty/));
slot.restore();
check("partial first build removed", () => assert.deepEqual(fs.readdirSync(empty), []));
const recovery = scenario("recovery");
fs.writeFileSync(path.join(recovery, "superstring.old-build.tmp.exe"), "KEEP");
fs.writeFileSync(path.join(recovery, finalBase), "OLD");
slot = prepareCaseSlot(recovery, finalBase);
fs.writeFileSync(path.join(recovery, finalBase), "NEW");
slot.commit();
check("pre-existing recovery file never discarded", () =>
  assert.equal(
    fs.readFileSync(path.join(recovery, "superstring.old-build.tmp.exe"), "utf8"),
    "KEEP",
  ),
);
check("unsafe basename rejected", () =>
  assert.throws(() => prepareCaseSlot(recovery, "../other.exe")),
);
const bad = scenario("directory-slot");
fs.mkdirSync(path.join(bad, finalBase));
check("non-file slot rejected", () =>
  assert.throws(() => prepareCaseSlot(bad, finalBase), /regular file/),
);
lines.push(`${total} assertions passed; fixtures retained at ${base}`);
fs.writeFileSync(path.join(reports, "case-rename-report.txt"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
