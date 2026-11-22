import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve } from "node:path";

const dependencyDirectory = join(import.meta.dir, "fixtures");
const effectPackages = ["effect", "pure-rand", "@standard-schema/spec", "fast-check", "@types/node"];
const vitestPackages = ["vitest", "@vitest/runner", "@effect/vitest"];

const defaultConfig = {
  compilerOptions: {
    skipLibCheck: true,
    plugins: [{
      name: "@effect/language-service",
      ignoreEffectErrorsInTscExitCode: true,
      skipDisabledOptimization: true,
      diagnosticSeverity: {
        experimentalApiUsage: "off",
        unstableApiUsage: "off",
        apiStabilityLeak: "off",
      },
    }],
  },
};

type Unit = { virtualFile: string; content: string };
type FixtureConfig = {
  compilerOptions?: Record<string, unknown>;
  files?: string[];
  include?: string[];
  exclude?: string[];
};

export type Fixture = {
  name: string;
  cwd: string;
  directory: string;
  tsconfig: string;
  rootFiles: string[];
  files: Record<string, string>;
  units: number;
  fixtureConfig: boolean;
  syntheticPackages: boolean;
};

// Match parse_test_units, including how it treats leading blank lines and text
// preceding the first @filename directive.
function splitFixture(name: string, source: string): Unit[] {
  const units: Unit[] = [];
  let file = "";
  let content = "";
  for (const line of source.split(/\r?\n/)) {
    const directive = /^\/\/[\t\f\r ]*@filename[\t\f\r ]*:[\t\f\r ]*(.*)$/i.exec(line);
    if (directive) {
      if (file && content) units.push({ virtualFile: posix.resolve("/.src", file), content });
      file = directive[1].trim();
      content = "";
    } else {
      if (content) content += "\n";
      content += line;
    }
  }
  if (file || content) units.push({ virtualFile: posix.resolve("/.src", file || name), content });
  return units;
}

// Keep package installs shared. When a fixture provides part of a package,
// merge the remaining files into that fixture's private package directory.
function mountPackage(source: string, destination: string): void {
  const sourceStat = statSync(source);
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(source, destination, sourceStat.isDirectory() ? "dir" : "file");
    return;
  }
  if (sourceStat.isDirectory() && statSync(destination).isDirectory()) {
    for (const entry of readdirSync(source)) {
      mountPackage(join(source, entry), join(destination, entry));
    }
  }
}

export function layOutFixture(name: string, source: string, root: string): Fixture {
  const units = splitFixture(name, source);
  const cwd = join(root, "src");
  mkdirSync(cwd, { recursive: true });

  // Preserve Effect's virtual paths for diagnostics. A visible source directory
  // lets the subject linters discover it during their directory walk.
  const place = (file: string) => file.startsWith("/.src/")
    ? join(cwd, file.slice("/.src/".length))
    : join(root, file.slice(1));
  writeFileSync(join(cwd, "package.json"), readFileSync(join(dependencyDirectory, "package.json")));

  let configUnit: Unit | undefined;
  const rootFiles: string[] = [];
  const files: Record<string, string> = {};
  let syntheticPackages = false;
  for (const unit of units) {
    const file = place(unit.virtualFile);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, unit.content);
    files[file] = unit.virtualFile;

    if (unit.virtualFile.startsWith("/node_modules/")) {
      syntheticPackages = true;
    } else if (["tsconfig.json", "jsconfig.json"].includes(basename(file).toLowerCase())) {
      configUnit = unit;
    } else {
      rootFiles.push(file);
    }
  }

  const packages = source.includes("vitest") ? [...effectPackages, ...vitestPackages] : effectPackages;
  for (const name of packages) {
    mountPackage(join(dependencyDirectory, "node_modules", name), join(root, "node_modules", name));
  }
  const tsconfig = configUnit ? place(configUnit.virtualFile) : join(cwd, "tsconfig.json");
  const directory = dirname(tsconfig);
  const config = configUnit ? Bun.JSONC.parse(configUnit.content) as FixtureConfig : defaultConfig;
  const { compilerOptions, include, exclude, files: originalFiles, ...rest } = config;
  const effectiveConfig = {
    ...rest,
    compilerOptions: {
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      ...compilerOptions,
      newLine: "lf",
      skipLibCheck: true,
      skipDefaultLibCheck: true,
      noErrorTruncation: true,
    },
    files: rootFiles.map((file) => relative(directory, file)),
  };
  writeFileSync(tsconfig, JSON.stringify(effectiveConfig, null, 2) + "\n");
  return { name, cwd, directory, tsconfig, rootFiles, files, units: units.length, fixtureConfig: !!configUnit, syntheticPackages };
}

export function discoverFixtures(sourceDirectory: string): string[] {
  return readdirSync(resolve(sourceDirectory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
}
