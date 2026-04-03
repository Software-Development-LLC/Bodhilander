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

const NOTIFICATION_ICONS: Record<TeamsNotificationType, string> = {
  waiting: '⏳',
  error: '❌',
  complete: '✅',
};

const NOTIFICATION_MESSAGES: Record<TeamsNotificationType, string> = {
  waiting: 'needs your input',
  error: 'encountered an error',
  complete: 'finished the task',
};

class TeamsNotifier {
  private selfChatId: string | null = null;

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
   * Get or create a chat with yourself for notifications
   */
  private async getSelfChatId(): Promise<string> {
    if (this.selfChatId) {
      return this.selfChatId;
    }

    const token = await teamsAuthService.getAccessToken();

    // Get user ID first
    const meResponse = await fetch(`${GRAPH_API_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!meResponse.ok) {
      throw new Error('Failed to get user info');
    }

    const me = await meResponse.json();
    const userId = me.id;

    // Create a one-on-one chat with yourself
    const chatResponse = await fetch(`${GRAPH_API_URL}/chats`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatType: 'oneOnOne',
        members: [
          {
            '@odata.type': '#microsoft.graph.aadUserConversationMember',
            roles: ['owner'],
            'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${userId}')`,
          },
        ],
      }),
    });

    if (!chatResponse.ok) {
      const error = await chatResponse.text();
      log.error('Failed to create self chat:', error);
      throw new Error('Failed to create notification chat');
    }

    const chat = await chatResponse.json();
    this.selfChatId = chat.id;
    return chat.id;
  }

  /**
   * Send a notification as a chat message
   */
  async sendNotification(payload: NotificationPayload): Promise<void> {
    if (!this.isEnabled(payload.type)) {
      return;
    }

    try {
      const token = await teamsAuthService.getAccessToken();
      const chatId = await this.getSelfChatId();

      const icon = NOTIFICATION_ICONS[payload.type];
      const message = NOTIFICATION_MESSAGES[payload.type];

      const response = await fetch(`${GRAPH_API_URL}/chats/${chatId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          body: {
            contentType: 'html',
            content: `<b>${icon} Bodhilander</b><br/><b>${payload.sessionName}</b> ${message}<br/><i>${payload.projectPath}</i>`,
          },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        log.error('Failed to send Teams message:', error);
      } else {
        log.info('Teams notification sent successfully');
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

  /**
   * Clear cached chat ID (call on logout)
   */
  clearCache(): void {
    this.selfChatId = null;
  }
}

export const teamsNotifier = new TeamsNotifier();
