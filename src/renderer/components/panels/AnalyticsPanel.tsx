import React, { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, ResponsiveContainer, Legend,
} from 'recharts';
import { useAnalytics, TimeRange } from '../../store/analytics';
import { useSessions } from '../../store/sessions';
import { SessionEvent, Session } from '../../../shared/types';
import './AnalyticsPanel.css';

// Theme colors matching existing dark theme
const COLORS = {
  primary: '#5a7aff',
  working: '#4ade80',
  waiting: '#e5c07b',
  idle: '#61afef',
  error: '#e06c75',
  stopped: '#888',
  purple: '#c678dd',
  text: '#888',
  textPrimary: '#d4d4d4',
  grid: '#333',
  cardBg: '#252526',
  tooltipBg: '#1e1e1e',
  border: '#3c3c3c',
};

const STATE_COLORS: Record<string, string> = {
  working: COLORS.working,
  waiting: COLORS.waiting,
  idle: COLORS.idle,
  error: COLORS.error,
  stopped: COLORS.stopped,
};

const TOOLTIP_STYLE = {
  backgroundColor: COLORS.tooltipBg,
  border: `1px solid ${COLORS.border}`,
  borderRadius: '6px',
  color: COLORS.textPrimary,
  fontSize: '12px',
};

// --- Utility functions ---

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatEventTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function eventTypeLabel(type: string): string {
  switch (type) {
    case 'session_start': return 'Session started';
    case 'session_stop': return 'Session stopped';
    case 'state_change': return 'State changed';
    case 'tool_use': return 'Tool used';
    case 'turn_complete': return 'Turn completed';
    case 'error': return 'Error';
    case 'notification': return 'Notification';
    default: return type;
  }
}

function eventTypeIcon(type: string): string {
  switch (type) {
    case 'session_start': return '▶';
    case 'session_stop': return '■';
    case 'state_change': return '↻';
    case 'tool_use': return '⚡';
    case 'turn_complete': return '✓';
    case 'error': return '✗';
    case 'notification': return '🔔';
    default: return '•';
  }
}

// --- Sub-components ---

