import type { MouseEvent } from 'react';
import { settingsSections } from './account-settings';
import type { AccountControls } from './account-menu';
import { Users } from './icons';
import { sidebarItems } from '../lib/navigation';

export const teammatesSettingsPath = '/settings/teammates';

const plain = (event: MouseEvent) =>
  !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);

export function SettingsNav({
  path,
  account,
  onNavigate,
}: {
  path: string;
  account?: AccountControls;
  onNavigate(path: string): void;
}) {
  const pages = [
    { path: teammatesSettingsPath, label: 'Teammates', icon: Users },
    ...sidebarItems.filter((item) => item.path !== '/'),
  ];
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      <h1 className="settings-nav-title">Settings</h1>
      <ul>
        {pages.map((item) => (
          <li key={item.path}>
            <a
              href={item.path}
              className="settings-nav-item"
              aria-current={path === item.path ? 'page' : undefined}
              onClick={(event) => {
                if (!plain(event)) return;
                event.preventDefault();
                onNavigate(item.path);
              }}
            >
              <item.icon size={16} aria-hidden="true" />
              <span>{item.label}</span>
            </a>
          </li>
        ))}
      </ul>
      {account && (
        <ul className="settings-nav-ruled">
          {settingsSections.map((item) => (
            <li key={item.id}>
              <a
                href={item.path}
                className="settings-nav-item"
                aria-current={path === item.path ? 'page' : undefined}
                onClick={(event) => {
                  if (!plain(event)) return;
                  event.preventDefault();
                  account.onSettings(item.label, event.currentTarget);
                }}
              >
                <item.icon size={16} aria-hidden="true" />
                <span>{item.label}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
