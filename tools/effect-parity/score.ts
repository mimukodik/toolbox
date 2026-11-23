import { mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Diagnostic, type ParsedOutput, parityRules, parseTypeScript } from "./diagnostics";
import type { Fixture } from "./fixtures";

const linterModules = join(import.meta.dir, "linter/node_modules");
export const gatedBunRules = new Set<string>(parityRules);
const oxlintRules = new Map(parityRules.map((name) => [
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), name,
]));
const bunRules = new Map<string, string>(
  [...oxlintRules].flatMap(([slug, name]) => [
    [`bun(${slug})`, name] as const,
    [`bun/${slug}`, name] as const,
  ]),
);
const effectTsgo = join(linterModules, ".bin/effect-tsgo");

function lintCommand(command: string[], { tsconfig, directory }: Fixture): string[] {
  return [...command, "--type-aware", "--type-check", "--tsconfig", tsconfig, "--format=unix", directory];
}

const subjects = {
  compiler: {
    label: "Effect TSRS compiler",
    command: ({ tsconfig }: Fixture) => [effectTsgo, "tsrs", "--noEmit", "--pretty", "false", "-p", tsconfig],
    parse: parseCompiler,
    // TSRS uses the compiler's DiagnosticsPresent exit statuses.
    diagnosticExits: [1, 2],
  },
  oxlint: {
    label: "Effect TSRS Oxlint",
    command: (fixture: Fixture) => lintCommand([effectTsgo, "--tsrs-lint", "oxlint"], fixture),
    parse: parseUnix,
    diagnosticExits: [1],
  },
  bun: {
    label: "Patched Bun",
    command: (fixture: Fixture) => lintCommand([
      process.env.EFFECT_PARITY_CANDIDATE_BUN ?? "/usr/local/bin/bun", "lint", "--no-script",
    ], fixture),
    parse: parseUnix,
    diagnosticExits: [1],
  },
};

type RawResult = { fixture: string; exitCode: number; stdout: string; stderr: string };
type Match = { expected: Diagnostic; actual: Diagnostic };
type FixtureScore = {
  fixture: string;
  matched: Match[];
  missing: Diagnostic[];
  extra: Diagnostic[];
  nonEffect: number;
};
export type Pass = {
  label: string;
  wallSeconds: number;
  fixtures: FixtureScore[];
  failures: string[];
  raw: RawResult[];
};

export function exposeReferencePackages(root: string): void {
  const modules = join(root, "node_modules");
  mkdirSync(modules);
  for (const name of ["oxlint", "tsrs"]) {
    symlinkSync(join(linterModules, name), join(modules, name), "dir");
  }
}

function virtualFile(fixture: Fixture, path: string): string {
  return fixture.files[resolve(fixture.cwd, path)]
    ?? fixture.files[resolve(fixture.directory, path)]
    ?? path;
}

function parseCompiler(fixture: Fixture, output: string): ParsedOutput {
  const parsed = parseTypeScript(fixture.name, output);
  for (const diagnostic of parsed.effect) diagnostic.file = virtualFile(fixture, diagnostic.file);
  return parsed;
}

