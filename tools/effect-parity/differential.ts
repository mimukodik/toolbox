import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { type Diagnostic, parseTypeScript } from "./diagnostics";
import { discoverFixtures, type Fixture, layOutFixture } from "./fixtures";
import { type Mutation, rank } from "./mutations";
import { compareLocations, exposeReferencePackages, gatedBunRules, gatedDiagnostics, runPass } from "./score";

const modes = ["single-config", "extends-plugin", "null-severity"] as const;
type Mode = typeof modes[number];
type Case = Mutation & { file: string; fixture: string };
type Difference = { reference?: Diagnostic; candidate?: Diagnostic };
type Finding = Difference & {
  mode: Mode;
  mechanism: string;
  seed: string;
  classification: "listed" | "new";
  listedBy: string[];
};

const maxPerMutation = 8;
const [upstream, artifactDirectory] = process.argv.slice(2);
if (!upstream || !artifactDirectory || !process.env.EFFECT_PARITY_CANDIDATE_BUN) {
  throw new Error("Usage: EFFECT_PARITY_CANDIDATE_BUN=<candidate> bun differential.ts <Effect checkout> <artifact directory>");
}
const summary = join(artifactDirectory, "differential-summary.md");
const started = performance.now();
const root = mkdtempSync(join(tmpdir(), "effect-differential-"));
const elapsed = () => ((performance.now() - started) / 1000).toFixed(2);
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

