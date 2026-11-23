import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type Range = [number, number];
type Node = { type: string; range: Range; parent?: Node };
type Identifier = Node & { name: string };
type ImportSpecifier = Node & { local: Identifier; imported?: Identifier; importKind?: string };
type Import = Node & {
  source: Node & { value: string };
  specifiers: ImportSpecifier[];
  importKind?: string;
  attributes: Node[];
};
type Member = Node & { object: Node; property: Identifier; computed: boolean; optional: boolean };
type Call = Node & { callee: Node; arguments: Node[]; optional: boolean };
type FunctionNode = Node & { params: Array<Node & { typeAnnotation?: Node }> };
type Program = Node & { body: Node[] };
type SourceCode = {
  text: string;
  getAllComments(): Array<Node & { value: string }>;
  getDeclaredVariables(node: Node): Array<{ references: Array<{ identifier: Identifier }> }>;
};

export type Mutation = {
  kind: string;
  source: string;
  direction?: "function-to-method" | "method-to-function" | "first-to-last" | "last-to-first";
  reexport?: string;
  extension?: "tsx";
  probeLine?: number;
};
type Edit = { range: Range; text: string };
type Proposal = Omit<Mutation, "source" | "probeLine"> & { edits: Edit[]; focus: Range; probeOffset?: number };

export const effectAlias = "effect-differential-alias";

