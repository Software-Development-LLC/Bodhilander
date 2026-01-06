import { teamsAuthService } from './teams-auth';
import { getPreference } from '../repositories/preferences';
import { GRAPH_API_URL } from '../../shared/teams-constants';
import log from 'electron-log';

export type TeamsNotificationType = 'waiting' | 'error' | 'complete';

interface NotificationPayload {
  sessionId: string;
  sessionName: string;
  projectPath: string;
  type: TeamsNotificationType;
}

const ACTIVITY_TYPES: Record<TeamsNotificationType, string> = {
  waiting: 'sessionWaiting',
  error: 'sessionError',
  complete: 'sessionComplete',
};

const NOTIFICATION_MESSAGES: Record<TeamsNotificationType, string> = {
  waiting: 'needs your input',
  error: 'encountered an error',
  complete: 'finished the task',
};

class TeamsNotifier {
  /**
   * Check if Teams notifications are enabled for a specific type
   */
  isEnabled(type: TeamsNotificationType): boolean {
    if (!teamsAuthService.isAuthenticated) return false;

    const prefKey = `teamsNotify${type.charAt(0).toUpperCase() + type.slice(1)}`;
    const pref = getPreference(prefKey);
    return pref !== 'false'; // Default to true
  }

  /**
   * Send a notification to Teams
   */
  async sendNotification(payload: NotificationPayload): Promise<void> {
    if (!this.isEnabled(payload.type)) {
      return;
    }

    try {
      const token = await teamsAuthService.getAccessToken();
      const deepLink = `claudelander://session/${payload.sessionId}`;

      const response = await fetch(
        `${GRAPH_API_URL}/me/teamwork/sendActivityNotification`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            topic: {
              source: 'text',
              value: 'ClaudeLander',
              webUrl: deepLink,
            },
            activityType: ACTIVITY_TYPES[payload.type],
            previewText: {
              content: `${payload.sessionName} ${NOTIFICATION_MESSAGES[payload.type]}`,
            },
            templateParameters: [
              { name: 'sessionName', value: payload.sessionName },
              { name: 'projectPath', value: payload.projectPath },
            ],
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        log.error('Failed to send Teams notification:', error);
      }
    } catch (e) {
      log.error('Teams notification error:', e);
      // Silent fail - don't block app for notification failures
    }
  }

  /**
   * Send a test notification
   */
  async sendTestNotification(): Promise<boolean> {
    if (!teamsAuthService.isAuthenticated) {
      return false;
    }

    try {
      await this.sendNotification({
        sessionId: 'test',
        sessionName: 'Test Session',
        projectPath: '/test/project',
        type: 'complete',
      });
      return true;
    } catch {
      return false;
    }
  }
}

export const teamsNotifier = new TeamsNotifier();
