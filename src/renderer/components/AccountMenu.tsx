import React, { useState, useEffect, useRef } from 'react';
import { ShareUser } from '../../shared/types';
import { RELAY_URL } from '../../shared/constants';
import './AccountMenu.css';

interface AccountMenuProps {
  user: ShareUser | null;
  onLogin: () => void;
  onLogout: () => void;
}

export const AccountMenu: React.FC<AccountMenuProps> = ({
  user,
  onLogin,
  onLogout,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close dropdown on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  if (!user) {
    return (
      <button className="account-btn login-btn" onClick={onLogin}>
        Sign In
      </button>
    );
  }

  return (
    <div className="account-menu" ref={menuRef}>
      <button className="account-btn" onClick={() => setIsOpen(!isOpen)}>
        <span className="avatar">{user.username?.[0]?.toUpperCase() || '?'}</span>
        <span className="username">{user.username}</span>
        <span className={`tier-badge ${user.tier}`}>{user.tier}</span>
      </button>

      {isOpen && (
        <div className="account-dropdown">
          <div className="account-info">
            <div className="account-name">{user.username}</div>
            {user.email && <div className="account-email">{user.email}</div>}
          </div>

          <div className="dropdown-divider" />

          {user.tier === 'free' && (
            <button
              className="dropdown-item upgrade"
              onClick={() => {
                try {
                  window.electronAPI.openExternal(`${RELAY_URL}/billing/checkout`);
                } catch (error) {
                  console.error('Failed to open external URL:', error);
                }
              }}
            >
              Upgrade to Pro - $5/mo
            </button>
          )}

          {user.tier !== 'free' && (
            <button
              className="dropdown-item"
              onClick={() => {
                try {
                  window.electronAPI.openExternal(`${RELAY_URL}/billing/portal`);
                } catch (error) {
                  console.error('Failed to open external URL:', error);
                }
              }}
            >
              Manage Subscription
            </button>
          )}

          <div className="dropdown-divider" />

          <button className="dropdown-item logout" onClick={onLogout}>
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
};