const seed = 2431;
export function rank(value: string): number {
  let hash = seed;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function applyEdits(source: string, edits: Edit[]): string {
  for (const { range: [start, end], text } of [...edits].sort((a, b) => b.range[0] - a.range[0])) {
    source = source.slice(0, start) + text + source.slice(end);
  }
  return source;
}

// Restrict optional calls to imported, non-nullable v4 methods used as values in
// the fixtures. Resolving references also excludes a shadowed Effect binding.
const optionalMethods = new Set(["succeed", "fail", "sync", "gen", "try", "tryPromise", "log", "die", "promise"]);
// These constructors always supply a Pipeable receiver. A standalone function
// or a value in a point-free constructor fixture need not have a .pipe method.
const effectConstructors = new Set(["succeed", "fail", "sync", "suspend", "gen", "try", "tryPromise", "log", "die", "promise"]);
const effectValues = new Set(["void", "never"]);
const dualMethods = new Set(["map", "mapError", "flatMap", "andThen", "tap", "catch"]);

export function mutationVisitor(
  sourceCode: SourceCode, fixture: string, diagnosticOffsets: number[], save: (mutations: Mutation[]) => void,
) {
  const source = sourceCode.text;
  const text = ({ range: [start, end] }: Node) => source.slice(start, end);
  const proposals: Proposal[] = [];
  const effectReferences = new Set<number>();
  const pipeReferences = new Set<number>();
  const comments = sourceCode.getAllComments();
  let hasAngleAssertion = false;

  function propose(
    kind: string, node: Node, replacement: string, focus = node.range, direction?: Mutation["direction"],
  ): void {
    proposals.push({ kind, edits: [{ range: node.range, text: replacement }], focus, direction });
  }

  function imports(program: Program): void {
    const aliasEdits: Edit[] = [];
    for (const node of program.body) {
      if (node.type !== "ImportDeclaration") continue;
      const declaration = node as Import;
      if (declaration.importKind === "type" || declaration.attributes.length) continue;
      const from = declaration.source.value;
      if (from === "effect" || from.startsWith("effect/")) {
        aliasEdits.push({
          range: declaration.source.range,
          text: JSON.stringify(effectAlias + from.slice("effect".length)),
        });
      }
      if (from === "effect" || from === "effect/Function") {
        for (const specifier of declaration.specifiers) {
          if (specifier.importKind === "type" || specifier.imported?.name !== "pipe") continue;
          for (const { references } of sourceCode.getDeclaredVariables(specifier)) {
            for (const { identifier } of references) pipeReferences.add(identifier.range[0]);
          }
        }
      }
      const binding = declaration.specifiers.find((specifier) => specifier.importKind !== "type" && (
        (from === "effect" && specifier.imported?.name === "Effect")
        || (from === "effect/Effect" && specifier.type === "ImportNamespaceSpecifier")
      ));
      if (!binding) continue;
      const references = sourceCode.getDeclaredVariables(binding).flatMap(({ references }) =>
        references.map(({ identifier }) => identifier));
      for (const reference of references) effectReferences.add(reference.range[0]);

      const local = binding.local.name;
      const named = local === "Effect" ? "Effect" : `Effect as ${local}`;
      if (from === "effect" && declaration.specifiers.every(({ type }) => type === "ImportSpecifier")
        && !/\/\*|\/\//.test(text(declaration))) {
        const rest = declaration.specifiers.filter((specifier) => specifier !== binding);
        const otherImports = rest.length ? `import { ${rest.map(text).join(", ")} } from "effect"\n` : "";
        propose("import-namespace", declaration, `${otherImports}import * as ${local} from "effect/Effect"`);
      }
      if (from === "effect/Effect") {
        propose("import-root", declaration, `import { ${named} } from "effect"`);
      }
      if (references.length && !/\bE\b/.test(source) && references.every(({ parent }) =>
        parent?.type !== "ExportSpecifier" && !(parent?.type === "Property" && (parent as Node & { shorthand: boolean }).shorthand))) {
        const replacement = binding.imported?.range[0] === binding.local.range[0] ? "Effect as E" : "E";
        proposals.push({
          kind: "rename-import",
          edits: [
            { range: binding.local.range, text: replacement },
            ...references.map(({ range }) => ({ range, text: "E" })),
          ],
          focus: program.range,
        });
      }
      if (from === "effect") {
        for (const [kind, reexport] of [
          ["reexport-star", 'export * from "effect"'],
          ["reexport-named", 'export { Effect } from "effect"'],
        ]) {
          if (kind === "reexport-named" && declaration.specifiers.length !== 1) continue;
          proposals.push({
            kind, edits: [{ range: declaration.source.range, text: '"./effect-api"' }],
            focus: program.range, reexport,
          });
        }
      }
    }
    if (aliasEdits.length) proposals.push({ kind: "package-manifest", edits: aliasEdits, focus: program.range });
  }

  function effectMember(node: Node): Member | undefined {
    if (node.type !== "MemberExpression") return;
    const member = node as Member;
    if (!member.computed && !member.optional && member.object.type === "Identifier"
      && effectReferences.has(member.object.range[0])) return member;
  }

  function effectValue(node: Node): boolean {
    if (node.type !== "CallExpression") {
      const member = effectMember(node);
      return !!member && effectValues.has(member.property.name);
    }
    const call = node as Call;
    const member = effectMember(call.callee);
    return !!member && !call.optional && effectConstructors.has(member.property.name);
  }

  function importAtEnd(specifier: string): Edit {
    return { range: [source.length, source.length], text: `\nimport { ${specifier} } from "effect"\n` };
  }

  function hasComments(node: Node): boolean {
    const [start, end] = node.range;
    return comments.some(({ range }) => range[0] >= start && range[1] <= end);
  }

  function hasPlainArguments(call: Call): boolean {
    return !call.optional && !call.arguments.some(({ type }) => type === "SpreadElement" || type === "SequenceExpression")
      && /^\s*\(/.test(source.slice(call.callee.range[1], call.range[1]));
  }

  function pipeForm(call: Call): void {
    if (!hasPlainArguments(call) || hasComments(call)) return;
    const [subject, ...steps] = call.arguments;
    if (call.callee.type === "Identifier" && pipeReferences.has(call.callee.range[0])
      && steps.length && effectValue(subject)) {
      propose("pipe-form", call, `${text(subject)}.pipe(${steps.map(text).join(", ")})`, call.range, "function-to-method");
    }
    if (call.callee.type !== "MemberExpression" || !subject || /\b__effectDifferentialPipe\b/.test(source)) return;
    const member = call.callee as Member;
    if (member.computed || member.optional || member.property.name !== "pipe" || !effectValue(member.object)) return;
    proposals.push({
      kind: "pipe-form",
      direction: "method-to-function",
      edits: [
        { range: call.range, text: `__effectDifferentialPipe(${[member.object, ...call.arguments].map(text).join(", ")})` },
        importAtEnd("pipe as __effectDifferentialPipe"),
      ],
      focus: call.range,
    });
  }

  function dualCallForm(call: Call): void {
    if (!hasPlainArguments(call) || hasComments(call)) return;
    const direct = effectMember(call.callee);
    const [subject, step] = call.arguments;
    if (direct && dualMethods.has(direct.property.name) && call.arguments.length === 2 && effectValue(subject)) {
      // In the curried form callback parameters no longer infer from the
      // receiver. Keep callbacks that carry their own types.
      const callback = step.type === "ArrowFunctionExpression" || step.type === "FunctionExpression";
      const explicit = callback && (step as FunctionNode).params.every(({ typeAnnotation }) => !!typeAnnotation);
      if (explicit || (direct.property.name === "andThen" && effectValue(step))) {
        propose("data-call-form", call, `${text(direct)}(${text(step)})(${text(subject)})`, call.range, "first-to-last");
      }
    }
    if (call.callee.type !== "CallExpression" || call.arguments.length !== 1 || !effectValue(subject)) return;
    const factory = call.callee as Call;
    const member = effectMember(factory.callee);
    if (member && dualMethods.has(member.property.name) && factory.arguments.length === 1 && hasPlainArguments(factory)) {
      propose("data-call-form", call, `${text(member)}(${text(subject)}, ${text(factory.arguments[0])})`, call.range, "last-to-first");
    }
  }

  function forInitializer(node: Node & { init: Node | null }): void {
    if (/\b__EffectDifferential\b/.test(source)) return;
    const init = node.init;
    // Avoid removing a declaration the condition or body may use.
    if (init?.type === "VariableDeclaration") return;
    const empty = /^for\s*\(\s*(?=;)/.exec(text(node));
    if (!init && !empty) return;
    const at = node.range[0] + (empty?.[0].length ?? 0);
    const range: Range = init?.range ?? [at, at];
    proposals.push({
      kind: "floating-statement-hook",
      edits: [
        { range, text: "__EffectDifferential.succeed(1)" },
        importAtEnd("Effect as __EffectDifferential"),
      ],
      focus: node.range,
      probeOffset: range[0],
    });
  }

  function calls(call: Call): void {
    pipeForm(call);
    dualCallForm(call);
    if (call.optional || call.callee.type !== "MemberExpression") return;
    const member = call.callee as Member;
    const [start, end] = member.range;
    if (member.computed || member.optional || member.object.type !== "Identifier"
      || !effectReferences.has(member.object.range[0])
      || source.slice(call.range[0], start).trim() || !/^\s*\(/.test(source.slice(end, call.range[1]))) return;

    const callee = text(member);
    let outer: Node = call;
    while (outer.parent?.range[0] === start && outer.parent.type !== "Program") outer = outer.parent;
    // A leading parenthesis can join the previous statement in a semicolonless file.
    const separator = outer.type === "ExpressionStatement" ? ";" : "";
    propose("callee-parentheses", member, `${separator}(${callee})`, call.range);
    propose("callee-non-null", member, `${callee}!`, call.range);
    propose("callee-as", member, `${separator}(${callee} as typeof ${callee})`, call.range);
    propose("callee-satisfies", member, `${separator}(${callee} satisfies typeof ${callee})`, call.range);
    if (optionalMethods.has(member.property.name)) {
      propose("optional-call", member, `${callee}?.`, call.range);
    }

    const generator = call.arguments.at(-1) as (Node & { generator?: boolean }) | undefined;
    if (member.property.name !== "gen" || generator?.type !== "FunctionExpression" || !generator.generator) return;
    const hasSelf = call.arguments.length === 2 && call.arguments[0].type === "ObjectExpression"
      && /^\{\s*self:\s*this\s*\}$/.test(text(call.arguments[0]));
    if (hasSelf) {
      propose("generator-fn-this", call, `${text(member.object)}.fn${source.slice(end, call.range[1])}()`);
    } else if (call.arguments.length === 1) {
      propose("generator-fn", call, `${text(member.object)}.fn${source.slice(end, call.range[1])}()`);
      propose("generator-fn-untraced", call, `${text(member.object)}.fnUntraced${source.slice(end, call.range[1])}()`);
    }
  }

  function nesting(program: Program): void {
    for (const statement of program.body) {
      const declaration = statement.type === "ExportNamedDeclaration"
        ? (statement as Node & { declaration: Node | null }).declaration
        : statement;
      // An unannotated const initializer has no contextual type to carry into the new scope.
      if (declaration?.type !== "VariableDeclaration") continue;
      const variable = declaration as Node & { kind: string; declarations: Array<{ id: Node; init: Node | null }> };
      if (variable.kind !== "const") continue;
      for (const { id, init } of variable.declarations) {
        if (id.type !== "Identifier" || (id as Node & { typeAnnotation?: Node }).typeAnnotation
          || init?.type !== "CallExpression") continue;
        const expression = text(init);
        if (/\b(?:await|yield|this|super|arguments|eval)\b/.test(expression)) continue;
        propose("nest-function", init, `(function () { return ${expression} })()`);
        propose("nest-arrow", init, `(() => ${expression})()`);
        propose("nest-class-method", init, `new class { run() { return ${expression} } }().run()`);
        propose("nest-object-method", init, `({ run() { return ${expression} } }).run()`);
      }
    }
  }

  function directives(program: Program): void {
    for (const comment of comments) {
      const value = comment.value.trim().replace(/^\*\s*/, "");
      if (!/^@effect-diagnostics(?:-next-line)?\s+[^\r\n]+$/.test(value)) continue;
      const [start, end] = comment.range;
      const lineStart = source.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = source.indexOf("\n", end);
      if (source.slice(lineStart, start).trim() || source.slice(end, lineEnd < 0 ? source.length : lineEnd).trim()) continue;
      propose("directive-comment", comment, comment.type === "Line" ? `/** ${value} */` : `// ${value}`);

      const suppression = /^@effect-diagnostics\s+(floatingEffect:off)$/.exec(value);
      if (!suppression || comments.some((other) => other.range[0] > end && other.value.includes("@effect-diagnostics"))) continue;
      const tail = program.body.filter((statement) => statement.range[0] >= end);
      // This section can be expressed as next-line suppressions because its
      // entire remaining scope consists of standalone Effect calls.
      if (!tail.length || !tail.every((statement) => statement.type === "ExpressionStatement"
        && /^Effect\.\w+\([^\r\n]*\);?$/.test(text(statement)))) continue;
      const nextLine = `// @effect-diagnostics-next-line ${suppression[1]}`;
      const first = tail[0].range[0];
      if (source.slice(end, first).split("\n").length !== 2) continue;
      proposals.push({
        kind: "directive-scope",
        edits: [
          { range: comment.range, text: nextLine },
          ...tail.slice(1).map(({ range: [offset] }) => ({ range: [offset, offset] as Range, text: nextLine + "\n" })),
        ],
        focus: [start, program.range[1]],
      });
    }
  }

  return {
    Program(program: Program) {
      imports(program);
      nesting(program);
      directives(program);
    },
    CallExpression: calls,
    ForStatement: forInitializer,
    TSTypeAssertion() { hasAngleAssertion = true; },
    "Program:exit"() {
      const choices = Map.groupBy(proposals, ({ kind, direction }) => direction ? `${kind}/${direction}` : kind);
      const distance = ([start, end]: Range) =>
        Math.min(...diagnosticOffsets.map((offset) => Math.max(start - offset, offset - end, 0)));
      const mutations = Array.from(choices, ([variant, options]) => {
        const order = ({ focus }: Proposal) => rank(`${fixture}/${variant}/${focus[0]}`);
        const best = options.sort((a, b) => distance(a.focus) - distance(b.focus) || order(a) - order(b))[0];
        return {
          kind: best.kind,
          direction: best.direction,
          source: applyEdits(source, best.edits),
          reexport: best.reexport,
          probeLine: best.probeOffset === undefined
            ? undefined
            : source.slice(0, best.probeOffset).replace(/^\n+/, "").split("\n").length,
        };
      });
      if (!hasAngleAssertion) mutations.push({ kind: "checker-type-query", source, extension: "tsx" });
      save(mutations);
    },
  };
}

// The locked Oxlint package exposes its TypeScript AST to JS rules. This rule
// generates source files; it does not report lint diagnostics.
export default {
  rules: {
    generate: {
      create(context: { filename: string; sourceCode: SourceCode }) {
        const fixture = basename(context.filename);
        const result = join(process.env.EFFECT_MUTATION_OUTPUT!, fixture + ".json");
        const offsets: number[] = JSON.parse(readFileSync(result, "utf8"));
        return mutationVisitor(context.sourceCode, fixture, offsets, (mutations) => {
          writeFileSync(result, JSON.stringify(mutations));
        });
      },
    },
  },
};
