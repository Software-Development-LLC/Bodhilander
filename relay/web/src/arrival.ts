/**
 * Where a person lands when the app opens, and how the machine picker reads.
 * Apart from main.ts so it can be tested: main.ts pulls in xterm and runs
 * boot() at import time, so nothing in it is reachable from a unit test.
 */

/** The `/api/machines` fields these decisions read. */
export interface ArrivalMachine {
  id: string;
  name: string;
  /** How you reach it. Guests get a certificate; owners get null. */
  relation?: 'owner' | 'grantee';
  ownerName?: string | null;
}

export interface Arrival<T extends ArrivalMachine = ArrivalMachine> {
  /** The machine to connect to. */
  machine: T;
  /** Whether the machine pill — and the picker behind it — is offered at all. */
  showPicker: boolean;
  /** Skip the session list on arrival: see `planArrival`. */
  landInTerminal: boolean;
}

export const isGuestMachine = (m: ArrivalMachine): boolean => m.relation === 'grantee';

/**
 * Label by PERSON for a guest. "Machine" is owner vocabulary: a guest was
 * invited to a session by someone, and has no relationship with the hardware.
 */
export function machineLabel(m: ArrivalMachine): string {
  return isGuestMachine(m) && m.ownerName ? `${m.ownerName}'s ${m.name}` : m.name;
}

/**
 * How to open for this person.
 *
 * A guest holding exactly one grant gets no picker and no session-list detour:
 * choosing between one thing is not a choice, and every step before the
 * terminal is a step away from the session they were actually sent to. Anyone
 * with a machine of their own keeps the pill, because for them it is also the
 * route to linking another.
 */
export function planArrival<T extends ArrivalMachine>(machines: T[], preferredId: string | null): Arrival<T> | null {
  if (!machines.length) return null;
  const machine = machines.find((m) => m.id === preferredId) ?? machines[0]!;
  const single = machines.length === 1 && isGuestMachine(machines[0]!);
  return { machine, showPicker: !single, landInTerminal: single };
}

export interface MachineSection<T extends ArrivalMachine = ArrivalMachine> {
  title: string;
  items: T[];
}

/**
 * The picker's rows, split by whose they are.
 *
 * Shared entries are grouped under one heading and each row is named after the
 * person who shared it — "SHARED WITH ME" over "Will's laptop" — so a guest
 * reads the list as people rather than as inventory.
 */
export function machineSections<T extends ArrivalMachine>(machines: T[]): MachineSection<T>[] {
  const mine = machines.filter((m) => !isGuestMachine(m));
  const shared = machines
    .filter(isGuestMachine)
    .slice()
    .sort((a, b) => (a.ownerName ?? '').localeCompare(b.ownerName ?? '') || a.name.localeCompare(b.name));
  const sections: MachineSection<T>[] = [];
  if (mine.length) sections.push({ title: 'My machines', items: mine });
  if (shared.length) sections.push({ title: 'Shared with me', items: shared });
  return sections;
}

/** The picker's own heading. Someone with no machines of their own owns none. */
export function machineMenuTitle(machines: ArrivalMachine[]): string {
  return machines.length > 0 && machines.every(isGuestMachine) ? 'Shared with you' : 'Machines';
}

/**
 * The session to open without being asked, or null when there is a real choice.
 *
 * Only ever for the single-grant guest, and only when their scope holds one
 * session: a grant covering several is a list they have to read, and picking
 * one for them would hide the others.
 */
export function autoOpenSessionId(arrival: Arrival | null, sessionIds: string[]): string | null {
  if (!arrival?.landInTerminal) return null;
  return sessionIds.length === 1 ? sessionIds[0]! : null;
}
