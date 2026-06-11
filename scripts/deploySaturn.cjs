/* eslint-disable no-console -- deploy helper reports progress and actionable failures directly */
// Deploys Saturn to a self-contained folder OUTSIDE the source repo (default C:\saturn on Windows) so the
// running dashboard/agent has no dependency on the repo working tree (which may be renamed or moved).
//   1. Bundle src/saturnDashboard.ts and src/start.ts (with all deps, incl. zod) into single CJS files.
//   2. Write a hidden VBS launcher in the deploy folder.
//   3. Repoint the Windows logon autostart at the deployed launcher.
// The REVIEW CONTEXT is unaffected: the agent still uses the managed clone at
// ~/Documents/code/office-bohemia (computed from the home dir at runtime), independent of this folder.
const {
  copyFileSync,
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
const repoName = process.env.SATURN_ADO_REPO_NAME ?? "office-bohemia";
const managedCloneDir =
  process.platform === "win32"
    ? path.join("C:\\", "saturn", "repo", repoName)
    : path.join(os.homedir(), "saturn", "repo", repoName);
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
