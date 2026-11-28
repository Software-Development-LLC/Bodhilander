/**
 * electron-builder beforePack hook: a Windows build warns while
 * resources/crew-agent/versions.json still holds a placeholder, and fails when
 * CREW_RELEASE_STRICT=1, as the release workflow sets. The app holds Crew setup
 * at runtime until the pins are real.
 */

const fs = require('fs');
const path = require('path');

const SHA256 = /^[0-9a-f]{64}$/;
const PLACEHOLDER = /^NOT-VERIFIED/;

function placeholders(versions) {
  const found = [];
  const walk = (value, at) => {
    if (typeof value === 'string') {
      if (PLACEHOLDER.test(value)) found.push(at);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) if (!k.startsWith('_')) walk(v, at ? `${at}.${k}` : k);
    }
  };
  walk(versions, '');
  for (const key of ['rootfs', 'node']) {
    const sha = versions?.[key]?.sha256;
    const at = `${key}.sha256`;
    if (!(typeof sha === 'string' && SHA256.test(sha)) && !found.includes(at)) found.push(at);
  }
  return found;
}

function checkCrewVersions(file) {
  const found = placeholders(JSON.parse(fs.readFileSync(file, 'utf8')));
  return found.length ? `WARNING: ${file} still holds placeholders (${found.join(', ')}); this build can't set up Crew on Windows until they are pinned.` : null;
}

module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const warning = checkCrewVersions(path.join(context.packager.projectDir, 'resources', 'crew-agent', 'versions.json'));
  if (!warning) return;
  if (process.env.CREW_RELEASE_STRICT === '1') throw new Error(warning.replace(/^WARNING: /, ''));
  console.warn(warning);
};
module.exports.placeholders = placeholders;
module.exports.checkCrewVersions = checkCrewVersions;