function parseUnix(fixture: Fixture, output: string): ParsedOutput {
  const header = /^(.*?):(\d+):(\d+): /;
  const diagnostics = output.split(/\r?\n/).reduce<string[]>((records, line) => {
    if (header.test(line)) records.push(line);
    else if (records.length) records[records.length - 1] += "\n" + line;
    return records;
  }, []);

  const effect: Diagnostic[] = [];
  let nonEffect = 0;
  for (const record of diagnostics) {
    const location = header.exec(record)!;
    const [, path, row, col] = location;
    const body = record.slice(location[0].length);
    const end = /[ \t]\[(Error|Warning)(?:\/([^\]\n]+))?\]\s*(?:\n\d+ problems?\s*)?$/i.exec(body);
    if (!end) throw new Error(`${fixture.name}: unrecognized Unix diagnostic ${record}`);
    const [, severity, code = ""] = end;
    const text = body.slice(0, end.index);
    const effectTag = /\s*effect\((\w+)\)\s*$/.exec(text);
    const oxlintTag = /^effecttsgo\(([^)]+)\)$/.exec(code);
    const rule = bunRules.get(code)
      ?? effectTag?.[1]
      ?? (oxlintTag && (oxlintRules.get(oxlintTag[1]) ?? oxlintTag[1]));

    if (!rule) {
      nonEffect++;
      continue;
    }
    effect.push({
      fixture: fixture.name, file: virtualFile(fixture, path), line: Number(row), col: Number(col),
      rule, severity: severity.toLowerCase(), message: effectTag ? text.slice(0, effectTag.index) : text,
    });
  }
  return { effect, nonEffect };
}

export function compareLocations(baseline: Diagnostic[], actual: Diagnostic[], includeSeverity = false) {
  function key({ fixture, file, line, col, rule, severity }: Diagnostic): string {
    return JSON.stringify([fixture, file, line, col, rule, includeSeverity ? severity : null]);
  }
  const expected = new Map<string, Diagnostic[]>();
  for (const item of baseline) {
    const location = key(item);
    const bucket = expected.get(location) ?? [];
    bucket.push(item);
    expected.set(location, bucket);
  }
  const matched: Match[] = [];
  const extra: Diagnostic[] = [];
  for (const item of actual) {
    const bucket = expected.get(key(item));
    const match = bucket?.shift();
    if (match) matched.push({ expected: match, actual: item });
    else extra.push(item);
  }
  return { matched, extra, missing: [...expected.values()].flat() };
}

export async function runPass(
  subject: keyof typeof subjects, fixtures: Fixture[], baselines: Diagnostic[],
): Promise<Pass> {
  const { command, label, parse, diagnosticExits } = subjects[subject];
  const expected = Map.groupBy(baselines, ({ fixture }) => fixture);
  const scores: FixtureScore[] = [];
  const raw: RawResult[] = [];
  const failures: string[] = [];
  let index = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < fixtures.length) {
      const fixture = fixtures[index++];
      try {
        const run = Bun.spawn(command(fixture), {
          cwd: fixture.cwd,
          env: { ...process.env, NO_COLOR: "1" },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited,
        ]);
        raw.push({ fixture: fixture.name, exitCode, stdout, stderr });
        const result = parse(fixture, stdout);
        const baseline = (expected.get(fixture.name) ?? []).filter(({ rule }) => gatedBunRules.has(rule));
        scores.push({ fixture: fixture.name, ...compareLocations(baseline, result.effect), nonEffect: result.nonEffect });
        const reportedDiagnostics = result.effect.length + result.nonEffect > 0;
        if (exitCode !== 0 && !(diagnosticExits.includes(exitCode) && reportedDiagnostics)) {
          failures.push(`${fixture.name}: exit ${exitCode}: ${stderr || stdout}`);
        }
      } catch (error) {
        failures.push(`${fixture.name}: ${String(error)}`);
      }
    }
  }));
  return {
    label, wallSeconds: (performance.now() - started) / 1000,
    fixtures: scores.sort((left, right) => left.fixture.localeCompare(right.fixture)),
    raw: raw.sort((left, right) => left.fixture.localeCompare(right.fixture)),
    failures: failures.sort(),
  };
}

function normalizeMessage(message: string): string {
  return message.trim();
}

export function totals(pass: Pass) {
  return {
    matched: pass.fixtures.flatMap((row) => row.matched),
    missing: pass.fixtures.flatMap((row) => row.missing),
    extra: pass.fixtures.flatMap((row) => row.extra),
    nonEffect: pass.fixtures.reduce((sum, row) => sum + row.nonEffect, 0),
  };
}

