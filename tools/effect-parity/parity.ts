import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineTable, parseTypeScript } from "./diagnostics";
import { discoverFixtures, layOutFixture } from "./fixtures";
import {
  candidateGate, exposeReferencePackages, floatingEffectTable, type Pass, passTable, referenceGateFailures, runPass,
} from "./score";

const [upstream, artifactDirectory] = process.argv.slice(2);
if (!upstream || !artifactDirectory) {
  throw new Error("Usage: bun parity.ts <Effect source checkout> <artifact directory>");
}
const summaryFile = join(artifactDirectory, "effect-summary.md");

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
writeFileSync(join(artifactDirectory, "effect-layout.json"), JSON.stringify({ count, fixtures }, null, 2) + "\n");

const baselineDirectory = join(upstream, "testdata/baselines/reference/effect-v4");
const diagnostics = fixtures.flatMap(({ name }) => {
  const path = join(baselineDirectory, name.replace(/\.ts$/, ".errors.txt"));
  return existsSync(path) ? parseTypeScript(name, readFileSync(path, "utf8")).effect : [];
});
writeFileSync(join(artifactDirectory, "effect-baselines.json"), JSON.stringify(diagnostics, null, 2) + "\n");

function publish(text: string): void {
  console.log(text);
  appendFileSync(summaryFile, text + "\n\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n\n");
}

function savePass(subject: string, { raw, ...report }: Pass): void {
  writeFileSync(join(artifactDirectory, `effect-${subject}-raw.json`), JSON.stringify(raw));
  writeFileSync(join(artifactDirectory, `effect-${subject}-score.json`), JSON.stringify(report, null, 2) + "\n");
}

publish(baselineTable(diagnostics));
exposeReferencePackages(root);
const compiler = await runPass("compiler", fixtures, diagnostics);
publish(passTable(compiler));
savePass("compiler", compiler);

const oxlint = await runPass("oxlint", fixtures, diagnostics);
publish(passTable(oxlint));
savePass("oxlint", oxlint);

const gateFailures = referenceGateFailures(compiler, oxlint);
if (gateFailures.length) {
  publish(gateFailures.join("\n"));
  publish("Reference gate failed. Patched Bun was not scored.");
  for (const pass of [compiler, oxlint]) {
    if (pass.failures.length) console.error(pass.failures.slice(0, 5).join("\n"));
  }
  process.exitCode = 1;
} else {
  publish("Reference gates passed.");
  const bun = await runPass("bun", fixtures, diagnostics);
  if (bun.failures.length) {
    publish("Some Bun fixtures failed to execute or parse. The table covers completed fixtures.");
  }
  publish(passTable(bun));
  publish(floatingEffectTable(bun));
  savePass("bun", bun);
  if (process.env.EFFECT_PARITY_CANDIDATE_BUN) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "candidate_scored=true\n");
    const gate = candidateGate(compiler, oxlint, bun);
    publish(gate.evidence);
    if (!gate.passed) {
      if (bun.failures.length) console.error(bun.failures.slice(0, 5).join("\n"));
      process.exitCode = 1;
    }
  }
}
