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

exports.default = async function copyConpty(context) {
  const { electronPlatformName, appOutDir } = context;

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