export function passTable(pass: Pass): string {
  const { matched, missing, extra, nonEffect } = totals(pass);
  const rows = parityRules.map((rule) => {
    const matches = matched.filter(({ expected }) => expected.rule === rule);
    const misses = missing.filter((item) => item.rule === rule);
    const extras = extra.filter((item) => item.rule === rule);
    const severity = matches.filter(({ expected, actual }) => expected.severity === actual.severity).length;
    const message = matches.filter(({ expected, actual }) =>
      normalizeMessage(expected.message) === normalizeMessage(actual.message)).length;
    return `| ${rule} | ${matches.length} | ${misses.length} | ${extras.length} | ${severity} | ${message} |`;
  });

  return [
    `### ${pass.label}`, "",
    "| Rule | Matched | Missing | Extra | Severity agrees | Message agrees |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    `Wall time across the fixture pass: ${pass.wallSeconds.toFixed(2)} s`,
    `Non-Effect diagnostics: ${nonEffect}`,
    `Out-of-scope Effect diagnostics: ${extra.filter(({ rule }) => !gatedBunRules.has(rule)).length}`,
    `Fixture execution or parsing failures: ${pass.failures.length}`,
    "",
  ].join("\n");
}

export function referenceGateFailures(compiler: Pass, oxlint: Pass): string[] {
  const failures: string[] = [];
  const direct = totals(compiler);
  const lint = totals(oxlint);
  const scoredExtra = ({ rule }: Diagnostic) => gatedBunRules.has(rule);
  if (compiler.failures.length || direct.matched.length !== 230 || direct.missing.length
    || direct.extra.some(scoredExtra)) {
    failures.push("Direct compiler gate failed. Expected 230 matched, zero missing and zero scored extras.");
  }
  const suggestions = lint.missing.filter(({ severity }) => severity === "suggestion").length;
  const messages = lint.missing.filter(({ severity }) => severity === "message").length;
  const visible = lint.matched.every(({ expected }) => expected.severity === "error" || expected.severity === "warning");
  if (oxlint.failures.length || lint.matched.length !== 195 || lint.missing.length !== 35
    || suggestions !== 34 || messages !== 1 || !visible || lint.extra.some(scoredExtra)) {
    failures.push("Oxlint gate failed. Expected 195 error/warning matches, zero scored extras, and 34 suggestions plus one message missing.");
  }
  return failures;
}

export function gatedDiagnostics(pass: Pass): Diagnostic[] {
  const { matched, extra } = totals(pass);
  return [...matched.map(({ actual }) => actual), ...extra].filter(({ rule }) => gatedBunRules.has(rule));
}

