/**
 * electron-builder beforePack hook: a Windows build stops while
 * resources/crew-agent/versions.json still holds a placeholder, since that
 * build could never set up Crew on Windows.
 */

const fs = require('fs');
const path = require('path');

const SHA256 = /^[0-9a-f]{64}$/;
const PLACEHOLDER = /^NOT-VERIFIED/;
const ALLOW_ENV = 'BODHILANDER_ALLOW_CREW_PLACEHOLDERS';

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
  if (found.length) throw new Error(`${file} still holds placeholders (${found.join(', ')}); this build can't set up Crew on Windows. Set ${ALLOW_ENV}=1 for a local build only.`);
}

module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32' || process.env[ALLOW_ENV] === '1') return;
  checkCrewVersions(path.join(context.packager.projectDir, 'resources', 'crew-agent', 'versions.json'));
};
module.exports.placeholders = placeholders;
module.exports.checkCrewVersions = checkCrewVersions;
