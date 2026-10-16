import { EventEmitter } from 'events';

/** Emits 'created' (Session) / 'groupsChanged' when sessions or groups are
 *  created remotely, so the main process can refresh the desktop renderer. */
export const remoteSessionEvents = new EventEmitter();
