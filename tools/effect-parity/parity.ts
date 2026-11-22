import { readdirSync } from "node:fs";
import { join } from "node:path";

const upstream = process.argv[2];
if (!upstream) throw new Error("Usage: bun parity.ts <Effect source checkout>");

const fixtureDirectory = join(upstream, "testdata/tests/effect-v4");
const fixtures = readdirSync(fixtureDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => entry.name)
  .sort();

if (fixtures.length !== 553) {
  throw new Error(`Expected 553 Effect v4 fixtures, found ${fixtures.length}`);
}
console.log(`Found ${fixtures.length} Effect v4 fixtures with stock Bun ${Bun.version}`);
