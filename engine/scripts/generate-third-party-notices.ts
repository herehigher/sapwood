// Builds the notice file from the modules emitted by the dashboard's two production bundles.
// Keeping this next to staging makes `npm pack` fail closed if a newly-bundled dependency has no
// distributable licence/copyright notice, rather than leaving a hand-maintained inventory stale.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const engineRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultRepoRoot = dirname(engineRoot);

export interface NoticeDependency {
  name: string;
  version: string;
  copyrightLines: string[];
  licenseText: string;
}

function packageRootForModule(moduleId: string): string | undefined {
  const marker = `${requirePathSeparator()}node_modules${requirePathSeparator()}`;
  const start = moduleId.lastIndexOf(marker);
  if (start === -1) return undefined;
  const rest = moduleId.slice(start + marker.length).split(requirePathSeparator());
  const packageParts = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  if (packageParts.length === 0 || packageParts.some((part) => part === undefined)) return undefined;
  return join(moduleId.slice(0, start + marker.length), ...packageParts);
}

function requirePathSeparator(): string {
  // Build metadata records native filesystem module ids; the release package is built on the
  // platform which generated them. `process.platform` avoids treating a scoped package as a file.
  return process.platform === "win32" ? "\\" : "/";
}

function bundledModuleIds(repoRoot: string): string[] {
  const metadataPaths = [
    join(repoRoot, "dashboard", "dist", "third-party-modules.json"),
    join(repoRoot, "dashboard", "dist-server", "third-party-modules.json"),
  ];
  const modules = new Set<string>();
  for (const path of metadataPaths) {
    if (!existsSync(path)) throw new Error(`dashboard notice generation requires build metadata: ${path}`);
    const ids = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new Error(`invalid dashboard build metadata: ${path}`);
    for (const id of ids) modules.add(id);
  }
  return [...modules].sort();
}

function packageLicenseText(packageRoot: string, manifest: { name: string; license?: unknown; author?: unknown }): string {
  const name = readdirSync(packageRoot).find((entry) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(entry));
  if (name !== undefined) return readFileSync(join(packageRoot, name), "utf8").replaceAll("\r\n", "\n").trim();
  // A few published packages omit their licence file despite declaring an MIT licence. Preserve
  // their published author attribution and the complete canonical MIT text rather than silently
  // omitting an actually-bundled package. Anything less explicit fails the packaging build.
  if (manifest.license !== "MIT" || typeof manifest.author !== "string") {
    throw new Error(`bundled dependency ${manifest.name} has no distributable licence text`);
  }
  return `MIT License\n\nCopyright (c) ${manifest.author}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.`;
}

/** The exact package set in Vite's and esbuild's emitted module graphs, sorted by package name. */
export function bundledDashboardDependencies(repoRoot = defaultRepoRoot): NoticeDependency[] {
  const roots = new Set<string>();
  for (const moduleId of bundledModuleIds(repoRoot)) {
    const root = packageRootForModule(moduleId);
    if (root !== undefined && existsSync(join(root, "package.json"))) roots.add(root);
  }
  if (roots.size === 0) throw new Error("dashboard build metadata contained no node_modules inputs");

  return [...roots]
    .map((root) => {
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown; license?: unknown; author?: unknown };
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") throw new Error(`invalid package manifest: ${root}/package.json`);
      const text = packageLicenseText(root, manifest);
      const copyrightLines = text.split(/\r?\n/).filter((line) => /copyright/i.test(line));
      if (copyrightLines.length === 0) throw new Error(`bundled dependency ${manifest.name} has no copyright line in its licence text`);
      return { name: manifest.name, version: manifest.version, copyrightLines, licenseText: text };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function writeThirdPartyNotices(repoRoot = defaultRepoRoot): NoticeDependency[] {
  const dependencies = bundledDashboardDependencies(repoRoot);
  const fontLicense = dependencies.find((dependency) => dependency.name === "@fontsource-variable/jetbrains-mono")?.licenseText;
  if (fontLicense === undefined) throw new Error("the bundled JetBrains Mono font package is missing from dashboard build metadata");
  const notices = [
    "Sapwood dashboard third-party notices",
    "",
    "This file is generated from the module inputs emitted by Vite and esbuild for the dashboard package.",
    "Vite's optimized SPA output does not retain dependency @license banners; their complete licence texts",
    "and copyright lines are extracted here. Do not edit this file by hand; run the dashboard staging build.",
    "",
    ...dependencies.flatMap((dependency) => [
      `## ${dependency.name}@${dependency.version}`,
      "",
      dependency.licenseText,
      "",
    ]),
    "## Fonts",
    "",
    "JetBrains Mono Variable is bundled from @fontsource-variable/jetbrains-mono above.",
    "Fraunces is Copyright 2018 The Fraunces Project Authors and is licensed under the SIL Open Font License, Version 1.1.",
    "The complete SIL Open Font License, Version 1.1 text is included in the JetBrains Mono notice above.",
    "",
  ].join("\n");
  writeFileSync(join(repoRoot, "engine", "THIRD_PARTY_NOTICES"), notices);
  for (const metadataPath of [join(repoRoot, "dashboard", "dist", "third-party-modules.json"), join(repoRoot, "dashboard", "dist-server", "third-party-modules.json")]) {
    rmSync(metadataPath, { force: true });
  }
  return dependencies;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeThirdPartyNotices();
