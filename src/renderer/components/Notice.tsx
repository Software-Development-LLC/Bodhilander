import React from 'react';
import './Notice.css';

export type NoticeTone = 'info' | 'warn' | 'muted';

export interface NoticeProps {
  tone?: NoticeTone;
  /** Single glyph carrying the tone visually; decorative, so aria-hidden. */
  icon: string;
  children: React.ReactNode;
  onDismiss: () => void;
  /** Optional escape hatch to wherever the underlying setting lives. */
  action?: { label: string; onClick: () => void };
}

const TONE_CLASS: Record<NoticeTone, string> = {
  info: '',
  warn: 'notice-warn',
  muted: 'notice-muted',
};

/**
 * One line in the window about something that just happened to your sessions.
 *
 * `<output>` rather than a styled div: it carries role="status" natively, so
 * the text is announced to a screen reader when it appears without stealing
 * focus — the right register for a report about work the app did on its own,
 * which is exactly what both of its users are (#214, failover).
 */
export const Notice: React.FC<NoticeProps> = ({ tone = 'info', icon, children, onDismiss, action }) => (
  <output className={`notice ${TONE_CLASS[tone]}`.trim()} aria-live="polite">
    <span className="notice-icon" aria-hidden="true">{icon}</span>
    <div className="notice-body">{children}</div>
    {action && (
      <button className="notice-link" onClick={action.onClick}>{action.label}</button>
    )}
    <button className="notice-dismiss" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">×</button>
  </output>
);