function publish(lines: string[]): void {
  const markdown = ["# Effect lint differential", "", ...lines, "", `Wall time: ${elapsed()} s`, ""].join("\n");
  writeFileSync(summary, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
}

function generateCases(): Case[] {
  const fixtureDirectory = join(upstream, "testdata/tests/effect-v4");
  const baselineDirectory = join(upstream, "testdata/baselines/reference/effect-v4");
  const parser = join(root, "ast");
  const input = join(parser, "seeds");
  const output = join(parser, "results");
  mkdirSync(input, { recursive: true });
  mkdirSync(output);

  const seeds = new Map<string, string>();
  for (const name of discoverFixtures(fixtureDirectory)) {
    const baseline = join(baselineDirectory, name.replace(/\.ts$/, ".errors.txt"));
    if (!existsSync(baseline)) continue;
    const diagnostics = parseTypeScript(name, readFileSync(baseline, "utf8")).effect
      .filter(({ rule }) => gatedBunRules.has(rule));
    if (!diagnostics.length) continue;
    const source = readFileSync(join(fixtureDirectory, name), "utf8").replace(/\r\n/g, "\n");
    if (/^\/\/\s*@filename\s*:/im.test(source) || diagnostics.some(({ file }) => basename(file) !== name)) {
      throw new Error(`Expected a standalone TypeScript seed, found virtual files in ${name}`);
    }
    const lineStarts = [0];
    for (const newline of source.matchAll(/\n/g)) lineStarts.push(newline.index! + 1);
    const offsets = diagnostics.map(({ line, col }) => lineStarts[line - 1] + col - 1);
    seeds.set(name, source);
    writeFileSync(join(input, name), source);
    json(join(output, name + ".json"), offsets);
  }
  if (!seeds.size) throw new Error("No fixtures report diagnostics for the gated rules.");

  // Reuse the already installed Oxlint parser's TypeScript AST through its JS
  // rule API. Only the generator rule runs in this pass.
  const plugin = new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(join(import.meta.dir, "mutations.ts"), "utf8"));
  writeFileSync(join(parser, "mutations.mjs"), plugin);
  const config = join(parser, "oxlint.json");
  json(config, {
    categories: { correctness: "off" },
    jsPlugins: [{ name: "differential", specifier: "./mutations.mjs" }],
    rules: { "differential/generate": "error" },
  });
  const oxlint = join(import.meta.dir, "linter/node_modules/oxlint/bin/oxlint");
  const astRun = Bun.spawnSync(["node", oxlint, "--threads", "1", "-c", config, input], {
    cwd: parser,
    env: { ...process.env, EFFECT_MUTATION_OUTPUT: output },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (astRun.exitCode !== 0) {
    throw new Error(`The Oxlint AST pass exited ${astRun.exitCode}\n${astRun.stdout.toString()}${astRun.stderr.toString()}`);
  }

  const typescript = new Bun.Transpiler({ loader: "ts" });
  const cases = (fixture: string, mutation: Mutation): Case => ({
    ...mutation, fixture, file: `cases/${mutation.kind}/${fixture.slice(0, -3)}/${fixture}`,
  });
  const controls = Array.from(seeds, ([name, source]) => cases(name, { kind: "single-config", source }));
  const variants = Array.from(seeds.keys()).flatMap((name) => {
    const mutations: Mutation[] = JSON.parse(readFileSync(join(output, name + ".json"), "utf8"));
    if (!Array.isArray(mutations) || mutations.some((mutation) => typeof mutation.source !== "string")) {
      throw new Error(`The Oxlint AST pass did not generate mutations for ${name}.`);
    }
    return mutations.map((mutation) => cases(name, mutation));
  });
  if (!variants.length) throw new Error("The AST pass generated an empty mutation corpus.");
  const selected = Array.from(Map.groupBy(variants, ({ kind }) => kind).values()).flatMap((group) =>
    group.sort((a, b) => rank(a.file) - rank(b.file)).slice(0, maxPerMutation));
  for (const { source, file } of selected) {
    try {
      typescript.transformSync(source);
    } catch (error) {
      throw new Error(`Generated TypeScript did not parse: ${file}`, { cause: error });
    }
  }
  return [...controls, ...selected].sort((a, b) => a.file.localeCompare(b.file));
}

function project(mode: Mode, cases: Case[]): Fixture {
  const source = cases.flatMap(({ file, source, reexport }) => [
    `// @filename: ${file}\n${source}`,
    ...(reexport ? [`// @filename: ${dirname(file)}/effect-api.ts\n${reexport}\n`] : []),
  ]).join("\n");
  const fixture = layOutFixture(mode, source, join(root, mode));
  const config = JSON.parse(readFileSync(fixture.tsconfig, "utf8"));
  const [plugin] = config.compilerOptions.plugins;
  // An explicit warning exercises inheritance because the default is error.
  plugin.diagnosticSeverity.floatingEffect = "warning";
  if (mode === "extends-plugin") {
    json(join(fixture.directory, "tsconfig.base.json"), { compilerOptions: config.compilerOptions });
    config.extends = "./tsconfig.base.json";
    config.compilerOptions = { plugins: [{ name: plugin.name }] };
  } else if (mode === "null-severity") {
    plugin.diagnosticSeverity = null;
  }
  json(fixture.tsconfig, config);
  return fixture;
}

function visible({ severity }: Diagnostic): boolean {
  return severity === "error" || severity === "warning";
}

function disagreementKey(difference: Difference): string {
  const diagnostic = (difference.reference ?? difference.candidate)!;
  return JSON.stringify([
    diagnostic.file, diagnostic.line, diagnostic.col, diagnostic.rule,
    difference.reference?.severity, difference.candidate?.severity,
  ]);
}

function compare(reference: Diagnostic[], candidate: Diagnostic[]) {
  const exact = compareLocations(reference, candidate, true);
  // Pair any remaining reports at one location so a severity mismatch counts once.
  const changed = compareLocations(exact.missing, exact.extra);
  const differences: Difference[] = [
    ...changed.matched.map(({ expected, actual }) => ({ reference: expected, candidate: actual })),
    ...changed.missing.map((reference) => ({ reference })),
    ...changed.extra.map((candidate) => ({ candidate })),
  ];
  return { agreements: exact.matched.map(({ actual }) => actual), differences };
}

function documentedMechanisms(): Map<string, string[]> {
  const path = join(import.meta.dir, "../bun/effect-port-differences.md");
  const tags = new Map<string, string[]>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const anchor = /^\| <a name="([^"]+)"/.exec(line)?.[1];
    if (!anchor) continue;
    const cell = /\|([^|]+)\|\s*$/.exec(line)?.[1] ?? "";
    const names = Array.from(cell.matchAll(/`([a-zA-Z0-9:-]+)`/g), ([, tag]) => tag);
    if (!names.includes(anchor)) throw new Error(`Missing differential tag on documented difference ${anchor}.`);
    for (const name of names) tags.set(name, [...(tags.get(name) ?? []), anchor]);
  }
  if (!tags.size) throw new Error("No differential tags found on the documented differences.");
  return tags;
}

