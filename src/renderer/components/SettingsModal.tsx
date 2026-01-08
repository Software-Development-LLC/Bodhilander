import React, { useState, useEffect, useCallback } from 'react';
import { ApiServerStatus, PairedDevice, PairingCode } from '../../shared/types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'general' | 'mobile' | 'notifications'>('mobile');

  // Mobile API state
  const [apiStatus, setApiStatus] = useState<ApiServerStatus>({ running: false });
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null);
  const [port, setPort] = useState(8443);
  const [enableMdns, setEnableMdns] = useState(true);
  const [loading, setLoading] = useState(false);

  // Load initial state
  useEffect(() => {
    if (!isOpen) return;

    const loadState = async () => {
      try {
        const [status, devices, hasPairing] = await Promise.all([
          window.electronAPI.apiGetStatus(),
          window.electronAPI.apiGetPairedDevices(),
          window.electronAPI.apiHasPairingCode(),
        ]);
        setApiStatus(status);
        setPairedDevices(devices);
        if (!hasPairing) {
          setPairingCode(null);
        }
      } catch (err) {
        console.error('Failed to load API state:', err);
      }
    };

    loadState();
  }, [isOpen]);

  const handleStartServer = useCallback(async () => {
    setLoading(true);
    try {
      await window.electronAPI.apiStart({ port, enableMdns });
      const status = await window.electronAPI.apiGetStatus();
      setApiStatus(status);
    } catch (err) {
      console.error('Failed to start API server:', err);
    }
    setLoading(false);
  }, [port, enableMdns]);

  const handleStopServer = useCallback(async () => {
    setLoading(true);
    try {
      await window.electronAPI.apiStop();
      setApiStatus({ running: false });
      setPairingCode(null);
    } catch (err) {
      console.error('Failed to stop API server:', err);
    }
    setLoading(false);
  }, []);

  const handleGeneratePairingCode = useCallback(async () => {
    try {
      const code = await window.electronAPI.apiGeneratePairingCode({
        canControl: true,
        canModify: false,
      });
      setPairingCode(code);
    } catch (err) {
      console.error('Failed to generate pairing code:', err);
    }
  }, []);

  const handleCancelPairing = useCallback(async () => {
    try {
      await window.electronAPI.apiCancelPairing();
      setPairingCode(null);
    } catch (err) {
      console.error('Failed to cancel pairing:', err);
    }
  }, []);

  const handleUnpairDevice = useCallback(async (deviceId: string) => {
    try {
      await window.electronAPI.apiUnpairDevice(deviceId);
      setPairedDevices(prev => prev.filter(d => d.id !== deviceId));
    } catch (err) {
      console.error('Failed to unpair device:', err);
    }
  }, []);

  const handleUpdatePermissions = useCallback(async (
    deviceId: string,
    permissions: { canControl?: boolean; canModify?: boolean }
  ) => {
    try {
      await window.electronAPI.apiUpdateDevicePermissions(deviceId, permissions);
      setPairedDevices(prev =>
        prev.map(d =>
          d.id === deviceId
            ? { ...d, ...permissions }
            : d
        )
      );
    } catch (err) {
      console.error('Failed to update permissions:', err);
    }
  }, []);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav">
            <button
              className={`settings-nav-item ${activeTab === 'general' ? 'active' : ''}`}
              onClick={() => setActiveTab('general')}
            >
              General
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'mobile' ? 'active' : ''}`}
              onClick={() => setActiveTab('mobile')}
            >
              Mobile App
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'notifications' ? 'active' : ''}`}
              onClick={() => setActiveTab('notifications')}
            >
              Notifications
            </button>
          </nav>

          <div className="settings-content">
            {activeTab === 'general' && (
              <div className="settings-section">
                <h3>General Settings</h3>
                <p className="settings-placeholder">General settings coming soon...</p>
              </div>
            )}

            {activeTab === 'mobile' && (
              <div className="settings-section">
                <h3>Mobile Companion App</h3>
                <p className="settings-description">
                  Enable the local API server to connect the ClaudeLander mobile app.
                  Your mobile device must be on the same network.
                </p>

                <div className="settings-group">
                  <h4>API Server</h4>
                  <div className="settings-row">
                    <label>Status:</label>
                    <span className={`api-status ${apiStatus.running ? 'running' : 'stopped'}`}>
                      {apiStatus.running ? `Running on ${apiStatus.addresses?.[0] ?? 'localhost'}:${apiStatus.port}` : 'Stopped'}
                    </span>
                  </div>

                  {!apiStatus.running && (
                    <>
                      <div className="settings-row">
                        <label htmlFor="api-port">Port:</label>
                        <input
                          id="api-port"
                          type="number"
                          value={port}
                          onChange={e => setPort(parseInt(e.target.value) || 8443)}
                          min={1024}
                          max={65535}
                        />
                      </div>
                      <div className="settings-row">
                        <label htmlFor="api-mdns">Network Discovery:</label>
                        <input
                          id="api-mdns"
                          type="checkbox"
                          checked={enableMdns}
                          onChange={e => setEnableMdns(e.target.checked)}
                        />
                        <span className="settings-hint">Allow mobile app to find this computer automatically</span>
                      </div>
                    </>
                  )}

                  <div className="settings-actions">
                    {apiStatus.running ? (
                      <button
                        className="btn btn-danger"
                        onClick={handleStopServer}
                        disabled={loading}
                      >
                        {loading ? 'Stopping...' : 'Stop Server'}
                      </button>
                    ) : (
                      <button
                        className="btn btn-primary"
                        onClick={handleStartServer}
                        disabled={loading}
                      >
                        {loading ? 'Starting...' : 'Start Server'}
                      </button>
                    )}
                  </div>
                </div>

                {apiStatus.running && (
                  <div className="settings-group">
                    <h4>Pair New Device</h4>
                    {pairingCode ? (
                      <div className="pairing-active">
                        <div className="pairing-qr">
                          <img
                            src={pairingCode.qrCode}
                            alt="Scan with mobile app"
                            width={200}
                            height={200}
                          />
                        </div>
                        <div className="pairing-code">
                          <span>Code: </span>
                          <strong>{pairingCode.code}</strong>
                        </div>
                        <p className="pairing-hint">
                          Scan this QR code with the ClaudeLander mobile app, or enter the code manually.
                        </p>
                        <button className="btn btn-secondary" onClick={handleCancelPairing}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="pairing-start">
                        <p>Generate a pairing code to connect a new mobile device.</p>
                        <button className="btn btn-primary" onClick={handleGeneratePairingCode}>
                          Generate Pairing Code
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="settings-group">
                  <h4>Paired Devices ({pairedDevices.length})</h4>
                  {pairedDevices.length === 0 ? (
                    <p className="settings-empty">No devices paired yet.</p>
                  ) : (
                    <div className="paired-devices-list">
                      {pairedDevices.map(device => (
                        <div key={device.id} className="paired-device">
                          <div className="device-info">
                            <span className="device-name">{device.name}</span>
                            <span className="device-platform">{device.platform}</span>
                            <span className="device-last-used">
                              Last used: {new Date(device.lastUsedAt).toLocaleDateString()}
                            </span>
                          </div>
                          <div className="device-permissions">
                            <label>
                              <input
                                type="checkbox"
                                checked={device.canControl}
                                onChange={e =>
                                  handleUpdatePermissions(device.id, { canControl: e.target.checked })
                                }
                              />
                              Control
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                checked={device.canModify}
                                onChange={e =>
                                  handleUpdatePermissions(device.id, { canModify: e.target.checked })
                                }
                              />
                              Modify
                            </label>
                          </div>
                          <button
                            className="btn btn-danger btn-small"
                            onClick={() => handleUnpairDevice(device.id)}
                          >
                            Unpair
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'notifications' && (
              <div className="settings-section">
                <h3>Notification Settings</h3>
                <p className="settings-placeholder">Notification settings coming soon...</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
