import { sidebarItems } from '../lib/navigation';
import { teammatesSettingsPath } from './settings-nav';

const labels = new Map<string, string>([
  ...sidebarItems
    .filter((item) => item.path !== '/')
    .map((item) => [item.path, item.label] as const),
  [teammatesSettingsPath, 'Teammates'],
]);

const subtitles: Record<string, string> = {
  '/tasks': 'Every schedule in one place.',
  [teammatesSettingsPath]: 'Helpers for focused jobs, each with its own chat.',
};

export function PageHeader({ path }: { path: string }) {
  const label = labels.get(path);
  if (!label) return null;
  return (
    <header className="chat-header page-header">
      <div className="chat-header-copy">
        <h1>{label}</h1>
        <p>{subtitles[path] ?? 'Settings'}</p>
      </div>
    </header>
  );
}
