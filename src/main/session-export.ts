/**
 * Session Export — BDHLNDR-20
 *
 * Formats session data as CSV or JSON and writes to a user-selected file.
 */

import { dialog, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as sessionsRepo from './repositories/sessions';
import * as sessionEventsRepo from './repositories/session-events';
import * as groupsRepo from './repositories/groups';
import log from 'electron-log';

export type ExportFormat = 'csv' | 'json';

interface ExportOptions {
  format: ExportFormat;
  since?: string; // ISO date string
}

interface ExportResult {
  success: boolean;
  filePath?: string;
  error?: string;
  sessionCount?: number;
  eventCount?: number;
}

function escapeCSV(value: string | number | null | undefined): string {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds < 1) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function buildCSV(since?: string): { content: string; sessionCount: number } {
  const sessions = sessionsRepo.getAllSessions();
  const groups = groupsRepo.getAllGroups();
  const groupMap = new Map(groups.map(g => [g.id, g.name]));

  // Filter by date if specified
  const filtered = since
    ? sessions.filter(s => new Date(s.createdAt).toISOString() >= since)
    : sessions;

  const headers = [
    'Session Name',
    'Group',
    'State',
    'Working Directory',
    'Created At',
    'Last Activity',
    'Ended At',
    'Duration',
    'Duration (seconds)',
    'Total Events',
    'Tool Calls',
    'Top Tools',
  ];

  const rows: string[] = [headers.map(escapeCSV).join(',')];

  for (const session of filtered) {
    const stats = sessionEventsRepo.getSessionStats(session.id);
    const toolEntries = Object.entries(stats.toolUseCounts);
    const totalTools = toolEntries.reduce((sum, [, count]) => sum + count, 0);
    const topTools = toolEntries
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}(${count})`)
      .join('; ');

    rows.push([
      escapeCSV(session.name),
      escapeCSV(groupMap.get(session.groupId) ?? 'Unknown'),
      escapeCSV(session.state),
      escapeCSV(session.workingDir),
      escapeCSV(session.createdAt instanceof Date ? session.createdAt.toISOString() : String(session.createdAt)),
      escapeCSV(session.lastActivityAt instanceof Date ? session.lastActivityAt.toISOString() : String(session.lastActivityAt)),
      escapeCSV(session.endedAt instanceof Date ? session.endedAt.toISOString() : ''),
      escapeCSV(formatDuration(session.durationSeconds)),
      escapeCSV(Math.round(session.durationSeconds)),
      escapeCSV(stats.totalEvents),
      escapeCSV(totalTools),
      escapeCSV(topTools),
    ].join(','));
  }

  // BOM for Excel UTF-8 compatibility
  return { content: '\uFEFF' + rows.join('\r\n'), sessionCount: filtered.length };
}

function buildJSON(since?: string): { content: string; sessionCount: number; eventCount: number } {
  const sessions = sessionsRepo.getAllSessions();
  const groups = groupsRepo.getAllGroups();
  const groupMap = new Map(groups.map(g => [g.id, g.name]));

  const filtered = since
    ? sessions.filter(s => new Date(s.createdAt).toISOString() >= since)
    : sessions;

  let totalEvents = 0;
  const exportData = filtered.map(session => {
    const stats = sessionEventsRepo.getSessionStats(session.id);
    const events = sessionEventsRepo.getEventsBySession(session.id, 10000);
    totalEvents += events.length;

    return {
      session: {
        id: session.id,
        name: session.name,
        group: groupMap.get(session.groupId) ?? 'Unknown',
        groupId: session.groupId,
        state: session.state,
        workingDir: session.workingDir,
        createdAt: session.createdAt instanceof Date ? session.createdAt.toISOString() : session.createdAt,
        lastActivityAt: session.lastActivityAt instanceof Date ? session.lastActivityAt.toISOString() : session.lastActivityAt,
        endedAt: session.endedAt instanceof Date ? session.endedAt.toISOString() : session.endedAt,
        durationSeconds: session.durationSeconds,
      },
      stats: {
        totalEvents: stats.totalEvents,
        totalDurationSeconds: stats.totalDurationSeconds,
        toolUseCounts: stats.toolUseCounts,
        stateBreakdown: stats.stateBreakdown,
      },
      events: events.map(e => ({
        id: e.id,
        eventType: e.eventType,
        eventData: e.eventData,
        createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : e.createdAt,
      })),
    };
  });

  const output = {
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    sessionCount: filtered.length,
    totalEvents,
    sessions: exportData,
  };

  return {
    content: JSON.stringify(output, null, 2),
    sessionCount: filtered.length,
    eventCount: totalEvents,
  };
}

export async function exportSessions(options: ExportOptions): Promise<ExportResult> {
  try {
    const defaultName = `bodhilander-sessions-${new Date().toISOString().slice(0, 10)}`;
    const ext = options.format === 'csv' ? 'csv' : 'json';

    const result = await dialog.showSaveDialog({
      title: `Export Sessions (${options.format.toUpperCase()})`,
      defaultPath: path.join(app.getPath('documents'), `${defaultName}.${ext}`),
      filters: options.format === 'csv'
        ? [{ name: 'CSV Files', extensions: ['csv'] }]
        : [{ name: 'JSON Files', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'Export cancelled' };
    }

    let content: string;
    let sessionCount: number;
    let eventCount = 0;

    if (options.format === 'csv') {
      const csv = buildCSV(options.since);
      content = csv.content;
      sessionCount = csv.sessionCount;
    } else {
      const json = buildJSON(options.since);
      content = json.content;
      sessionCount = json.sessionCount;
      eventCount = json.eventCount;
    }

    fs.writeFileSync(result.filePath, content, 'utf-8');
    log.info(`[Export] Exported ${sessionCount} sessions to ${result.filePath}`);

    return {
      success: true,
      filePath: result.filePath,
      sessionCount,
      eventCount,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('[Export] Failed to export sessions:', msg);
    return { success: false, error: msg };
  }
}
