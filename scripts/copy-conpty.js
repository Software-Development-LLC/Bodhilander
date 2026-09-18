/**
 * Windows PTY Post-Pack Script for electron-builder
 *
 * This script runs after electron-builder packs the app (afterPack hook).
 * It copies conpty.dll and OpenConsole.exe to the correct location in the
 * unpacked node-pty directory.
 *
 * The issue: electron-builder's npmRebuild recompiles native modules during
 * packaging, which overwrites the build/Release directory. The post-install.js
 * script that copies conpty.dll runs BEFORE electron-builder's npmRebuild,
 * so the conpty/ subdirectory gets deleted.
 *
 * This script runs AFTER packing, ensuring conpty.dll is in place.
 */

const fs = require('fs');
const path = require('path');

/**
 * chmod +x every node-pty `spawn-helper` in the packed macOS app.
 *
 * Walks the unpacked node-pty prebuilds (and build/Release, if a rebuild ever
 * produces one) and sets 0o755 on each spawn-helper it finds. Idempotent and
 * defensive: a missing directory or an already-executable file is fine.
 */
function chmodMacSpawnHelpers(appOutDir) {
  const nodePty = path.join(
    appOutDir,
    'Bodhilander.app',
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty'
  );

  const candidates = [];
  const prebuilds = path.join(nodePty, 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    for (const entry of fs.readdirSync(prebuilds)) {
      if (entry.startsWith('darwin-')) {
        candidates.push(path.join(prebuilds, entry, 'spawn-helper'));
      }
    }
  }
  // Belt-and-suspenders for a build that did produce build/Release.
  candidates.push(path.join(nodePty, 'build', 'Release', 'spawn-helper'));

  let fixed = 0;
  for (const helper of candidates) {
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log(`  chmod +x ${helper}`);
      fixed++;
    }
  }
  if (fixed === 0) {
    console.warn(`  WARNING: no node-pty spawn-helper found under ${nodePty} to chmod`);
  } else {
    console.log(`node-pty spawn-helper permissions set (${fixed} file(s)).`);
  }
}

exports.default = async function copyConpty(context) {
  const { electronPlatformName, appOutDir } = context;

  // macOS: make node-pty's prebuilt spawn-helper executable.
  //
  // The packaged app uses node-pty's `prebuilds/darwin-<arch>/` binaries
  // (npmRebuild is false, so `build/Release` is never produced). node-pty execs
  // a separate `spawn-helper` alongside pty.node; if that file lands without its
  // +x bit — asar-unpack does not reliably preserve the exec bit on an
  // extension-less binary — every pty.spawn fails with "posix_spawnp failed".
  // Restore it here, BEFORE afterSign runs, so the (now executable) helper is
  // also what gets code-signed. Runs on macOS packing only; Windows falls
  // through to the conpty copy below.
  if (electronPlatformName === 'darwin') {
    chmodMacSpawnHelpers(appOutDir);
    return;
  }

  // Only needed for Windows builds
  if (electronPlatformName !== 'win32') {
    return;
  }

  console.log('Copying conpty.dll for Windows PTY support...');

  // Determine architecture
  const arch = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : 'x64';
  console.log(`  Target architecture: ${arch}`);

  // Source: third_party conpty files in the unpacked node-pty
  const unpackedNodePty = path.join(
    appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty'
  );

  // Find the conpty version folder
  const thirdPartyConpty = path.join(unpackedNodePty, 'third_party', 'conpty');

  if (!fs.existsSync(thirdPartyConpty)) {
    console.error(`  ERROR: third_party/conpty not found at ${thirdPartyConpty}`);
    return;
  }

  const versionFolders = fs.readdirSync(thirdPartyConpty);
  if (versionFolders.length === 0) {
    console.error('  ERROR: No conpty version folders found');
    return;
  }

  const versionFolder = versionFolders[0];
  console.log(`  Found conpty version: ${versionFolder}`);

  const sourceDir = path.join(thirdPartyConpty, versionFolder, `win10-${arch}`);

  if (!fs.existsSync(sourceDir)) {
    console.error(`  ERROR: Source directory not found: ${sourceDir}`);
    return;
  }

  // Destination: build/Release/conpty/ in the unpacked node-pty
  const destDir = path.join(unpackedNodePty, 'build', 'Release', 'conpty');

  // Create destination directory
  fs.mkdirSync(destDir, { recursive: true });

  // Copy the required files
  const filesToCopy = ['conpty.dll', 'OpenConsole.exe'];

  for (const file of filesToCopy) {
    const sourcePath = path.join(sourceDir, file);
    const destPath = path.join(destDir, file);

    if (fs.existsSync(sourcePath)) {
      console.log(`  Copying ${file}...`);
      fs.copyFileSync(sourcePath, destPath);
    } else {
      console.warn(`  WARNING: ${file} not found at ${sourcePath}`);
    }
  }

  console.log('conpty.dll copy complete!');
};
