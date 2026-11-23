import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { type Diagnostic, parseTypeScript } from "./diagnostics";
import { discoverFixtures, type Fixture, layOutFixture } from "./fixtures";
import { effectAlias, type Mutation, optionalPipeReceiverKind } from "./mutations";
import {
  compareLocations, exposeReferencePackages, gatedBunRules, gatedDiagnostics,
  isMissingContextPipeDiagnostic, missingContextPipe, runPass,
} from "./score";

const relationMode = "relation-positions";
const overloadRecovery = "relation-overload-recovery";
const earlierPipeStage = "earlier-pipe-stage";
const modes = ["single-config", "extends-plugin", "global-error", "rule-configuration", optionalPipeReceiverKind, relationMode] as const;
type Mode = typeof modes[number];
type Case = Mutation & { file: string; fixture: string; expectedRule?: string; expectedReports?: number };
type Difference = { reference?: Diagnostic; candidate?: Diagnostic };
type DocumentedTag = { anchor: string; mechanism: string; rule: string; outcome?: string };
type Finding = Difference & {
  mode: Mode;
  mechanism: string;
  seed: string;
  classification: "listed" | "new";
  listedBy: string[];
};

const [upstream, artifactDirectory] = process.argv.slice(2);
if (!upstream || !artifactDirectory || !process.env.EFFECT_PARITY_CANDIDATE_BUN) {
  throw new Error("Usage: EFFECT_PARITY_CANDIDATE_BUN=<candidate> bun differential.ts <Effect checkout> <artifact directory>");
}
const summary = join(artifactDirectory, "differential-summary.md");
const started = performance.now();
const root = mkdtempSync(join(tmpdir(), "effect-differential-"));
const elapsed = () => ((performance.now() - started) / 1000).toFixed(2);
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

