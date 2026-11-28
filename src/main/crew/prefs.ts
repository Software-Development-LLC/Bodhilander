/** Crew's preferences (the Hub address, the machine id) are written by the main process only. */
const CREW_PREFIX = 'crew.';

export function rendererMayWritePreference(key: string): boolean {
  return !key.startsWith(CREW_PREFIX);
}
