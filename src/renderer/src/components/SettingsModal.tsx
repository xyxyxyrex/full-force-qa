import { useState, useEffect } from 'react'
import type { AppSettings, AppTheme } from '../../../shared/types'
import { THEME_LIST, saveSettings, DEFAULT_HOTKEYS } from '../theme/themeSystem'
import './SettingsModal.css'

interface Props {
  isOpen: boolean
  settings: AppSettings
  onClose: () => void
  onSave: (newSettings: AppSettings) => void
}

type TabType = 'general' | 'hotkeys' | 'appearance' | 'integrations'

export default function SettingsModal({ isOpen, settings, onClose, onSave }: Props) {
  const [activeTab, setActiveTab] = useState<TabType>('general')
  const [formSettings, setFormSettings] = useState<AppSettings>(settings)

  useEffect(() => {
    setFormSettings(settings)
  }, [settings, isOpen])

  if (!isOpen) return null

  const handleSelectDirectory = async () => {
    if (window.electronAPI?.selectSnapshotDirectory) {
      const res = await window.electronAPI.selectSnapshotDirectory()
      if (res.success && typeof res.path === 'string') {
        const dirPath: string = res.path
        setFormSettings((prev) => ({ ...prev, snapshotDirectory: dirPath }))
      }
    }
  }

  const handleThemeChange = (theme: AppTheme) => {
    const updated = { ...formSettings, theme }
    setFormSettings(updated)
    saveSettings(updated)
  }

  const handleHotkeyChange = (key: keyof typeof DEFAULT_HOTKEYS, val: string) => {
    setFormSettings((prev) => ({
      ...prev,
      hotkeys: {
        ...prev.hotkeys,
        [key]: val
      }
    }))
  }

  const handleResetHotkeys = () => {
    setFormSettings((prev) => ({
      ...prev,
      hotkeys: DEFAULT_HOTKEYS
    }))
  }

  const handleSave = () => {
    saveSettings(formSettings)
    onSave(formSettings)
    onClose()
  }

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div className="settings-modal-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-header">
          <div className="settings-title-row">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <h2>App Settings</h2>
          </div>
          <button className="settings-close-btn" onClick={onClose} title="Close Settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="settings-body">
          {/* Sidebar */}
          <div className="settings-sidebar">
            <button
              className={`settings-nav-btn ${activeTab === 'general' ? 'active' : ''}`}
              onClick={() => setActiveTab('general')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span>General & Directory</span>
            </button>
            <button
              className={`settings-nav-btn ${activeTab === 'hotkeys' ? 'active' : ''}`}
              onClick={() => setActiveTab('hotkeys')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
              </svg>
              <span>Hotkeys & Shortcuts</span>
            </button>
            <button
              className={`settings-nav-btn ${activeTab === 'appearance' ? 'active' : ''}`}
              onClick={() => setActiveTab('appearance')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 2a10 10 0 0 0 0 20z" />
              </svg>
              <span>Theme Customization</span>
            </button>
            <button
              className={`settings-nav-btn ${activeTab === 'integrations' ? 'active' : ''}`}
              onClick={() => setActiveTab('integrations')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              <span>Integrations & Capture</span>
            </button>
          </div>

          {/* Panel Content */}
          <div className="settings-content-panel">
            {activeTab === 'general' && (
              <div className="settings-tab-section">
                <div className="settings-section-heading">Snapshot Storage Directory</div>
                <div className="settings-field-group">
                  <div className="settings-field-label">Default Directory Path</div>
                  <div className="settings-field-desc">Location on disk where project captures and PNG snapshots are saved</div>
                  <div className="settings-input-row">
                    <input
                      type="text"
                      className="settings-text-input"
                      value={formSettings.snapshotDirectory}
                      onChange={(e) => setFormSettings({ ...formSettings, snapshotDirectory: e.target.value })}
                    />
                    <button className="settings-action-btn" onClick={handleSelectDirectory}>Browse...</button>
                  </div>
                </div>

                <div className="settings-field-group">
                  <div className="settings-field-label">Trash Auto-Purge Policy</div>
                  <div className="settings-field-desc">Automatically delete trashed projects after specified days</div>
                  <select
                    className="settings-select-input"
                    value={formSettings.autoPurgeTrashDays}
                    onChange={(e) => setFormSettings({ ...formSettings, autoPurgeTrashDays: Number(e.target.value) })}
                  >
                    <option value={7}>After 7 days</option>
                    <option value={14}>After 14 days (Recommended)</option>
                    <option value={30}>After 30 days</option>
                    <option value={0}>Never (Manual purge only)</option>
                  </select>
                </div>

                <div className="settings-field-group">
                  <div className="settings-field-label">Default Viewport Size</div>
                  <div className="settings-field-desc">Initial canvas size when opening new captures</div>
                  <select
                    className="settings-select-input"
                    value={formSettings.defaultViewport}
                    onChange={(e) => setFormSettings({ ...formSettings, defaultViewport: e.target.value })}
                  >
                    <option value="Desktop (1920×1200)">Desktop (1920×1200)</option>
                    <option value="Laptop (1440×900)">Laptop (1440×900)</option>
                    <option value="Tablet (1199×768)">Tablet (1199×768)</option>
                    <option value="Mobile (329×767)">Mobile (329×767)</option>
                  </select>
                </div>
              </div>
            )}

            {activeTab === 'hotkeys' && (
              <div className="settings-tab-section">
                <div className="settings-section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Keyboard Shortcuts</span>
                  <button className="settings-action-btn" onClick={handleResetHotkeys} style={{ fontSize: 11, padding: '4px 10px' }}>
                    Reset Defaults
                  </button>
                </div>
                <table className="hotkeys-table">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Shortcut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(formSettings.hotkeys).map(([key, val]) => (
                      <tr key={key}>
                        <td style={{ textTransform: 'capitalize' }}>{key.replace(/([A-Z])/g, ' $1')}</td>
                        <td>
                          <input
                            type="text"
                            className="settings-text-input"
                            style={{ width: 140, padding: '4px 8px', fontSize: 11 }}
                            value={val}
                            onChange={(e) => handleHotkeyChange(key as keyof typeof DEFAULT_HOTKEYS, e.target.value)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="settings-tab-section">
                <div className="settings-section-heading">Application Theme</div>
                <div className="theme-cards-grid">
                  {THEME_LIST.map((t) => (
                    <div
                      key={t.id}
                      className={`theme-card ${formSettings.theme === t.id ? 'active' : ''}`}
                      onClick={() => handleThemeChange(t.id)}
                    >
                      <span className="theme-card-title">{t.name}</span>
                      <div className="theme-quadrant-circle" title={`${t.name} color palette`}>
                        <span style={{ backgroundColor: t.previewBg }} />
                        <span style={{ backgroundColor: t.previewBg === '#f8fafc' ? '#e2e8f0' : '#2a2a34' }} />
                        <span style={{ backgroundColor: t.previewAccent + '77' }} />
                        <span style={{ backgroundColor: t.previewAccent }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'integrations' && (
              <div className="settings-tab-section">
                <div className="settings-section-heading">Monday.com & Capture Options</div>
                <div className="settings-field-group">
                  <div className="settings-field-label">Monday Sync Interval</div>
                  <div className="settings-field-desc">Frequency to fetch updated QA tickets from Monday.com</div>
                  <select
                    className="settings-select-input"
                    value={formSettings.mondaySyncIntervalMinutes}
                    onChange={(e) => setFormSettings({ ...formSettings, mondaySyncIntervalMinutes: Number(e.target.value) })}
                  >
                    <option value={5}>Every 5 minutes</option>
                    <option value={15}>Every 15 minutes (Recommended)</option>
                    <option value={60}>Every 60 minutes</option>
                    <option value={0}>Manual Sync Only</option>
                  </select>
                </div>

                <div className="settings-field-group">
                  <div className="settings-field-label">High-DPI Capture Scale</div>
                  <div className="settings-field-desc">Screen device scale factor for PNG snapshot quality</div>
                  <select
                    className="settings-select-input"
                    value={formSettings.captureDpiScale}
                    onChange={(e) => setFormSettings({ ...formSettings, captureDpiScale: Number(e.target.value) })}
                  >
                    <option value={1}>1x Standard DPI</option>
                    <option value={2}>2x Retina / Crisp High DPI</option>
                  </select>
                </div>

                <div className="settings-field-group">
                  <div className="settings-field-label">Page Capture Timeout</div>
                  <div className="settings-field-desc">Maximum wait time for full page scroll and rendering</div>
                  <select
                    className="settings-select-input"
                    value={formSettings.captureTimeoutMs}
                    onChange={(e) => setFormSettings({ ...formSettings, captureTimeoutMs: Number(e.target.value) })}
                  >
                    <option value={3000}>3 seconds (Fast)</option>
                    <option value={5000}>5 seconds (Standard)</option>
                    <option value={10000}>10 seconds (Thorough for heavy pages)</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="settings-footer">
          <button className="settings-action-btn" onClick={onClose}>Cancel</button>
          <button className="settings-save-btn" onClick={handleSave}>Save Settings</button>
        </div>
      </div>
    </div>
  )
}
