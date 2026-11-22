export const parityRules = [
  "floatingEffect", "missingEffectError", "missingEffectContext", "missingLayerContext",
  "globalErrorInEffectFailure", "globalErrorInEffectCatch", "unknownInEffectCatch",
  "effectTryWithoutCatch", "tryCatchInEffectGen", "catchUnfailableEffect", "effectInFailure",
  "effectInVoidSuccess", "anyUnknownInErrorContext", "unsafeEffectTypeAssertion",
  "runEffectInsideEffect", "returnEffectInGen", "lazyPromiseInEffectSync",
  "missingStarInYieldEffectGen", "missingReturnYieldStar",
] as const;

export type Diagnostic = {
  fixture: string;
  file: string;
  line: number;
  col: number;
  rule: string;
  severity: string;
  message: string;
};

const typescriptHeader = /^(?:(.+)\((\d+),(\d+)\): )?(error|warning|suggestion|message) TS\d+:\s?(.*)$/;
const effectTag = /\s*effect\((\w+)\)\s*$/;

export type ParsedOutput = { effect: Diagnostic[]; nonEffect: number };

export function parseTypeScript(fixture: string, source: string): ParsedOutput {
  const effect: Diagnostic[] = [];
  let nonEffect = 0;
  let current: { header: RegExpExecArray; lines: string[] } | undefined;
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith("====")) break;
    const header = typescriptHeader.exec(line);
    if (header) {
      current = { header, lines: [header[5]] };
      nonEffect++;
    } else {
      current?.lines.push(line);
    }
    if (!current || !effectTag.test(line)) continue;

    const [, file, row, col, severity] = current.header;
    const message = current.lines.join("\n");
    const tag = effectTag.exec(message)!;
    if (!file) throw new Error(`${fixture}: unlocated Effect diagnostic ${message}`);
    effect.push({
      fixture, file, line: Number(row), col: Number(col),
      severity, rule: tag[1], message: message.slice(0, tag.index),
    });
    nonEffect--;
    current = undefined;
  }
  return { effect, nonEffect };
}

export function baselineTable(diagnostics: Diagnostic[]): string {
  const counts = new Map<string, number>(parityRules.map((rule) => [rule, 0]));
  for (const { rule } of diagnostics) {
    if (counts.has(rule)) counts.set(rule, counts.get(rule)! + 1);
  }
  return [
    "### Effect reference baselines",
    "",
    "| Rule | Diagnostics |",
    "| --- | ---: |",
    ...Array.from(counts, ([rule, count]) => `| ${rule} | ${count} |`),
    `| **Total** | **${Array.from(counts.values()).reduce((sum, count) => sum + count, 0)}** |`,
  ].join("\n");
}
