// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/* eslint-disable no-console -- setup helper reports progress directly */
// Installs an autostart entry so the Saturn dashboard launches when the machine starts.
// Windows: writes a launcher to the user's Startup folder (no admin required).
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const dashboardJs = path.resolve(__dirname, '..', 'lib', 'saturnDashboard.js');
const nodeExe = process.execPath;

if (process.platform === 'win32') {
  const appData = process.env.APPDATA;
  if (!appData) {
    console.error('APPDATA is not set; cannot install the autostart entry.');
    process.exit(1);
  }

  const startupDir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  mkdirSync(startupDir, { recursive: true });
  const cmdPath = path.join(startupDir, 'saturn-dashboard.cmd');
  const content = `@echo off\r\nstart "Saturn" /min "${nodeExe}" "${dashboardJs}"\r\n`;
  writeFileSync(cmdPath, content, 'utf8');

  console.log(`Installed Windows autostart: ${cmdPath}`);
  console.log('The Saturn dashboard will launch minimized at logon on http://localhost:6789');
  console.log('To remove it, delete that file.');
} else {
  console.log('Automatic autostart install is implemented for Windows only.');
  console.log(`On macOS/Linux, run "${nodeExe} ${dashboardJs}" from a launchd/systemd unit or your shell profile.`);
}
