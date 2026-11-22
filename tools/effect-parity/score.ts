import { mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Diagnostic, parityRules } from "./diagnostics";
import type { Fixture } from "./fixtures";

const linterModules = join(import.meta.dir, "linter/node_modules");
const bunRules = new Map([
  ["bun(floating-effect)", "floatingEffect"],
]);
const requestedRules = new Set<string>(parityRules);
const oxlintRules = new Map(parityRules.map((name) => [
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), name,
]));
const reference = [join(linterModules, ".bin/effect-tsgo"), "--tsrs-lint", "oxlint"];
const patchedBun = ["/usr/local/bin/bun", "lint", "--no-script"];

type RawResult = { fixture: string; exitCode: number; stdout: string; stderr: string };
type Match = { expected: Diagnostic; actual: Diagnostic };
type FixtureScore = {
  fixture: string;
  matched: Match[];
  missing: Diagnostic[];
  extra: Diagnostic[];
  nonEffect: number;
};
type Pass = {
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

function parseUnix(fixture: Fixture, output: string): { effect: Diagnostic[]; nonEffect: number } {
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
      ?? (oxlintTag && (oxlintRules.get(oxlintTag[1]) ?? oxlintTag[1]))
      ?? (code.startsWith("bun(") ? code : undefined);

    if (!rule) {
      nonEffect++;
      continue;
    }
    const file = fixture.files[resolve(fixture.cwd, path)]
      ?? fixture.files[resolve(fixture.directory, path)]
      ?? path;
    effect.push({
      fixture: fixture.name, file, line: Number(row), col: Number(col),
      rule, severity: severity.toLowerCase(), message: effectTag ? text.slice(0, effectTag.index) : text,
    });
  }
  return { effect, nonEffect };
}

function key({ fixture, file, line, col, rule }: Diagnostic): string {
  return JSON.stringify([fixture, file, line, col, rule]);
}

function compare(fixture: string, baseline: Diagnostic[], result: ReturnType<typeof parseUnix>): FixtureScore {
  const expected = new Map<string, Diagnostic[]>();
  for (const item of baseline) {
    if (!requestedRules.has(item.rule)) continue;
    const location = key(item);
    const bucket = expected.get(location) ?? [];
    bucket.push(item);
    expected.set(location, bucket);
  }
  const matched: Match[] = [];
  const extra: Diagnostic[] = [];
  for (const actual of result.effect) {
    const bucket = expected.get(key(actual));
    const match = bucket?.shift();
    if (match) matched.push({ expected: match, actual });
    else extra.push(actual);
  }
  return { fixture, matched, extra, missing: [...expected.values()].flat(), nonEffect: result.nonEffect };
}

export async function runPass(
  subject: "reference" | "bun", fixtures: Fixture[], baselines: Diagnostic[],
): Promise<Pass> {
  const command = subject === "reference" ? reference : patchedBun;
  const label = subject === "reference" ? "effect-tsgo" : "Patched Bun";
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
        const run = Bun.spawn([...command, "--type-aware", "--type-check", "--tsconfig", fixture.tsconfig,
          "--format=unix", fixture.directory], {
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
        const result = parseUnix(fixture, stdout);
        scores.push(compare(fixture.name, expected.get(fixture.name) ?? [], result));
        if (exitCode !== 0 && (exitCode !== 1 || result.effect.length + result.nonEffect === 0)) {
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
    `Out-of-scope Effect diagnostics: ${extra.filter((item) => !requestedRules.has(item.rule)).length}`,
    `Fixture execution or parsing failures: ${pass.failures.length}`,
    "",
  ].join("\n");
}

export function isExact(pass: Pass): boolean {
  const { matched, missing, extra } = totals(pass);
  return pass.failures.length === 0 && matched.length === 230 && missing.length === 0
    && extra.every((item) => !requestedRules.has(item.rule));
}