function TimeRangeSelector({ value, onChange }: { value: TimeRange; onChange: (v: TimeRange) => void }) {
  const ranges: { label: string; value: TimeRange }[] = [
    { label: 'Today', value: 'today' },
    { label: '7 days', value: '7d' },
    { label: '30 days', value: '30d' },
    { label: 'All time', value: 'all' },
  ];
  return (
    <div className="time-range-selector">
      {ranges.map(r => (
        <button
          key={r.value}
          className={`time-range-btn ${value === r.value ? 'active' : ''}`}
          onClick={() => onChange(r.value)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{typeof value === 'number' ? formatNumber(value) : value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="chart-card">
      <div className="chart-card-title">{title}</div>
      {children}
    </div>
  );
}

function ActivityChart({ data }: { data: { date: string; count: number }[] }) {
  if (!data || data.length === 0) {
    return <div className="chart-empty">No activity data yet</div>;
  }

  const formatted = data.map(d => ({
    date: new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    events: d.count,
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={formatted} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} vertical={false} />
        <XAxis dataKey="date" tick={{ fill: COLORS.text, fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: COLORS.text, fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(90, 122, 255, 0.1)' }} />
        <Bar dataKey="events" fill={COLORS.primary} radius={[3, 3, 0, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function StateDistributionChart({ sessions }: { sessions: Session[] }) {
  const counts: Record<string, number> = {};
  for (const s of sessions) {
    counts[s.state] = (counts[s.state] || 0) + 1;
  }

  const data = Object.entries(counts)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  if (data.length === 0) {
    return <div className="chart-empty">No sessions</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={2}
          dataKey="value"
          label={({ name, value }) => `${name} (${value})`}
        >
          {data.map((entry) => (
            <Cell key={entry.name} fill={STATE_COLORS[entry.name] || COLORS.text} />
          ))}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function ToolUsageChart({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  if (entries.length === 0) {
    return <div className="chart-empty">No tool usage data yet</div>;
  }

  const barColors = [COLORS.primary, COLORS.purple, COLORS.idle, COLORS.working, COLORS.waiting, COLORS.error, COLORS.stopped, COLORS.text];

  return (
    <ResponsiveContainer width="100%" height={Math.max(150, entries.length * 32)}>
      <BarChart data={entries} layout="vertical" margin={{ top: 5, right: 5, bottom: 5, left: 50 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} horizontal={false} />
        <XAxis type="number" tick={{ fill: COLORS.text, fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey="name" tick={{ fill: COLORS.text, fontSize: 11 }} axisLine={false} tickLine={false} width={60} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(90, 122, 255, 0.1)' }} />
        <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={24}>
          {entries.map((_, i) => (
            <Cell key={i} fill={barColors[i % barColors.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function TimeBreakdownChart({ sessions }: { sessions: Session[] }) {
  // Aggregate duration across all sessions by computing from current state counts
  // Use session durations for stopped sessions
  const stoppedDuration = sessions
    .filter(s => s.state === 'stopped')
    .reduce((sum, s) => sum + (s.durationSeconds || 0), 0);

  const data = [
    { name: 'Active', seconds: stoppedDuration, fill: COLORS.working },
  ];

  // Count currently running sessions
  const activeSessions = sessions.filter(s => s.state === 'working' || s.state === 'waiting' || s.state === 'idle');
  if (activeSessions.length > 0) {
    data.push({ name: 'In Progress', seconds: activeSessions.length, fill: COLORS.idle });
  }

  if (stoppedDuration === 0 && activeSessions.length === 0) {
    return <div className="chart-empty">No duration data yet</div>;
  }

  return (
    <div className="time-breakdown">
      <div className="time-breakdown-total">
        <span className="time-breakdown-value">{formatDuration(stoppedDuration)}</span>
        <span className="time-breakdown-label">Total active time across all sessions</span>
      </div>
      <div className="time-breakdown-detail">
        <span className="time-breakdown-count">{sessions.filter(s => s.state === 'stopped').length} completed</span>
        <span className="time-breakdown-sep">·</span>
        <span className="time-breakdown-count">{activeSessions.length} in progress</span>
      </div>
    </div>
  );
}

function RecentActivityFeed({ events }: { events: SessionEvent[] }) {
  if (events.length === 0) {
    return <div className="chart-empty">No recent activity</div>;
  }

  return (
    <div className="activity-feed">
      {events.map(event => (
        <div key={event.id} className="activity-item">
          <span className={`activity-icon activity-icon-${event.eventType}`}>
            {eventTypeIcon(event.eventType)}
          </span>
          <div className="activity-content">
            <span className="activity-label">{eventTypeLabel(event.eventType)}</span>
            {event.eventType === 'tool_use' && event.eventData?.tool_name != null && (
              <span className="activity-detail">{String(event.eventData.tool_name)}</span>
            )}
            {event.eventType === 'state_change' && event.eventData?.from != null && (
              <span className="activity-detail">
                {String(event.eventData.from)} → {String(event.eventData.to)}
              </span>
            )}
          </div>
          <span className="activity-time">{formatEventTime(event.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

// --- Main Component ---

interface AnalyticsPanelProps {
  onClose: () => void;
}

export default function AnalyticsPanel({ onClose }: AnalyticsPanelProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const { globalStats, recentEvents, loading, error, refresh } = useAnalytics(timeRange);
  const { sessions } = useSessions();

  if (loading && !globalStats) {
    return (
      <div className="analytics-panel">
        <div className="analytics-header">
          <h2>Analytics</h2>
          <div className="analytics-header-actions">
            <button className="icon-button" onClick={onClose} title="Close">×</button>
          </div>
        </div>
        <div className="analytics-loading">Loading analytics...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="analytics-panel">
        <div className="analytics-header">
          <h2>Analytics</h2>
          <div className="analytics-header-actions">
            <button className="icon-button" onClick={refresh} title="Retry">↻</button>
            <button className="icon-button" onClick={onClose} title="Close">×</button>
          </div>
        </div>
        <div className="analytics-error">Failed to load analytics: {error}</div>
      </div>
    );
  }

  return (
    <div className="analytics-panel">
      <div className="analytics-header">
        <h2>Analytics</h2>
        <div className="analytics-header-actions">
          <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
          <button className="icon-button" onClick={refresh} title="Refresh">↻</button>
          <button className="icon-button" onClick={onClose} title="Close">×</button>
        </div>
      </div>

      <div className="analytics-body">
        {/* Summary stats row */}
        <div className="analytics-summary">
          <StatCard label="Sessions" value={globalStats?.totalSessions ?? 0} />
          <StatCard label="Events" value={globalStats?.totalEvents ?? 0} />
          <StatCard label="Active Time" value={formatDuration(globalStats?.totalDurationSeconds ?? 0)} />
          <StatCard label="Tools Used" value={Object.keys(globalStats?.toolUseCounts ?? {}).length} />
        </div>

        {/* Charts grid */}
        <div className="analytics-grid">
          <ChartCard title="Session Activity">
            <ActivityChart data={globalStats?.eventsPerDay ?? []} />
          </ChartCard>

          <ChartCard title="Session States">
            <StateDistributionChart sessions={sessions} />
          </ChartCard>

          <ChartCard title="Top Tools">
            <ToolUsageChart data={globalStats?.toolUseCounts ?? {}} />
          </ChartCard>

          <ChartCard title="Time Summary">
            <TimeBreakdownChart sessions={sessions} />
          </ChartCard>
        </div>

        {/* Recent activity */}
        <ChartCard title="Recent Activity">
          <RecentActivityFeed events={recentEvents} />
        </ChartCard>
      </div>
    </div>
  );
}
