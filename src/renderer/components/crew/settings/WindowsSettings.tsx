import React from 'react';
import { SavedCopies } from './SavedCopies';
import { WindowsSetup } from './WindowsSetup';

/** Crew → Windows setup, mounted on Windows only. */
export const WindowsSettings: React.FC<{ platform?: string }> = ({ platform = window.electronAPI?.platform }) =>
  platform === 'win32' ? (
    <div className="crew-windows-settings">
      <WindowsSetup />
      <SavedCopies />
    </div>
  ) : null;
