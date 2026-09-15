/**
 * Reading and answering a run's permission requests (CO-722, #288).
 *
 * A background gate blocked on a tool does not change the daemon's status --
 * the `PreToolUse` hook is running, so the session reads `busy`, not
 * `waiting`. The only evidence a person is needed is a request file the hook
 * wrote into the channel. So this reads that channel, and the loop uses it to
 * move a run to `waitingPermission` where the attention pass could not.
 *
 * Answering writes the reply file the hook is polling for, and returns the
 * run to `running` so the loop drives it again. The decision is a person's;
 * this only carries it.
 *
 * Everything that touches the disk is a dependency, so the reading and the
 * answering can be asserted against a fake channel rather than a live one.
 */
import {
  channelDirFor,
  encodeDecision,
  readChannel,
  replyFileName,
  requestFileName,
  type ChannelFile,
  type PermissionDecision,
  type PermissionRequest,
} from './permission-channel';
import { channelKeyFor } from './gate-spawner';
import type { RunGateRow } from '../repositories/runs';

export interface ChannelIo {
  /** File names in a directory, or [] when it does not exist. */
  list(dir: string): string[];
  /** A file's text, or null when it does not exist. */
  read(path: string): string | null;
  /** Write a reply file. */
  write(path: string, text: string): void;
  join(...parts: string[]): string;
}

/**
 * The channel directory for a run's gate in flight, or null when none is.
 *
 * Keyed exactly as the launcher keyed it -- run, repo, gate, role, attempt --
 * so the verifier and the scribe (both gate 4) do not share a channel, a retry
 * does not inherit its predecessor's, and two owners at the same gate do not
 * collide (CO-722 multi-owner). The repo comes from the gate row the driver
 * opened; the launcher took it from the same owner.
 */
export function channelDirForGate(root: string, runId: string, gate: RunGateRow | null): string | null {
  if (!gate) return null;
  return channelDirFor(root, channelKeyFor(runId, gate.repo ?? '', gate.gate, gate.agent, gate.attempt));
}

/** What the channel holds for a run's gate: pending requests, in the person's order. */
export function pendingRequests(root: string, runId: string, gate: RunGateRow | null, io: ChannelIo): PermissionRequest[] {
  const dir = channelDirForGate(root, runId, gate);
  if (!dir) return [];
  const files: ChannelFile[] = io.list(dir).map((name) => ({ name, text: io.read(io.join(dir, name)) }));
  return readChannel(files).pending;
}

/**
 * Write a person's decision for one request.
 *
 * A refusal carries a message -- the CLI passes it to the model, and a
 * refusal the model cannot read teaches an owner to retry -- so a deny with
 * no words is given a plain one rather than sent empty. Returns whether the
 * request was still there to answer: a request already answered, or a gate no
 * longer in flight, is not an error, just nothing to do.
 */
export function writeDecision(
  root: string,
  runId: string,
  gate: RunGateRow | null,
  toolUseId: string,
  verdict: 'allow' | 'deny',
  message: string,
  io: ChannelIo,
): boolean {
  const dir = channelDirForGate(root, runId, gate);
  if (!dir) return false;
  // Only answer a request that is actually pending: writing a reply for an id
  // with no request, or one already answered, would leave a stray file the
  // broker's next launch could misread.
  const stillPending = readChannel(io.list(dir).map((name) => ({ name, text: io.read(io.join(dir, name)) }))).pending;
  if (!stillPending.some((r) => r.toolUseId === toolUseId)) return false;

  const decision: PermissionDecision =
    verdict === 'allow'
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: message.trim() || 'declined by a person from the inbox' };
  io.write(io.join(dir, replyFileName(toolUseId)), encodeDecision(decision));
  return true;
}

/** The reply file's name, exported so a caller can check whether one already exists. */
export { replyFileName, requestFileName };
