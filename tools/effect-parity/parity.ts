import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { baselineTable, parseBaseline } from "./diagnostics";
import { discoverFixtures, layOutFixture } from "./fixtures";
import { exposeReferencePackages, floatingEffectTable, isExact, type Pass, passTable, runPass } from "./score";

const [upstream, report, baselineReport] = process.argv.slice(2);
if (!upstream || !report || !baselineReport) {
  throw new Error("Usage: bun parity.ts <Effect source checkout> <layout report> <baseline report>");
}

const fixtureDirectory = join(upstream, "testdata/tests/effect-v4");
const names = discoverFixtures(fixtureDirectory);
if (names.length !== 553) {
  throw new Error(`Expected 553 Effect v4 fixtures, found ${names.length}`);
}

const root = mkdtempSync(join(tmpdir(), "effect-parity-"));
const fixtures = names.map((name) => layOutFixture(name, readFileSync(join(fixtureDirectory, name), "utf8"), join(root, name)));
const count = {
  fixtures: fixtures.length,
  multiFile: fixtures.filter((fixture) => fixture.units > 1).length,
  customConfig: fixtures.filter((fixture) => fixture.fixtureConfig).length,
  syntheticPackages: fixtures.filter((fixture) => fixture.syntheticPackages).length,
};
console.log(JSON.stringify(count));
writeFileSync(report, JSON.stringify({ count, fixtures }, null, 2) + "\n");

const baselineDirectory = join(upstream, "testdata/baselines/reference/effect-v4");
const diagnostics = fixtures.flatMap(({ name }) => {
  const path = join(baselineDirectory, name.replace(/\.ts$/, ".errors.txt"));
  return existsSync(path) ? parseBaseline(name, readFileSync(path, "utf8")) : [];
});
const table = baselineTable(diagnostics);
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + "\n");
writeFileSync(baselineReport, JSON.stringify(diagnostics, null, 2) + "\n");

function publish(text: string): void {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\n" + text + "\n");
}

function savePass(subject: string, { raw, ...report }: Pass): void {
  const directory = dirname(baselineReport);
  writeFileSync(join(directory, `effect-${subject}-raw.json`), JSON.stringify(raw));
  writeFileSync(join(directory, `effect-${subject}-score.json`), JSON.stringify(report, null, 2) + "\n");
}

exposeReferencePackages(root);
const reference = await runPass("reference", fixtures, diagnostics);
publish(passTable(reference));
savePass("reference", reference);

if (!isExact(reference)) {
  publish("Reference self-test failed. Patched Bun was not scored.");
  if (reference.failures.length) console.error(reference.failures.slice(0, 5).join("\n"));
  process.exitCode = 1;
} else {
  const bun = await runPass("bun", fixtures, diagnostics);
  if (bun.failures.length) {
    publish("Some Bun fixtures failed to execute or parse. The table covers completed fixtures.");
  }
  publish(passTable(bun));
  publish(floatingEffectTable(bun));
  savePass("bun", bun);
}
