import { sidebarItems } from '../lib/navigation';

const subtitles: Record<string, string> = {
  '/tasks': 'Every schedule in one place.',
};

export function PageHeader({ path }: { path: string }) {
  const item = sidebarItems.find((entry) => entry.path === path && entry.path !== '/');
  if (!item) return null;
  return (
    <header className="chat-header page-header">
      <div className="chat-header-copy">
        <h1>{item.label}</h1>
        <p>{subtitles[path] ?? 'Settings'}</p>
      </div>
    </header>
  );
}
