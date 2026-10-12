/**
 * Arrival: what a guest sees first. The rule under test is that a single-grant
 * guest is never asked to choose — not between machines, and not between one
 * session and nothing.
 */
import { describe, expect, test } from 'bun:test';
import {
  autoOpenSessionId,
  machineLabel,
  machineMenuTitle,
  machineSections,
  planArrival,
  showSectionTitles,
  type ArrivalMachine,
} from './arrival';

const mine = (over: Partial<ArrivalMachine> = {}): ArrivalMachine => ({
  id: 'm1',
  name: 'laptop',
  relation: 'owner',
  ownerName: null,
  ...over,
});

const shared = (over: Partial<ArrivalMachine> = {}): ArrivalMachine => ({
  id: 'g1',
  name: 'laptop',
  relation: 'grantee',
  ownerName: 'Will',
  ...over,
});

describe('planArrival', () => {
  test('a guest with exactly one grant lands in the terminal, with no picker', () => {
    const arrival = planArrival([shared()], null)!;
    expect(arrival.landInTerminal).toBe(true);
    expect(arrival.showPicker).toBe(false);
    expect(arrival.machine.id).toBe('g1');
  });

  test('a guest with two grants gets the picker and no automatic landing', () => {
    const arrival = planArrival([shared(), shared({ id: 'g2', ownerName: 'Dana' })], null)!;
    expect(arrival.landInTerminal).toBe(false);
    expect(arrival.showPicker).toBe(true);
  });

  test('an owner with one machine keeps the pill — it is also how they link another', () => {
    const arrival = planArrival([mine()], null)!;
    expect(arrival.landInTerminal).toBe(false);
    expect(arrival.showPicker).toBe(true);
  });

  test('one grant plus a machine of your own is still a choice', () => {
    const arrival = planArrival([mine(), shared()], null)!;
    expect(arrival.landInTerminal).toBe(false);
    expect(arrival.showPicker).toBe(true);
  });

  test('the remembered machine wins, and a stale one falls back to the first', () => {
    const machines = [mine(), mine({ id: 'm2', name: 'desktop' })];
    expect(planArrival(machines, 'm2')!.machine.id).toBe('m2');
    expect(planArrival(machines, 'gone')!.machine.id).toBe('m1');
  });

  test('nothing to arrive at', () => {
    expect(planArrival([], null)).toBeNull();
  });
});

describe('machineLabel', () => {
  test('a shared machine is named after its person', () => {
    expect(machineLabel(shared())).toBe("Will's laptop");
  });

  test('an unknown owner degrades to the machine name rather than an empty possessive', () => {
    expect(machineLabel(shared({ ownerName: null }))).toBe('laptop');
  });

  test('your own machine is just itself', () => {
    expect(machineLabel(mine())).toBe('laptop');
  });
});

describe('machineSections', () => {
  test('yours and theirs are separate, and theirs are labelled by person', () => {
    const sections = machineSections([mine(), shared()]);
    expect(sections.map((s) => s.title)).toEqual(['My machines', 'Shared with me']);
    expect(sections[1]!.items.map(machineLabel)).toEqual(["Will's laptop"]);
  });

  test('shared rows cluster by person so one owner is not scattered', () => {
    const sections = machineSections([
      shared({ id: 'a', ownerName: 'Will', name: 'desktop' }),
      shared({ id: 'b', ownerName: 'Dana', name: 'mac mini' }),
      shared({ id: 'c', ownerName: 'Will', name: 'laptop' }),
    ]);
    expect(sections[0]!.items.map(machineLabel)).toEqual([
      "Dana's mac mini",
      "Will's desktop",
      "Will's laptop",
    ]);
  });

  test('a section with nothing in it is not rendered', () => {
    expect(machineSections([shared()]).map((s) => s.title)).toEqual(['Shared with me']);
    expect(machineSections([mine()]).map((s) => s.title)).toEqual(['My machines']);
  });
});

describe('machineMenuTitle', () => {
  test('a guest never reads the word "machines" as though they owned any', () => {
    expect(machineMenuTitle([shared(), shared({ id: 'g2' })])).toBe('Shared with me');
  });

  test('the sheet and the section inside it say the same thing, in one voice', () => {
    // Two names for one list on one screen reads as two different lists.
    const machines = [shared(), shared({ id: 'g2' })];
    expect(machineSections(machines)[0]!.title).toBe(machineMenuTitle(machines));
  });

  test('anyone with one of their own gets the owner heading', () => {
    expect(machineMenuTitle([mine(), shared()])).toBe('Machines');
  });
});

describe('showSectionTitles', () => {
  test('headings appear when there are two sections to tell apart', () => {
    expect(showSectionTitles(machineSections([mine(), shared()]))).toBe(true);
  });

  test('the only section is never headed — either side of the relation', () => {
    // A heading over the only section labels nothing and repeats the sheet's
    // own title directly above it. True for an owner with only their own
    // machines, and equally true for a guest holding only other people's.
    expect(showSectionTitles(machineSections([mine(), mine({ id: 'm2' })]))).toBe(false);
    expect(showSectionTitles(machineSections([shared(), shared({ id: 'g2' })]))).toBe(false);
  });
});

describe('autoOpenSessionId', () => {
  const landing = planArrival([shared()], null);
  const fresh = { landed: false, activeId: null };

  test('one grant, one session — open it', () => {
    expect(autoOpenSessionId(landing, ['s1'], fresh)).toBe('s1');
  });

  test('a grant covering several sessions is a list, not a guess', () => {
    expect(autoOpenSessionId(landing, ['s1', 's2'], fresh)).toBeNull();
  });

  test('nothing in scope yet opens nothing', () => {
    expect(autoOpenSessionId(landing, [], fresh)).toBeNull();
  });

  test('anyone who was offered a picker chose for themselves', () => {
    expect(autoOpenSessionId(planArrival([mine()], null), ['s1'], fresh)).toBeNull();
    expect(autoOpenSessionId(null, ['s1'], fresh)).toBeNull();
  });

  test('landing happens once — Back must stay back', () => {
    // The session list is polled every couple of seconds. Without this the
    // next refresh reopens the terminal the guest just left, and every one
    // after it, so leaving is impossible.
    expect(autoOpenSessionId(landing, ['s1'], { landed: true, activeId: null })).toBeNull();
  });

  test('a terminal already on screen is not replaced by another landing', () => {
    expect(autoOpenSessionId(landing, ['s1'], { landed: false, activeId: 's1' })).toBeNull();
  });
});
