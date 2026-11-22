import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFixtures, layOutFixture } from "./fixtures";

const [upstream, report] = process.argv.slice(2);
if (!upstream || !report) throw new Error("Usage: bun parity.ts <Effect source checkout> <layout report>");

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