function publish(lines: string[], title = "Effect lint differential"): void {
  const markdown = [`# ${title}`, "", ...lines, "", `Wall time: ${elapsed()} s`, ""].join("\n");
  writeFileSync(summary, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
}

const pipeableDeclaredTypes = "pipeable-declared-types";
const substitutedConditionalVariant = "reordered-conditional-substituted";

// Keep the reference fixtures' overload shapes and lift their results into
// Promise-returning thunks so the lint range reveals normalized pipe steps.
function overloadProbe(fixture: string, variant: string, declarations: string, first: string, last: string) {
  const lines = ['import { Effect, pipe } from "effect";', ...declarations.trim().split("\n")];
  const sites = [first, last].map((call, index) => {
    const form = index === 0 ? "data-first" : "data-last";
    const prefix = `export const ${index === 0 ? "dataFirst" : "dataLast"} = pipe(`;
    const sync = `${prefix}${call}, `;
    lines.push(`${sync}Effect.sync);`);
    return { form, line: lines.length, subjectColumn: prefix.length + 1, syncColumn: sync.length + 1 };
  });
  const sample: Case = {
    fixture, file: `cases/${pipeableDeclaredTypes}/${variant}.ts`,
    kind: pipeableDeclaredTypes, source: lines.join("\n") + "\n",
  };
  return { sample, sites };
}

const traverseProbe = overloadProbe("pipingFlows_selfDualOverloads.ts", "traverse-fixture", `
interface Box<A> { readonly value: A }
type Infer<S extends Iterable<any>> = S extends ReadonlyArray<infer A> ? A : S extends Iterable<infer A> ? A : never;
type Options<D> = { readonly concurrency?: number | undefined; readonly discard?: D | undefined };
declare const traverse: {
  <A, B, S extends Iterable<A> = Iterable<A>, const D extends boolean = false>(
    f: (a: A, i: number) => Box<B>, options?: Options<D>
  ): (self: [S] extends [never] ? Iterable<A> : S) => () => Promise<Box<D extends false ? Array<B> : void>>;
  <B, S extends Iterable<any>, const D extends boolean = false>(
    self: S, f: (a: Infer<S>, i: number) => Box<B>, options?: Options<D>
  ): () => Promise<Box<D extends false ? Array<B> : void>>;
};
declare const items: ReadonlyArray<number>;
declare const wrap: (n: number) => Box<string>;
`, "traverse(items, wrap)", "traverse(wrap)(items)");

const inlineBranch = "{ readonly value: [C] extends [never] ? B : C }";
const reorderedProbes = [
  { variant: "reordered-fixture", first: "B | C", last: "C | B" },
  { variant: "reordered-conditional-inline", first: inlineBranch, last: inlineBranch },
  { variant: substitutedConditionalVariant, first: inlineBranch,
    last: '{ readonly value: Branches<C, B>["value"] }' },
].map(({ variant, first, last }) => overloadProbe("pipingFlows_dataFirstOverloads.ts", variant, `
interface Box<A> { readonly value: A }
interface Branches<T, Fallback> { readonly value: [T] extends [never] ? Fallback : T }
declare function reordered<A, B, C = B>(self: Box<A>, options: {
  readonly onEmpty: () => B; readonly onValue: (value: A) => C;
}): () => Promise<${first}>;
declare function reordered<B, A, C = B>(options: {
  readonly onValue: (value: A) => C; readonly onEmpty: () => B;
}): (self: Box<A>) => () => Promise<${last}>;
declare const box: Box<number>;
const options = { onEmpty: () => "empty", onValue: (value: number) => value };
`, "reordered(box, options)", "reordered(options)(box)"));

const overloadProbes = [traverseProbe, ...reorderedProbes];

const optionalPipeProbeName = "optionalPipeTry.ts";
const optionalPipeProbe: Mutation = {
  kind: optionalPipeReceiverKind,
  source: `// @effect-diagnostics effectTryWithoutCatch:warning
import { Cause, Effect } from "effect";

declare const source: Effect.Effect<number> | undefined;

export const result = source?.pipe<
  Effect.Effect<number>,
  () => number,
  Effect.Effect<number, Cause.UnknownError>
>(() => () => 1, Effect.try);
`,
};

// Reuse the nested Effect from the fixture and vary the position supplying
// its expected type. Include controls for inference and mixed overload returns.
const nestedEffect = "Effect.succeed(Effect.succeed(42))";
const expectedTypeMutations = [
  {
    kind: "expected-real-const",
    source: `export const annotated: Effect.Effect<void> = ${nestedEffect};
export const inferred = ${nestedEffect};`,
  },
  {
    kind: "expected-real-return",
    source: `export function createJob(): Effect.Effect<void> {
  return ${nestedEffect};
}`,
  },
  {
    kind: "expected-real-argument",
    source: `export function enqueue(_job: Effect.Effect<void>): void {}
enqueue(${nestedEffect});`,
  },
  {
    kind: "expected-real-overload",
    source: `export function createJob(queue: "local"): Effect.Effect<void>;
export function createJob(queue: "remote"): Effect.Effect<void, Error>;
export function createJob(queue: string): Effect.Effect<void, Error> {
  return ${nestedEffect};
}

export function inspectJob(detail: false): Effect.Effect<void>;
export function inspectJob(detail: true): Effect.Effect<number>;
export function inspectJob(detail: boolean): Effect.Effect<void> | Effect.Effect<number> {
  return ${nestedEffect};
}

export function job(mode: "run"): Effect.Effect<void>;
export function job(mode: "stop"): Effect.Effect<never>;
export function job(mode: "run" | "stop"): Effect.Effect<void> {
  if (mode === "stop") return Effect.never;
  return ${nestedEffect};
}`,
  },
].map(({ kind, source }) => ({
  kind,
  source: `import { Effect } from "effect";

${source}
`,
}));

const runtimeProbe: Mutation = {
  kind: "effect-runner-alias",
  source: `// @effect-diagnostics runEffectInsideEffect:warning
import { Effect } from "effect";

const run = Effect.runSync;
export const job = Effect.gen(function* () {
  return run(Effect.succeed(42));
});`,
};

// Reuse the Effect and Layer fixture contracts. Every position gets a value
// whose full type fits and a value with exactly one additional channel member.
const relationContracts = [
  {
    rule: "missingEffectError", api: "Effect",
    types: 'interface ReadError { readonly _tag: "ReadError" }',
    allowed: "Effect.Effect<number>", requires: "Effect.Effect<number, ReadError>",
  },
  {
    rule: "missingEffectContext", api: "Effect",
    types: 'interface Database { readonly query: () => number }',
    allowed: "Effect.Effect<number>", requires: "Effect.Effect<number, never, Database>",
  },
  {
    rule: "missingLayerContext", api: "Layer",
    types: `interface Database { readonly query: () => number }
interface Repository { readonly read: () => number }`,
    allowed: "Layer.Layer<Repository>", requires: "Layer.Layer<Repository, never, Database>",
  },
];
const relationPositions = [
  { kind: "relation-satisfies", body: `export const good = ready satisfies Expected;
export const bad = missing satisfies Expected;` },
  { kind: "relation-reassignment", body: `let job: Expected = ready;
job = missing;
export { job };` },
  { kind: "relation-class-property", body: `export class Worker {
  readonly ready: Expected = ready;
  readonly job: Expected = missing;
}` },
  { kind: "relation-default-parameter", body: `export function worker(fallback: Expected = ready, job: Expected = missing) {
  return { fallback, job };
}` },
  { kind: "relation-object-property", body: `export const options: { fallback: Expected; job: Expected } = {
  fallback: ready,
  job: missing,
};` },
  { kind: "relation-arrow-return", body: `function schedule(build: () => Expected): Expected { return build(); }
export const fallback = schedule(() => ready);
export const job = schedule(() => missing);` },
  { kind: "relation-async-return", body: `export async function load(): Promise<Expected> {
  return missing;
}` },
  { kind: "relation-computed-property", body: `const key = "job";
export const options: { queue: { job: Expected } } = {
  queue: { [key]: missing },
};` },
  { kind: "relation-array-element", body: `export const jobs: ReadonlyArray<Expected> = [ready, missing];` },
  { kind: "relation-generic", body: `function dispatch<Job>(job: Job, consume: (job: NoInfer<Job>) => void): void {
  consume(job);
}
declare function enqueue(job: Expected): void;
dispatch(ready, enqueue);
dispatch(missing, enqueue);` },
  { kind: "relation-jsx-attribute", extension: "tsx" as const, body: `declare global { namespace JSX { interface Element {} } }
declare function Schedule(props: { job: Expected }): JSX.Element;
export const fallback = <Schedule job={ready} />;
export const job = <Schedule job={missing} />;` },
];
const relationCases: Case[] = relationPositions.flatMap(({ kind, body, extension }) => relationContracts.map(
  ({ api, rule, types, allowed, requires }) => ({
    kind, extension, fixture: `${rule}.ts`, expectedRule: rule,
    file: `cases/${kind}/${rule}.${extension ?? "ts"}`,
    source: `import { ${api} } from "effect";
${types}
type Expected = ${allowed};
declare const ready: Expected;
declare const missing: ${requires};

${body}
`,
  }),
));

const callbackReturns = [
  {
    kind: "relation-conditional-return",
    expectedReports: 2,
    body: `export function select(usePrimary: boolean): Effect.Effect<number> {
  return (usePrimary ? (primary) : (backup));
}`,
  },
  {
    kind: "relation-contextual-block-return",
    expectedReports: 1,
    body: `export const choose: (flag: boolean) => Effect.Effect<number> = (flag) => {
  return flag ? primary : backup;
};`,
  },
  {
    kind: "relation-contextual-expression-return",
    expectedReports: 1,
    body: `export const choose: (flag: boolean) => Effect.Effect<number> = (flag) => flag ? primary : backup;`,
  },
  {
    kind: "relation-contextual-multiple-returns",
    expectedReports: 1,
    body: `export const choose: (flag: boolean) => Effect.Effect<number> = (flag) => {
  if (flag) return primary;
  return backup;
};`,
  },
];
for (const { kind, expectedReports, body } of callbackReturns) {
  relationCases.push({
    kind,
    file: `cases/${kind}/missingEffectError.ts`,
    fixture: "missingEffectError.ts",
    expectedRule: "missingEffectError",
    expectedReports,
    source: `import { type Effect } from "effect";

interface ReadError { readonly _tag: "ReadError" }
interface BackupError { readonly _tag: "BackupError" }
declare const primary: Effect.Effect<number, ReadError>;
declare const backup: Effect.Effect<number, BackupError>;

${body}
`,
  });
}

function generateCases() {
  const fixtureDirectory = join(upstream, "testdata/tests/effect-v4");
  const baselineDirectory = join(upstream, "testdata/baselines/reference/effect-v4");
  const parser = join(root, "ast");
  const input = join(parser, "seeds");
  const output = join(parser, "results");
  mkdirSync(input, { recursive: true });
  mkdirSync(output);

  const seeds = new Map<string, string>();
  const catchSeeds = new Set<string>();
  const virtualSeeds: string[] = [];
  for (const name of discoverFixtures(fixtureDirectory)) {
    const baseline = join(baselineDirectory, name.replace(/\.ts$/, ".errors.txt"));
    if (!existsSync(baseline)) continue;
    const diagnostics = parseTypeScript(name, readFileSync(baseline, "utf8")).effect
      .filter(({ rule }) => gatedBunRules.has(rule));
    if (!diagnostics.length) continue;
    if (diagnostics.some(({ rule }) => rule === "catchUnfailableEffect")) catchSeeds.add(name);
    const source = readFileSync(join(fixtureDirectory, name), "utf8").replace(/\r\n/g, "\n");
    if (/^\/\/\s*@filename\s*:/im.test(source) || diagnostics.some(({ file }) => basename(file) !== name)) {
      // The fixture gate retains all virtual units and their config. AST
      // mutations run standalone sources so their baseline offsets stay valid.
      virtualSeeds.push(name);
      continue;
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

  const parsers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };
  const asCase = (fixture: string, mutation: Mutation): Case => {
    const name = fixture.slice(0, -3);
    const variant = mutation.direction ? `${mutation.kind}/${mutation.direction}` : mutation.kind;
    return { ...mutation, fixture, file: `cases/${variant}/${name}/${name}.${mutation.extension ?? "ts"}` };
  };
  const controls = Array.from(seeds, ([name, source]) => asCase(name, { kind: "single-config", source }));
  const variants = Array.from(seeds.keys()).flatMap((name) => {
    const mutations: Mutation[] = JSON.parse(readFileSync(join(output, name + ".json"), "utf8"));
    if (!Array.isArray(mutations) || mutations.some((mutation) => typeof mutation.source !== "string")) {
      throw new Error(`The Oxlint AST pass did not generate mutations for ${name}.`);
    }
    return mutations.map((mutation) => asCase(name, mutation));
  });
  if (!variants.length) throw new Error("The AST pass generated an empty mutation corpus.");
  const skippedTsx: string[] = [];
  const probes = [
    ...overloadProbes.map(({ sample }) => sample),
    asCase(optionalPipeProbeName, optionalPipeProbe),
    ...expectedTypeMutations.map((mutation) => asCase("effectInVoidSuccess.ts", mutation)),
    asCase("runEffectInsideEffect.ts", runtimeProbe),
  ];
  const selected = [...variants, ...probes].filter(({ source, file, extension, fixture }) => {
    try {
      parsers[extension ?? "ts"].transformSync(source);
      return true;
    } catch (error) {
      if (extension === "tsx") {
        skippedTsx.push(fixture);
        return false;
      }
      throw new Error(`Generated TypeScript did not parse: ${file}`, { cause: error });
    }
  });
  return {
    cases: [...controls, ...selected].sort((a, b) => a.file.localeCompare(b.file)),
    skippedTsx,
    virtualSeeds,
    catchSeeds,
    angleAssertions: seeds.size - variants.filter(({ extension }) => extension === "tsx").length,
  };
}

const scopedSource = 'import { Effect } from "effect"\nEffect.succeed(1)\n';
const specialCases: Record<"global-error" | "rule-configuration", Case[]> = {
  "global-error": [{
    kind: "global-error",
    fixture: "project-error.ts",
    file: "project-error.ts",
    source: [
      'import { Effect } from "effect"',
      'export const failure = Effect.fail(new Error("failure"))',
      'export const caught = Effect.try({ try: () => 1, catch: () => new Error("catch") })',
    ].join("\n"),
  }],
  "rule-configuration": ["generated", "app"].map((directory) => ({
    kind: "rule-configuration",
    fixture: "floating-effect.ts",
    file: `${directory}/floating-effect.ts`,
    source: scopedSource,
  })),
};
// noLib leaves the global namespace to this project. Define the compiler's
// required globals and a custom Error without introducing String.charAt.
const projectGlobals = `interface Array<T> { length: number; [index: number]: T }
interface Boolean {}
interface CallableFunction extends Function {}
interface Function {}
interface IArguments { length: number; [index: number]: unknown }
interface NewableFunction extends Function {}
interface Number {}
interface Object {}
interface RegExp {}
interface String {}
interface Error { name: string; message: string; stack?: string }
declare var Error: { new (message?: string): Error };`;

function project(mode: Mode, cases: Case[]): Fixture {
  const units = cases.flatMap(({ file, source, reexport }) => [
    `// @filename: ${file}\n${source}`,
    ...(reexport ? [`// @filename: ${dirname(file)}/effect-api.ts\n${reexport}\n`] : []),
  ]);
  if (mode === "global-error") units.push(`// @filename: globals.d.ts\n${projectGlobals}`);
  const fixture = layOutFixture(mode, units.join("\n"), join(root, mode));
  if (cases.some(({ kind }) => kind === "package-manifest")) {
    symlinkSync("effect", join(dirname(fixture.directory), "node_modules", effectAlias), "dir");
  }
  const config = JSON.parse(readFileSync(fixture.tsconfig, "utf8"));
  const [plugin] = config.compilerOptions.plugins;
  // An explicit warning exercises inheritance because the default is error.
  plugin.diagnosticSeverity.floatingEffect = "warning";
  if (mode === "extends-plugin") {
    json(join(fixture.directory, "tsconfig.base.json"), { compilerOptions: config.compilerOptions });
    config.extends = "./tsconfig.base.json";
    config.compilerOptions = { plugins: [{ name: plugin.name }] };
  }
  if (mode === "global-error") {
    config.compilerOptions.noLib = true;
    config.compilerOptions.types = [];
  }
  if (mode === "rule-configuration") {
    plugin.overrides = [{ include: ["generated/**/*.ts"], options: { diagnosticSeverity: { floatingEffect: "off" } } }];
  }
  if (mode === optionalPipeReceiverKind) config.compilerOptions.strictNullChecks = true;
  if (mode === relationMode) {
    config.compilerOptions.strict = true;
    config.compilerOptions.jsx = "preserve";
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

function documentedMechanisms(): DocumentedTag[] {
  const path = join(import.meta.dir, "../bun/effect-port-differences.md");
  const tags: DocumentedTag[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const anchor = /^\| <a name="([^"]+)"/.exec(line)?.[1];
    if (!anchor) continue;
    const cell = /\|([^|]+)\|\s*$/.exec(line)?.[1] ?? "";
    const names = Array.from(cell.matchAll(/`([^`]+)`/g), ([, tag]) => tag);
    if (!names.includes(anchor)) throw new Error(`Missing differential tag on documented difference ${anchor}.`);
    for (const name of names) {
      const match = /^([a-z][a-z0-9-]*)(?::(\*|[a-zA-Z][a-zA-Z0-9]*)(?::(missing|extra|earlier-pipe-stage|severity (?:error|warning)→(?:error|warning)))?)?$/.exec(name);
      if (!match) throw new Error(`Invalid differential tag on documented difference ${anchor}: ${name}`);
      const [, mechanism, rule = "*", outcome] = match;
      tags.push({ anchor, mechanism, rule, outcome });
    }
  }
  if (!tags.length) throw new Error("No differential tags found on the documented differences.");
  return tags;
}

function matchingTags(tags: DocumentedTag[], mechanism: string, rule: string): DocumentedTag[] {
  return tags.filter((tag) => tag.mechanism === mechanism && (tag.rule === rule || tag.rule === "*"));
}

function classify(tags: DocumentedTag[], mechanism: string, { reference, candidate }: Difference, pairedOutcome?: string) {
  const { rule } = (reference ?? candidate)!;
  const outcome = pairedOutcome ?? (!candidate ? "missing" : !reference ? "extra" : `severity ${reference.severity}→${candidate.severity}`);
  const listedBy = matchingTags(tags, mechanism, rule)
    .filter((tag) => tag.outcome === outcome)
    .map(({ anchor }) => anchor);
  const classification = listedBy.length ? "listed" : "new";
  return { classification, listedBy } as const;
}

// A missing warning alone is a regression. The tags cover the paired move
// on this probe's data-first call.
function substitutedConditionalMove(differences: Difference[]): Difference[] {
  const { sample, sites: [site] } = reorderedProbes.find(
    ({ sample }) => basename(sample.file, ".ts") === substitutedConditionalVariant,
  )!;
  const at = (diagnostic: Diagnostic | undefined, column: number) =>
    diagnostic?.file === `/.src/${sample.file}` && diagnostic.rule === "lazyPromiseInEffectSync"
      && diagnostic.severity === "warning" && diagnostic.line === site.line && diagnostic.col === column;
  const missing = differences.find(({ reference, candidate }) => !candidate && at(reference, site.syncColumn));
  const extra = differences.find(({ reference, candidate }) => !reference && at(candidate, site.subjectColumn));
  return missing && extra ? [missing, extra] : [];
}

function missingContextPipeMoves(differences: Difference[], byFile: Map<string, Case>): Set<Difference> {
  const relevant = differences.filter((difference) => {
    const { file, rule } = (difference.reference ?? difference.candidate)!;
    return rule === missingContextPipe.rule && byFile.get(file)?.fixture === missingContextPipe.fixture;
  });
  const bySource = Map.groupBy(relevant, (difference) => (difference.reference ?? difference.candidate)!.file);
  const moves = new Set<Difference>();
  for (const [file, entries] of bySource) {
    if (entries.length !== 2) continue;
    // The namespace-import mutation inserts one line before both stages.
    const offset = byFile.get(file)!.kind === "import-namespace" ? 1 : 0;
    const missing = entries.find(({ reference, candidate }) =>
      reference && !candidate && isMissingContextPipeDiagnostic(reference, "reference", offset));
    const extra = entries.find(({ reference, candidate }) =>
      !reference && candidate && isMissingContextPipeDiagnostic(candidate, "candidate", offset));
    if (missing && extra) {
      moves.add(missing);
      moves.add(extra);
    }
  }
  return moves;
}

class ClassifierSelfTestError extends Error {}

function checkClassifier(tags: DocumentedTag[]): void {
  const warning: Diagnostic = {
    fixture: "self-test", file: "example.ts", line: 1, col: 1, rule: "floatingEffect", severity: "warning", message: "",
  };
  const mismatch = { reference: warning, candidate: { ...warning, severity: "error" } };
  if (!matchingTags(tags, "import-namespace", warning.rule).some(({ anchor }) => anchor === "package-manifest")
    || classify(tags, "import-namespace", mismatch).classification !== "new") {
    throw new ClassifierSelfTestError("Expected a namespace-import severity mismatch with package-manifest coverage to be new.");
  }
  const inherited = classify(tags, "extends-plugin", mismatch);
  if (inherited.classification !== "listed" || !inherited.listedBy.includes("extends-severity-merge")) {
    throw new ClassifierSelfTestError("Expected the inherited floatingEffect warning-to-error mismatch to be listed.");
  }
}

function writeRepro(finding: Finding, sample: Case, fixture: Fixture): string {
  const directory = join(artifactDirectory, "differential-repros", finding.mechanism);
  const target = join(directory, sample.file);
  const files = [sample.file];
  if (sample.reexport) files.push(join(dirname(sample.file), "effect-api.ts"));
  if (fixture.name === "global-error") files.push("globals.d.ts");
  if (fixture.name === "rule-configuration") {
    files.push(...specialCases["rule-configuration"].map(({ file }) => file).filter((file) => file !== sample.file));
  }
  for (const file of files) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    copyFileSync(join(fixture.directory, file), join(directory, file));
  }
  const config = JSON.parse(readFileSync(fixture.tsconfig, "utf8"));
  json(join(directory, "tsconfig.json"), { ...config, files });
  if (config.extends) copyFileSync(join(fixture.directory, config.extends), join(directory, config.extends));
  copyFileSync(join(fixture.directory, "package.json"), join(directory, "package.json"));
  return relative(artifactDirectory, target);
}

function formatOverloadEvidence(compiler: Diagnostic[], oxlint: Diagnostic[], bun: Diagnostic[]): string[] {
  const format = ({ sample, sites }: ReturnType<typeof overloadProbe>, diagnostics: Diagnostic[]) => {
    return sites.map(({ line, syncColumn, subjectColumn }) => {
      const reports = diagnostics.filter((diagnostic) => diagnostic.fixture === "single-config"
        && diagnostic.file === `/.src/${sample.file}` && diagnostic.line === line
        && diagnostic.rule === "lazyPromiseInEffectSync");
      return reports.map(({ col }) => col === syncColumn ? "Effect.sync"
        : col === subjectColumn ? "subject call" : `column ${col}`).sort().join(", ") || "none";
    });
  };
  const rows = overloadProbes.flatMap((probe) => {
    const { sample, sites } = probe;
    const [direct, reference, candidate] = [compiler, oxlint, bun].map((diagnostics) => format(probe, diagnostics));
    return sites.map(({ form }, index) => {
      const location = reference[index] !== candidate[index] ? "differs"
        : reference[index] === "none" ? "both silent" : "same";
      return `| ${sample.fixture} | ${basename(sample.file, ".ts")} | ${form} | ${direct[index]} | ${reference[index]} | ${candidate[index]} | ${location} |`;
    });
  });
  return [
    "## Declaration-level pipeable signature probes", "",
    "The fixture forms retain the reference overloads with Promise-thunk results. The inline and substituted variants differ only in where the data-last conditional branches are declared.",
    "An Effect.sync location identifies a pipeline with a preceding normalized step. A subject call location identifies an unflattened input. Both silent means neither linter emitted the target diagnostic.", "",
    "| Reference fixture | Variant | Form | Compiler | Oxlint | Bun | Oxlint/Bun location |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows, "",
  ];
}

function formatGapEvidence(
  kinds: Map<string, Case[]>,
  compiler: Map<string, Diagnostic[]>,
  oxlint: Map<string, Diagnostic[]>,
  bun: Map<string, Diagnostic[]>,
  angleAssertions: number,
  skippedTsx: string[],
): string[] {
  const count = (subject: Map<string, Diagnostic[]>, mode: Mode, rule: string, path?: string) =>
    (subject.get(mode) ?? []).filter((diagnostic) => diagnostic.rule === rule
      && (path === undefined || diagnostic.file === `/.src/${path}`)).length;
  const evidence = (mode: Mode, rule: string, path?: string) =>
    `compiler ${count(compiler, mode, rule, path)}, Oxlint ${count(oxlint, mode, rule, path)}, Bun ${count(bun, mode, rule, path)}`;
  const globalRules = ["globalErrorInEffectFailure", "globalErrorInEffectCatch"];
  const overrides = specialCases["rule-configuration"].map(({ file }) =>
    `${file}: ${evidence("rule-configuration", "floatingEffect", file)}`);
  const [generated, app] = specialCases["rule-configuration"].map(({ file }) =>
    count(compiler, "rule-configuration", "floatingEffect", file));
  const initializers = kinds.get("floating-statement-hook") ?? [];
  const initializerReports = (subject: Map<string, Diagnostic[]>, { file, probeLine }: Case) =>
    (subject.get("single-config") ?? []).some((diagnostic) => diagnostic.file === `/.src/${file}`
      && diagnostic.line === probeLine && diagnostic.rule === "floatingEffect");
  const silent = initializers.filter((sample) => !initializerReports(oxlint, sample) && !initializerReports(bun, sample));
  return [
    "## Five previously uncovered cases", "",
    ...globalRules.map((rule) =>
      `- \`global-error\` with project-supplied Error, ${rule}: ${evidence("global-error", rule)}.`
      + (count(oxlint, "global-error", rule) ? "" : " Oxlint emitted no target diagnostic to compare.")),
    `- \`rule-configuration\` compares directly against the compiler to exercise its scoped severity resolver. ${overrides.join("; ")}.`
    + (generated === 0 && app === 1 ? "" : " The compiler did not show the expected generated/app contrast."),
    `- \`package-manifest\` runs ${kinds.get("package-manifest")?.length ?? 0} seed variants through a directory alias to the installed Effect package.`,
    `- \`checker-type-query\` runs ${kinds.get("checker-type-query")?.length ?? 0} TSX copies and excludes ${angleAssertions} seeds with angle-bracket assertions.`,
    ...(skippedTsx.length ? [`  These copies still failed TSX parsing: ${skippedTsx.join(", ")}.`] : []),
    initializers.length
      ? `- \`floating-statement-hook\` runs ${initializers.length} variants. Both linters stayed silent on the initializer in ${silent.length} of them.`
      : "- `floating-statement-hook` has 0 cases. No seed in the pinned corpus has a classic `for` loop, so the initializer mutation is out of reach.",
    "",
  ];
}

try {
  const tags = documentedMechanisms();
  checkClassifier(tags);
  const { cases, angleAssertions, catchSeeds, skippedTsx, virtualSeeds } = generateCases();
  const allCases = [...cases, ...relationCases, ...Object.values(specialCases).flat()];
  const byFile = new Map(allCases.map((item) => [`/.src/${item.file}`, item]));
  const optionalPipeCases = cases.filter(({ kind }) => kind === optionalPipeReceiverKind);
  const sharedCases = cases.filter(({ kind }) => kind !== optionalPipeReceiverKind);
  const projects = modes.map((mode) => {
    if (mode === "global-error" || mode === "rule-configuration") return project(mode, specialCases[mode]);
    if (mode === optionalPipeReceiverKind) return project(mode, optionalPipeCases);
    return project(mode, mode === relationMode ? relationCases : sharedCases);
  });
  exposeReferencePackages(root);
  const compiler = await runPass("compiler", projects, []);
  const oxlint = await runPass("oxlint", projects, []);
  const bun = await runPass("bun", projects, []);
  const failures = [compiler, oxlint, bun].flatMap(({ label, failures }) => failures.map((failure) => `${label}: ${failure}`));
  const compilerDiagnostics = gatedDiagnostics(compiler);
  const oxlintDiagnostics = gatedDiagnostics(oxlint).filter(visible);
  const candidateDiagnostics = gatedDiagnostics(bun).filter(visible);
  const scopedReference = compilerDiagnostics.filter((diagnostic) => diagnostic.fixture === "rule-configuration" && visible(diagnostic));
  // The Unix bridge renders TS compiler warnings as errors. Pair by location
  // with the direct compiler for severity, as the fixture gate does.
  const severity = compareLocations(compilerDiagnostics, oxlintDiagnostics);
  if ([...scopedReference, ...oxlintDiagnostics, ...candidateDiagnostics].some(({ file }) => !byFile.has(file))) {
    failures.push("A gated lint diagnostic could not be mapped to a source case.");
  }
  if (failures.length) {
    json(join(artifactDirectory, "differential-failures.json"), { failures, compiler: compiler.raw, oxlint: oxlint.raw, bun: bun.raw });
    throw new Error(failures.map((failure) => failure.slice(0, 600)).join("\n"));
  }
  const reference = Map.groupBy([
    ...severity.matched.map(({ expected, actual }) => ({ ...actual, severity: expected.severity }))
      .filter((diagnostic) => diagnostic.fixture !== "rule-configuration" && visible(diagnostic)),
    ...severity.extra.filter(({ fixture }) => fixture !== "rule-configuration"),
    ...scopedReference,
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

  const kindCounts = Map.groupBy(allCases, ({ kind }) => kind);
  const mechanisms = [...new Set([
    ...kindCounts.keys(), ...modes, overloadRecovery, "pipe-form", "data-call-form",
    "package-manifest", "checker-type-query", "floating-statement-hook",
  ])].sort();
  for (const mode of modes) {
    const { agreements, differences } = compare(reference.get(mode) ?? [], candidate.get(mode) ?? []);
    const declaredTypeMove = substitutedConditionalMove(differences);
    const recoveryMoves = mode === "single-config" || mode === "extends-plugin"
      ? missingContextPipeMoves(differences, byFile) : new Set<Difference>();
    for (const agreement of agreements) {
      const kind = byFile.get(agreement.file)!.kind;
      tally(mode === "single-config" || mode === relationMode ? kind : mode, agreement.rule, "agreements");
    }
    for (const difference of differences) {
      const { file, rule } = (difference.reference ?? difference.candidate)!;
      const sample = byFile.get(file)!;
      const key = disagreementKey(difference);
      if (mode === "single-config") controlDifferences.add(key);
      const recoveryMove = recoveryMoves.has(difference);
      const defaultMechanism = mode === relationMode || controlDifferences.has(key) ? sample.kind : mode;
      const mechanism = recoveryMove ? overloadRecovery : defaultMechanism;
      const applicableTags = mechanism === pipeableDeclaredTypes && !declaredTypeMove.includes(difference) ? [] : tags;
      const result = classify(applicableTags, mechanism, difference, recoveryMove ? earlierPipeStage : undefined);
      const finding: Finding = { ...difference, mode, mechanism, seed: sample.fixture, ...result };
      findings.push(finding);
      tally(mechanism, rule, finding.classification);
      if (finding.classification === "listed") continue;
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
  type Counts = { new: number; listed: number; agreements: number };
  const sumCounts = (rows: Iterable<Counts>) => Array.from(rows).reduce(
    (sum, row) => ({ new: sum.new + row.new, listed: sum.listed + row.listed, agreements: sum.agreements + row.agreements }),
    { new: 0, listed: 0, agreements: 0 },
  );
  const totals = sumCounts(Array.from(counts.values()).flatMap((rows) => Array.from(rows.values())));
  const directions = Map.groupBy(cases.filter(({ direction }) => direction), ({ direction }) => direction);
  const mechanismRows = mechanisms.map((mechanism) => {
    const { new: unlisted, listed, agreements } = sumCounts(counts.get(mechanism)?.values() ?? []);
    return `| ${mechanism} | ${unlisted} | ${listed} | ${agreements} |`;
  });
  const rows = mechanisms.flatMap((mechanism) => [...gatedBunRules].map((rule) => {
    const row = counts.get(mechanism)?.get(rule);
    const coverage = [...new Set(matchingTags(tags, mechanism, rule).map(({ anchor }) => anchor))].join(", ");
    return `| ${mechanism} | ${rule} | ${row?.new ?? 0} | ${row?.listed ?? 0} | ${row?.agreements ?? 0} | ${coverage} |`;
  }));
  const optionalProbeFile = optionalPipeCases.find(({ fixture }) => fixture === optionalPipeProbeName)!.file;
  const catchCases = optionalPipeCases.filter(({ fixture }) => catchSeeds.has(fixture));
  const catchFiles = new Set(catchCases.map(({ file }) => `/.src/${file}`));
  const optionalDiagnostics = (pass: Map<string, Diagnostic[]>, rule: string) =>
    (pass.get(optionalPipeReceiverKind) ?? []).filter((item) => item.rule === rule);
  const optionalProbeCount = (pass: Map<string, Diagnostic[]>) =>
    optionalDiagnostics(pass, "effectTryWithoutCatch").filter(({ file }) => file === `/.src/${optionalProbeFile}`).length;
  const catchCount = (pass: Map<string, Diagnostic[]>) =>
    optionalDiagnostics(pass, "catchUnfailableEffect").filter(({ file }) => catchFiles.has(file)).length;
  const catchReferenceCount = catchCount(reference);
  const expectedTypeEvidence = [...expectedTypeMutations, runtimeProbe].map(({ kind }) => {
    const files = new Set((kindCounts.get(kind) ?? []).map(({ file }) => `/.src/${file}`));
    const rule = kind === runtimeProbe.kind ? "runEffectInsideEffect" : "effectInVoidSuccess";
    const reports = (diagnostics: Diagnostic[]) => diagnostics.filter((item) =>
      item.fixture === "single-config" && item.rule === rule && files.has(item.file))
      .map(({ line, col }) => `${line}:${col}`).join(", ") || "none";
    return `| ${kind} | ${reports(compilerDiagnostics)} | ${reports(oxlintDiagnostics)} | ${reports(candidateDiagnostics)} |`;
  });
  const relationEvidence = relationCases.map(({ kind, expectedRule, expectedReports = 1, file }) => {
    const reports = (diagnostics: Diagnostic[]) => diagnostics.filter((item) =>
      item.fixture === relationMode && item.rule === expectedRule && item.file === `/.src/${file}`);
    const [direct, lint, candidate] = [compilerDiagnostics, oxlintDiagnostics, candidateDiagnostics].map(reports);
    const locations = (items: Diagnostic[]) => items.map(({ line, col }) => `${line}:${col}`).join(", ") || "none";
    return {
      row: `| ${kind} | ${expectedRule} | ${locations(direct)} | ${locations(lint)} | ${locations(candidate)} |`,
      covered: direct.length === expectedReports && lint.length === expectedReports,
    };
  });
  const uncoveredRelations = relationEvidence.filter(({ covered }) => !covered).length;
  json(join(artifactDirectory, "differential-differences.json"), findings);
  publish([
    "Classifier self-test passed.",
    `Gated rules: ${[...gatedBunRules].join(", ")}.`, "",
    `Corpus: ${kindCounts.get("single-config")!.length} seed files and ${sharedCases.length - kindCounts.get("single-config")!.length} mutations, plus ${sharedCases.filter(({ reexport }) => reexport).length} local re-export files, in each shared-corpus project. The noLib, scoped override, optional receiver and strict relation-position projects run separately.`,
    ...(virtualSeeds.length ? [
      `Virtual-file fixtures remain in the fixture gate: ${virtualSeeds.join(", ")}.`,
    ] : []),
    `One site per eligible seed, mutation and rewrite direction. Candidate build run: ${process.env.BUN_BUILD_RUN ?? "unspecified"}.`,
    `Pipe rewrites per direction: ${(["function-to-method", "method-to-function", "first-to-last", "last-to-first"] as const)
      .map((direction) => `${direction} ${directions.get(direction)?.length ?? 0}`).join(", ")}.`,
    `Optional pipe receivers: ${optionalPipeCases.length} cases with strict null checks. On the final Effect.try probe, Oxlint emitted ${optionalProbeCount(reference)} target reports and Bun emitted ${optionalProbeCount(candidate)}.`,
    catchCases.length
      ? `Optional receiver coverage for catchUnfailableEffect: ${catchCases.map(({ fixture }) => fixture).join(", ")}. Oxlint emitted ${catchReferenceCount} target reports and Bun emitted ${catchCount(candidate)}.`
        + (catchReferenceCount === 0 ? " These variants give the rule no positive diagnostic coverage." : "")
      : "Optional receivers do not cover catchUnfailableEffect because its seeds have no eligible .pipe receiver.",
    "",
    `Pass times: Oxlint ${oxlint.wallSeconds.toFixed(2)} s, Bun ${bun.wallSeconds.toFixed(2)} s, compiler severity lookup ${compiler.wallSeconds.toFixed(2)} s.`, "",
    ...(severity.extra.length ? [
      `Oxlint emitted ${severity.extra.length} diagnostics without matching compiler locations. Those use the Unix output severity.`, "",
    ] : []),
    "Agreements count identical visible diagnostic tuples. A severity change at one location counts as one disagreement.",
    "A listed difference matches a documented prediction for its mechanism, rule, and outcome.",
    "The declaration-level pipeable tags cover the paired warning move on the substituted data-first probe.",
    "A disagreement repeated in the inherited config is counted under its original mutation. Agreements there appear under the config name.", "",
    ...formatGapEvidence(
      kindCounts, Map.groupBy(compilerDiagnostics, ({ fixture }) => fixture),
      Map.groupBy(oxlintDiagnostics, ({ fixture }) => fixture), candidate, angleAssertions, skippedTsx,
    ),
    ...formatOverloadEvidence(compilerDiagnostics, oxlintDiagnostics, candidateDiagnostics),
    "## Expected type and runtime probes", "",
    "| Mechanism | Compiler locations | Oxlint locations | Bun locations |",
    "| --- | --- | --- | --- |",
    ...expectedTypeEvidence, "",
    "## Strict relation positions", "",
    `The ${relationCases.length} cases expect one reference diagnostic each, with two for the explicitly annotated conditional return. Cases with unexpected reference counts: ${uncoveredRelations}.`, "",
    "| Position | Rule | Compiler locations | Oxlint locations | Bun locations |",
    "| --- | --- | --- | --- | --- |",
    ...relationEvidence.map(({ row }) => row), "",
    "| Mechanism | New | Listed | Agreements |",
    "| --- | ---: | ---: | ---: |",
    ...mechanismRows,
    `| **Total** | **${totals.new}** | **${totals.listed}** | **${totals.agreements}** |`, "",
    "| Mechanism | Rule | New | Listed | Agreements | Documented coverage |",
    "| --- | --- | ---: | ---: | ---: | --- |",
    ...rows,
    `| **Total** | | **${totals.new}** | **${totals.listed}** | **${totals.agreements}** | |`, "",
    "## Smallest reproductions for new differences", "",
    ...(repros.length ? repros : ["None."]), "",
    "See `differential-differences.json` for each disagreement, its configuration, and the matching difference-list row, if any.",
  ]);
  if (uncoveredRelations) process.exitCode = 1;
  console.log(`Effect differential completed in ${elapsed()} s: ${totals.new} new, ${totals.listed} listed, ${totals.agreements} agreements.`);
} catch (error) {
  if (error instanceof ClassifierSelfTestError) {
    publish([error.message, "The differential stopped before running the linters."], "Classifier self-test failed");
  } else {
    publish(["Report incomplete. See the workflow step log and any `differential-failures.json` in the artifact."]);
  }
  throw error;
} finally {
  rmSync(root, { recursive: true, force: true });
}
