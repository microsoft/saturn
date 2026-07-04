// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/* eslint-disable no-console -- deploy helper reports progress and actionable failures directly */
// Deploys Saturn to a self-contained folder OUTSIDE the source repo (default C:\saturn on Windows) so the
// running dashboard/agent has no dependency on the repo working tree (which may be renamed or moved).
//   1. Bundle src/saturnDashboard.ts and src/start.ts (with all deps, incl. zod) into single CJS files.
//   2. Write a hidden VBS launcher in the deploy folder.
//   3. Repoint the Windows logon autostart at the deployed launcher.
// The REVIEW CONTEXT is unaffected: the agent still uses its managed clone of the target repo (computed
// from the home dir at runtime), independent of this folder.
const {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const srcDir = path.join(packageRoot, "src");
const defaultDeployDir =
  process.platform === "win32"
    ? path.join("C:\\", "saturn")
    : path.join(os.homedir(), "saturn");
const deployDir = process.env.SATURN_DEPLOY_DIR ?? defaultDeployDir;
const managedCloneDir =
  process.platform === "win32"
    ? path.join("C:\\", "saturn", "repo", "<repo>")
    : path.join(os.homedir(), "saturn", "repo", "<repo>");
const nodeExe = process.execPath;

mkdirSync(deployDir, { recursive: true });

console.log("[1/3] Bundling Saturn into self-contained files...");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- build-time only, esbuild is hoisted
const { buildSync } = require("esbuild");
const bundles = [
  {
    entry: path.join(srcDir, "saturnDashboard.ts"),
    out: "saturnDashboard.cjs",
  },
  { entry: path.join(srcDir, "start.ts"), out: "saturn-cli.cjs" },
  { entry: path.join(srcDir, "fixStart.ts"), out: "saturn-autopilot.cjs" },
];
for (const bundle of bundles) {
  buildSync({
    entryPoints: [bundle.entry],
    outfile: path.join(deployDir, bundle.out),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    legalComments: "none",
    logLevel: "warning",
  });
  console.log(
    `  bundled ${path.basename(bundle.entry)} -> ${path.join(deployDir, bundle.out)}`,
  );
}

// Copy the Chart.js UMD bundle (from the chart.js npm package) next to the deployed bundle so the dashboard
// serves it from /vendor/ (no external CDN). Walks up from the package root to find a hoisted node_modules,
// and accepts either the pre-minified UMD or the plain UMD (older chart.js doesn't ship chart.umd.min.js).
function findChartUmd(startDir) {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    for (const name of ["chart.umd.min.js", "chart.umd.js"]) {
      const candidate = path.join(
        dir,
        "node_modules",
        "chart.js",
        "dist",
        name,
      );
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}
const sourceChartJs = findChartUmd(packageRoot);
const deployedChartJs = path.join(deployDir, "chart.umd.min.js");
if (sourceChartJs) {
  copyFileSync(sourceChartJs, deployedChartJs);
  console.log(
    `  bundled ${path.basename(sourceChartJs)} (chart.js npm) -> ${deployedChartJs}`,
  );
} else {
  console.warn(
    "  WARNING: chart.js not found in node_modules - the dashboard will use the inline-SVG fallback.",
  );
}

// Copy the mermaid UMD bundle next to the deployed bundle so the dashboard serves it from
// /vendor/mermaid.min.js (self-hosted, no external CDN) for the Chat tab's design-doc diagrams.
function findMermaidUmd(startDir) {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, "node_modules", "mermaid", "dist", "mermaid.min.js");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}
const sourceMermaid = findMermaidUmd(packageRoot);
const deployedMermaid = path.join(deployDir, "mermaid.min.js");
if (sourceMermaid) {
  copyFileSync(sourceMermaid, deployedMermaid);
  console.log(`  bundled mermaid.min.js (mermaid npm) -> ${deployedMermaid}`);
} else {
  console.warn(
    "  WARNING: mermaid not found in node_modules - Chat design-doc diagrams will fall back to the CDN.",
  );
}

// Copy the docs folder + README next to the bundle so the dashboard's Documentation tab can read them at runtime.
const sourceDocsDir = path.join(packageRoot, "docs");
const deployedDocsDir = path.join(deployDir, "docs");
if (existsSync(sourceDocsDir)) {
  rmSync(deployedDocsDir, { recursive: true, force: true });
  cpSync(sourceDocsDir, deployedDocsDir, { recursive: true });
  console.log(`  copied docs/ -> ${deployedDocsDir}`);
}
const sourceReadme = path.join(packageRoot, "README.md");
if (existsSync(sourceReadme)) {
  copyFileSync(sourceReadme, path.join(deployDir, "README.md"));
  console.log(`  copied README.md -> ${path.join(deployDir, "README.md")}`);
}

// Copy the operator's .env (Saturn's configuration) next to the bundle so config.ts finds it regardless of
// the launcher's working directory. Keep any existing deployed .env if the source repo has none.
const sourceEnvFile = path.join(packageRoot, ".env");
const deployedEnvFile = path.join(deployDir, ".env");
if (existsSync(sourceEnvFile)) {
  copyFileSync(sourceEnvFile, deployedEnvFile);
  console.log(`  copied .env -> ${deployedEnvFile}`);
} else if (existsSync(deployedEnvFile)) {
  console.log(`  kept existing .env at ${deployedEnvFile}`);
} else {
  console.warn(
    `  WARNING: no .env at ${sourceEnvFile} or ${deployedEnvFile} - Saturn will exit on startup until one exists (see .env.example).`,
  );
}

console.log("[2/3] Writing hidden launcher...");
const dashboardBundle = path.join(deployDir, "saturnDashboard.cjs");
const launcherVbs = path.join(deployDir, "saturn-launch.vbs");
const vbsContent = [
  "' Saturn dashboard launcher - starts node fully hidden (no console window)",
  'Set sh = CreateObject("WScript.Shell")',
  `cmd = Chr(34) & "${nodeExe}" & Chr(34) & " " & Chr(34) & "${dashboardBundle}" & Chr(34)`,
  "sh.Run cmd, 0, False",
  "",
].join("\r\n");
writeFileSync(launcherVbs, vbsContent, "ascii");
console.log(`  wrote ${launcherVbs}`);

console.log("[3/3] Repointing logon autostart...");
if (process.platform === "win32") {
  const appData = process.env.APPDATA;
  if (!appData) {
    console.warn("  APPDATA not set; skipped autostart registration.");
  } else {
    const startupDir = path.join(
      appData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
    );
    mkdirSync(startupDir, { recursive: true });
    // Remove any prior autostart entries (including ones that pointed back into the repo).
    for (const stale of ["saturn-dashboard.cmd", "saturn-dashboard.vbs"]) {
      const stalePath = path.join(startupDir, stale);
      if (existsSync(stalePath)) {
        rmSync(stalePath, { force: true });
      }
    }
    copyFileSync(launcherVbs, path.join(startupDir, "saturn-dashboard.vbs"));
    console.log(
      `  autostart -> ${path.join(startupDir, "saturn-dashboard.vbs")}`,
    );
  }
} else {
  console.log(
    "  autostart auto-registration is Windows-only; run the launcher from your service manager.",
  );
}

console.log(`\nDeployed Saturn to: ${deployDir}`);
console.log(`Review context (managed clone) stays at: ${managedCloneDir}`);
console.log(
  "Start it now (detached) with the hidden launcher, or it will start at next logon.",
);
