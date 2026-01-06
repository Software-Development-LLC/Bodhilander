/**
 * macOS Notarization Script for electron-builder
 *
 * This script is called after the app is signed (via afterSign hook).
 * It submits the app to Apple's notarization service, waits for approval,
 * and staples the notarization ticket to the app.
 *
 * Required environment variables:
 *   APPLE_ID                    - Your Apple ID email
 *   APPLE_APP_SPECIFIC_PASSWORD - App-specific password from appleid.apple.com
 *   APPLE_TEAM_ID               - Your 10-character Apple Team ID
 */

const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  // Only notarize macOS builds
  if (electronPlatformName !== 'darwin') {
    return;
  }

  // Skip notarization if credentials are not provided (local dev builds)
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.log('Skipping notarization: Apple credentials not provided');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`Notarizing ${appPath}...`);

  try {
    await notarize({
      appBundleId: 'com.claudelander.app',
      appPath: appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });
    console.log('Notarization complete!');
  } catch (error) {
    console.error('Notarization failed:', error);
    throw error;
  }
};
