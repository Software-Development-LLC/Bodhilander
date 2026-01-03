import React, { useState, useEffect, useRef } from 'react';
import { ShareUser } from '../../shared/types';
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
        <span className="avatar">{user.username[0].toUpperCase()}</span>
        <span className="username">{user.username}</span>
        <span className={`tier-badge ${user.tier}`}>{user.tier}</span>
      </button>

      {isOpen && (
        <div className="account-dropdown">
          <div className="account-info">
            <div className="account-name">{user.username}</div>
            <div className="account-email">{user.email}</div>
          </div>

          <div className="dropdown-divider" />

          {user.tier === 'free' && (
            <button
              className="dropdown-item upgrade"
              onClick={() => {
                window.electronAPI.openExternal('https://api.sytanek.tech/billing/checkout');
              }}
            >
              Upgrade to Pro - $5/mo
            </button>
          )}

          {user.tier !== 'free' && (
            <button
              className="dropdown-item"
              onClick={() => {
                window.electronAPI.openExternal('https://api.sytanek.tech/billing/portal');
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