export function candidateGate(compiler: Pass, oxlint: Pass, bun: Pass): { passed: boolean; evidence: string } {
  const candidate = gatedDiagnostics(bun);
  const lintReference = gatedDiagnostics(oxlint);
  const compilerReference = gatedDiagnostics(compiler);
  const lint = compareLocations(lintReference, candidate);
  const direct = compareLocations(compilerReference, candidate);
  // Oxlint reports the compiler's warnings as errors in its Unix output.
  const severityMismatches = direct.matched.filter(({ expected, actual }) => expected.severity !== actual.severity);
  const expectedOmissions = compilerReference.filter(({ severity }) => severity === "message" || severity === "suggestion");
  const omissions = compareLocations(expectedOmissions, direct.missing);
  const omissionsMatch = omissions.missing.length === 0 && omissions.extra.length === 0
    && omissions.matched.every(({ expected, actual }) => expected.severity === actual.severity);
  const passed = lint.matched.length === 195 && lint.missing.length === 0
    && lint.extra.length === 0 && bun.failures.length === 0
    && direct.matched.length === 195 && direct.missing.length === 35
    && direct.extra.length === 0 && omissionsMatch && severityMismatches.length === 0;
  const ruleRows = [...gatedBunRules].map((rule) => {
    const lintCount = lintReference.filter((diagnostic) => diagnostic.rule === rule).length;
    const compilerCount = compilerReference.filter((diagnostic) => diagnostic.rule === rule).length;
    const bunCount = candidate.filter((diagnostic) => diagnostic.rule === rule).length;
    const hiddenCount = expectedOmissions.filter((diagnostic) => diagnostic.rule === rule).length;
    return `| ${rule} | ${lintCount} | ${compilerCount} | ${bunCount} | ${hiddenCount} |`;
  });
  const location = ({ fixture, file, line, col, rule, severity }: Diagnostic) =>
    `\`${fixture}\` at \`${file}:${line}:${col}\` (${rule}, ${severity})`;

  return {
    passed,
    evidence: [
      `### Candidate Bun gate ${passed ? "passed" : "failed"}`, "",
      `Gated rules: ${[...gatedBunRules].join(", ")}`, "",
      "| Reference | Matched locations | Missing locations | Extra locations |",
      "| --- | ---: | ---: | ---: |",
      `| Oxlint | ${lint.matched.length} | ${lint.missing.length} | ${lint.extra.length} |`,
      `| Direct compiler | ${direct.matched.length} | ${direct.missing.length} | ${direct.extra.length} |`, "",
      "| Rule | Oxlint | Direct compiler | Bun | Compiler-only severity |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...ruleRows, "",
      `- Fixture execution or parsing failures: ${bun.failures.length}`,
      `- Direct compiler omissions are exactly the message and suggestion diagnostics: ${omissionsMatch ? "yes" : "no"}`,
      `- Direct compiler severity mismatches: ${severityMismatches.length}`,
      ...lint.missing.map((item) => `- Oxlint only: ${location(item)} — ${item.message}`),
      ...lint.extra.map((item) => `- Bun only: ${location(item)} — ${item.message}`),
      ...direct.missing.map((item) => `- Missing direct compiler location: ${location(item)}`),
      ...severityMismatches.map(({ expected, actual }) => `- Severity mismatch: ${location(actual)}, expected ${expected.severity}`),
    ].join("\n"),
  };
}

export function floatingEffectTable(pass: Pass): string {
  const rule = "floatingEffect";
  const rows = pass.fixtures.flatMap(({ fixture, matched, missing, extra }) => {
    const matches = matched.filter(({ expected }) => expected.rule === rule).length;
    const misses = missing.filter((diagnostic) => diagnostic.rule === rule).length;
    const extras = extra.filter((diagnostic) => diagnostic.rule === rule).length;
    return matches + misses + extras > 0 ? [`| ${fixture} | ${matches} | ${misses} | ${extras} |`] : [];
  });
  const { matched, missing, extra } = totals(pass);
  const matchCount = matched.filter(({ expected }) => expected.rule === rule).length;
  const misses = missing.filter((diagnostic) => diagnostic.rule === rule);
  const extras = extra.filter((diagnostic) => diagnostic.rule === rule);
  const lowerSeverity = misses.filter(({ severity }) => severity === "suggestion" || severity === "message");
  return [
    "### Patched Bun floatingEffect by fixture", "",
    "| Fixture | Matched | Missing | Extra |",
    "| --- | ---: | ---: | ---: |",
    ...rows,
    `| **Total** | **${matchCount}** | **${misses.length}** | **${extras.length}** |`, "",
    "#### Extra diagnostics", "",
    ...(extras.length ? extras.map(({ fixture, file, line, col, severity }) =>
      `- \`${fixture}\` at \`${file}:${line}:${col}\` (${severity})`) : ["None."]),
    "",
    "#### Missing suggestions and messages", "",
    ...(lowerSeverity.length ? lowerSeverity.map(({ fixture, file, line, col, severity }) =>
      `- \`${fixture}\` at \`${file}:${line}:${col}\` (${severity})`) : ["None."]),
    "",
  ].join("\n");
}