function writeRepro(finding: Finding, sample: Case, fixture: Fixture): string {
  const directory = join(artifactDirectory, "differential-repros", finding.mechanism);
  const target = join(directory, sample.file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(fixture.directory, sample.file), target);
  const files = [sample.file];
  if (sample.reexport) {
    const companion = join(dirname(sample.file), "effect-api.ts");
    copyFileSync(join(fixture.directory, companion), join(directory, companion));
    files.push(companion);
  }
  const config = JSON.parse(readFileSync(fixture.tsconfig, "utf8"));
  json(join(directory, "tsconfig.json"), { ...config, files });
  if (config.extends) copyFileSync(join(fixture.directory, config.extends), join(directory, config.extends));
  copyFileSync(join(fixture.directory, "package.json"), join(directory, "package.json"));
  return relative(artifactDirectory, target);
}

try {
  const tags = documentedMechanisms();
  const cases = generateCases();
  const byFile = new Map(cases.map((item) => [`/.src/${item.file}`, item]));
  const projects = modes.map((mode) => project(mode, cases));
  exposeReferencePackages(root);
  const compiler = await runPass("compiler", projects, []);
  const oxlint = await runPass("oxlint", projects, []);
  const bun = await runPass("bun", projects, []);
  const failures = [compiler, oxlint, bun].flatMap(({ label, failures }) => failures.map((failure) => `${label}: ${failure}`));
  const compilerDiagnostics = gatedDiagnostics(compiler);
  const oxlintDiagnostics = gatedDiagnostics(oxlint).filter(visible);
  const candidateDiagnostics = gatedDiagnostics(bun).filter(visible);
  // The Unix bridge renders TS compiler warnings as errors. Pair by location
  // with the direct compiler for severity, as the fixture gate does.
  const severity = compareLocations(compilerDiagnostics, oxlintDiagnostics);
  if ([...oxlintDiagnostics, ...candidateDiagnostics].some(({ file }) => !byFile.has(file))) {
    failures.push("A gated lint diagnostic could not be mapped to a source case.");
  }
  if (failures.length) {
    json(join(artifactDirectory, "differential-failures.json"), { failures, compiler: compiler.raw, oxlint: oxlint.raw, bun: bun.raw });
    throw new Error(failures.map((failure) => failure.slice(0, 600)).join("\n"));
  }
  const reference = Map.groupBy([
    ...severity.matched.map(({ expected, actual }) => ({ ...actual, severity: expected.severity })).filter(visible),
    ...severity.extra,
  ], ({ fixture }) => fixture);
  const candidate = Map.groupBy(candidateDiagnostics, ({ fixture }) => fixture);

  const counts = new Map<string, Map<string, { listed: number; new: number; agreements: number }>>();
  const findings: Finding[] = [];
  const smallest = new Map<string, { finding: Finding; sample: Case }>();
  const controlDifferences = new Set<string>();
  const tally = (mechanism: string, rule: string, field: "listed" | "new" | "agreements") => {
    const rules = counts.get(mechanism) ?? new Map();
    const row = rules.get(rule) ?? { listed: 0, new: 0, agreements: 0 };
    row[field]++;
    rules.set(rule, row);
    counts.set(mechanism, rules);
  };

  const kindCounts = Map.groupBy(cases, ({ kind }) => kind);
  const mechanisms = [...new Set([...kindCounts.keys(), ...modes])].sort();
  for (const mode of modes) {
    const { agreements, differences } = compare(reference.get(mode) ?? [], candidate.get(mode) ?? []);
    for (const agreement of agreements) {
      const kind = byFile.get(agreement.file)!.kind;
      tally(mode === "single-config" ? kind : mode, agreement.rule, "agreements");
    }
    for (const difference of differences) {
      const { file, rule } = (difference.reference ?? difference.candidate)!;
      const sample = byFile.get(file)!;
      const key = disagreementKey(difference);
      if (mode === "single-config") controlDifferences.add(key);
      const mechanism = controlDifferences.has(key) ? sample.kind : mode;
      // Match the inheritance row only when the explicit warning becomes the
      // default error. Other effects of changing the config remain new.
      const matchesExtends = mechanism !== "extends-plugin"
        || (difference.reference?.severity === "warning" && difference.candidate?.severity === "error");
      const listedBy = matchesExtends ? [...(tags.get(mechanism) ?? []), ...(tags.get(`${mechanism}:${rule}`) ?? [])] : [];
      const classification = listedBy.length ? "listed" : "new";
      const finding: Finding = { ...difference, mode, mechanism, seed: sample.fixture, classification, listedBy };
      findings.push(finding);
      tally(mechanism, rule, classification);
      if (classification === "listed") continue;
      const existing = smallest.get(mechanism);
      if (!existing || Buffer.byteLength(sample.source) < Buffer.byteLength(existing.sample.source)) {
        smallest.set(mechanism, { finding, sample });
      }
    }
  }

  const repros = Array.from(smallest, ([mechanism, { finding, sample }]) => {
    const fixture = projects.find(({ name }) => name === finding.mode)!;
    const file = writeRepro(finding, sample, fixture);
    return `- ${mechanism}: [${sample.fixture}](${file}) (${finding.mode})`;
  }).sort();
  const totals = Array.from(counts.values()).flatMap((rows) => Array.from(rows.values())).reduce(
    (sum, row) => ({ new: sum.new + row.new, listed: sum.listed + row.listed, agreements: sum.agreements + row.agreements }),
    { new: 0, listed: 0, agreements: 0 },
  );
  const rows = mechanisms.flatMap((mechanism) => [...gatedBunRules].map((rule) => {
    const row = counts.get(mechanism)?.get(rule);
    return `| ${mechanism} | ${rule} | ${row?.new ?? 0} | ${row?.listed ?? 0} | ${row?.agreements ?? 0} |`;
  }));
  json(join(artifactDirectory, "differential-differences.json"), findings);
  publish([
    `Corpus: ${kindCounts.get("single-config")!.length} seed files and ${cases.length - kindCounts.get("single-config")!.length} mutations, plus ${cases.filter(({ reexport }) => reexport).length} local re-export files, in each of ${projects.length} projects.`,
    `Mutation cap: ${maxPerMutation} per kind. Candidate build run: ${process.env.BUN_BUILD_RUN ?? "unspecified"}.`, "",
    `Pass times: Oxlint ${oxlint.wallSeconds.toFixed(2)} s, Bun ${bun.wallSeconds.toFixed(2)} s, compiler severity lookup ${compiler.wallSeconds.toFixed(2)} s.`, "",
    ...(severity.extra.length ? [
      `Oxlint emitted ${severity.extra.length} diagnostics without matching compiler locations. Those use the Unix output severity.`, "",
    ] : []),
    "Agreements count identical visible diagnostic tuples. A severity change at one location counts as one disagreement.",
    "An unchanged disagreement in another config is counted under its original mechanism. Agreements in those configs appear under the config name.", "",
    "| Mechanism | Rule | New | Listed | Agreements |",
    "| --- | --- | ---: | ---: | ---: |",
    ...rows,
    `| **Total** | | **${totals.new}** | **${totals.listed}** | **${totals.agreements}** |`, "",
    "## Smallest reproductions for new differences", "",
    ...(repros.length ? repros : ["None."]), "",
    "See `differential-differences.json` for each disagreement, its configuration, and the matching difference-list row, if any.",
  ]);
  console.log(`Effect differential completed in ${elapsed()} s: ${totals.new} new, ${totals.listed} listed, ${totals.agreements} agreements.`);
} catch (error) {
  publish(["Report incomplete. See the workflow step log and any `differential-failures.json` in the artifact."]);
  throw error;
} finally {
  rmSync(root, { recursive: true, force: true });
}
