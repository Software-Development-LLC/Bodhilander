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
    expect(machineMenuTitle([shared(), shared({ id: 'g2' })])).toBe('Shared with you');
  });

  test('anyone with one of their own gets the owner heading', () => {
    expect(machineMenuTitle([mine(), shared()])).toBe('Machines');
  });
});

describe('autoOpenSessionId', () => {
  const landing = planArrival([shared()], null);

  test('one grant, one session — open it', () => {
    expect(autoOpenSessionId(landing, ['s1'])).toBe('s1');
  });

  test('a grant covering several sessions is a list, not a guess', () => {
    expect(autoOpenSessionId(landing, ['s1', 's2'])).toBeNull();
  });

  test('nothing in scope yet opens nothing', () => {
    expect(autoOpenSessionId(landing, [])).toBeNull();
  });

  test('anyone who was offered a picker chose for themselves', () => {
    expect(autoOpenSessionId(planArrival([mine()], null), ['s1'])).toBeNull();
    expect(autoOpenSessionId(null, ['s1'])).toBeNull();
  });
});
