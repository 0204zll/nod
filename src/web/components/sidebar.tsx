import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Clock, LayoutGrid, Moon, PanelLeftClose, PanelLeftOpen, Settings, Sun } from './icons';
import { settingsSections } from './account-settings';
import { BrandMark } from './brand';
import { Tooltip } from './tooltip';
import { desktopSettingsAvailable } from '../lib/desktop';
import type { AccountControls } from './account-menu';
import { currentTheme, setTheme, subscribeTheme } from '../lib/theme';
import {
  isEditingTarget,
  navigationShortcut,
  shortcutLabel,
  sidebarItems,
  sidebarSection,
  type SidebarSection,
} from '../lib/navigation';

export function Sidebar({
  path,
  chats,
  unreadCount = 0,
  unreadPending = false,
  presence,
  panelHidden = false,
  onToggle,
  onNavigate,
  account,
}: {
  path: string;
  panelHidden?: boolean;
  chats?: React.ReactNode;
  unreadCount?: number;
  unreadPending?: boolean;
  presence?: 'working' | 'waiting';
  onToggle(animate: boolean): void;
  onNavigate(path: string): void;
  account?: AccountControls;
}) {
  const [hints, setHints] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const unreadLabel =
    unreadCount > 99
      ? 'More than 99 unread messages'
      : unreadPending
        ? unreadCount
          ? `${unreadCount} or more unread messages`
          : 'Checking unread messages'
        : `${unreadCount} unread ${unreadCount === 1 ? 'message' : 'messages'}`;
  const chatLabel = [
    'Chat',
    unreadCount || unreadPending ? unreadLabel : null,
    presence === 'waiting' ? 'waiting for you' : presence === 'working' ? 'Nod is working' : null,
  ]
    .filter(Boolean)
    .join(', ');
  const unreadBadge =
    unreadCount || unreadPending ? (
      <span className="chat-unread-badge" aria-hidden="true">
        {unreadCount > 99
          ? '99+'
          : unreadPending
            ? unreadCount
              ? `${unreadCount}+`
              : '…'
            : unreadCount}
      </span>
    ) : null;
  const statusDot = presence ? (
    <span className="chat-status-dot" data-state={presence} aria-hidden="true" />
  ) : null;
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const mobileSheet = useRef<HTMLDialogElement>(null);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => 'light');
  const ThemeIcon = theme === 'dark' ? Sun : Moon;
  const themeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const desktop = desktopSettingsAvailable();
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  const toggles = useRef({ onToggle, account });
  toggles.current = { onToggle, account };
  const closeMobileMenu = () => {
    setMobileMenuOpen(false);
    (window.innerWidth <= 640
      ? mobileTrigger.current
      : document.getElementById('workspace')
    )?.focus();
  };
  useEffect(() => {
    const sheet = mobileSheet.current;
    if (!sheet) return;
    if (mobileMenuOpen && !sheet.open) {
      sheet.showModal();
      sheet.querySelector<HTMLElement>('.mobile-sheet-body')?.focus();
    }
    if (!mobileMenuOpen && sheet.open) sheet.close();
  }, [mobileMenuOpen]);
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [path]);
  useEffect(() => {
    const resize = () => {
      if (window.innerWidth > 640) setMobileMenuOpen(false);
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let focusFrame: number | undefined;
    const clear = () => {
      clearTimeout(timer);
      timer = undefined;
      setHints(false);
    };
    const hintsBlocked = () =>
      document.hidden ||
      window.innerWidth <= 640 ||
      isEditingTarget(document.activeElement) ||
      Boolean(
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], dialog[open], [role="menu"], [role="listbox"]',
        ),
      );
    const down = (event: KeyboardEvent) => {
      const eventPath = event.composedPath();
      const action = navigationShortcut(event, mac);
      const composerNavigation =
        action?.type === 'navigate' &&
        event.target instanceof Element &&
        event.target.closest('.composer .composer-editor[contenteditable="true"]') ===
          document.activeElement;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        ((eventPath.some(isEditingTarget) || isEditingTarget(document.activeElement)) &&
          !composerNavigation) ||
        eventPath.some(
          (target) => target instanceof Element && Boolean(target.closest('[role="dialog"]')),
        )
      ) {
        clear();
        return;
      }
      if (
        event.key === (mac ? 'Meta' : 'Control') &&
        !event.altKey &&
        !event.shiftKey &&
        !(mac ? event.ctrlKey : event.metaKey)
      ) {
        if (!event.repeat && !timer)
          timer = setTimeout(() => {
            if (!hintsBlocked()) setHints(true);
          }, 650);
        return;
      }
      clear();
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action.type === 'sidebar') {
        if (window.innerWidth <= 640) setMobileMenuOpen((open) => !open);
        else toggles.current.onToggle(false);
        return;
      }
      navigate.current(action.path);
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
      focusFrame = window.requestAnimationFrame(() => {
        focusFrame = undefined;
        const target =
          action.path === '/'
            ? document.querySelector<HTMLElement>('.composer-editor[contenteditable="true"]')
            : document.getElementById('workspace');
        target?.focus();
      });
    };
    const up = (event: KeyboardEvent) => {
      if (!(mac ? event.metaKey : event.ctrlKey)) clear();
    };
    const focus = () => {
      if (hintsBlocked()) clear();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    window.addEventListener('pointerdown', clear, true);
    window.addEventListener('resize', clear);
    document.addEventListener('focusin', focus);
    document.addEventListener('scroll', clear, true);
    document.addEventListener('visibilitychange', clear);
    return () => {
      clearTimeout(timer);
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      window.removeEventListener('pointerdown', clear, true);
      window.removeEventListener('resize', clear);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('scroll', clear, true);
      document.removeEventListener('visibilitychange', clear);
    };
  }, [mac, desktop]);
  const plain = (event: React.MouseEvent) =>
    !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
  const section = sidebarSection(path);
  const lastPaths = useRef<Partial<Record<SidebarSection, string>>>({});
  if (section) lastPaths.current[section] = path;
  const railItem = (
    item: SidebarSection,
    label: string,
    icon: React.ReactNode,
    target: string,
    key: string,
    extra?: React.ReactNode,
  ) => (
    <Tooltip
      content={label}
      shortcut={desktop ? shortcutLabel(key, mac) : undefined}
      side="right"
      forceOpen={hints}
    >
      <a
        href={target}
        className={`rail-item${section === item ? ' rail-item-active' : ''}`}
        aria-label={item === 'chat' ? chatLabel : label}
        aria-current={section === item ? 'page' : undefined}
        aria-keyshortcuts={desktop ? `${mac ? 'Meta' : 'Control'}+${key}` : undefined}
        onClick={(event) => {
          if (!plain(event)) return;
          event.preventDefault();
          onNavigate(target);
        }}
      >
        <span className="rail-icon">
          {icon}
          {extra}
        </span>
        <span className="rail-label">{label}</span>
      </a>
    </Tooltip>
  );
  const panelLink = (
    target: string,
    label: string,
    Icon?: (typeof sidebarItems)[number]['icon'],
  ) => (
    <li key={target}>
      <a
        href={target}
        className={`panel-row${path === target ? ' panel-row-active' : ''}`}
        aria-current={path === target ? 'page' : undefined}
        onClick={(event) => {
          if (!plain(event)) return;
          event.preventDefault();
          onNavigate(target);
        }}
      >
        {Icon && <Icon size={16} aria-hidden="true" />}
        <span>{label}</span>
      </a>
    </li>
  );
  const panelTitle =
    section === 'scheduled' ? 'Scheduled' : section === 'settings' ? 'Settings' : 'Chat';
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <nav className="rail" aria-label="Main navigation" id="sidebar-navigation">
        {railItem(
          'chat',
          'Chat',
          <BrandMark />,
          section === 'chat' ? '/' : (lastPaths.current.chat ?? '/'),
          '1',
          unreadBadge ?? statusDot,
        )}
        <div className="rail-spacer" />
        {railItem('scheduled', 'Scheduled', <Clock size={22} aria-hidden="true" />, '/tasks', '2')}
        {account ? (
          railItem(
            'settings',
            'Settings',
            <Settings size={22} solid={section === 'settings'} aria-hidden="true" />,
            lastPaths.current.settings ?? '/apps',
            '3',
          )
        ) : (
          <Tooltip content={themeLabel} side="right">
            <button
              type="button"
              className="rail-item"
              aria-label={themeLabel}
              onClick={toggleTheme}
            >
              <span className="rail-icon">
                <ThemeIcon size={22} aria-hidden="true" />
              </span>
              <span className="rail-label">Theme</span>
            </button>
          </Tooltip>
        )}
      </nav>
      <section className="side-panel" aria-label={panelTitle} inert={panelHidden}>
        <header className="side-panel-header">
          <h2>{panelTitle}</h2>
          <Tooltip
            content="Hide menu"
            shortcut={desktop ? shortcutLabel('b', mac) : undefined}
            side="bottom"
          >
            <button
              type="button"
              className="side-panel-toggle"
              aria-label="Hide menu"
              onClick={() => onToggle(true)}
            >
              <PanelLeftClose size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        </header>
        <div className="side-panel-body">
          {section === 'scheduled' ? (
            <ul className="panel-rows">{panelLink('/tasks', 'All schedules')}</ul>
          ) : section === 'settings' ? (
            <>
              <ul className="panel-rows">
                {sidebarItems
                  .filter((item) => sidebarSection(item.path) === 'settings')
                  .map((item) => panelLink(item.path, item.label, item.icon))}
              </ul>
              {account && (
                <ul className="panel-rows panel-rows-ruled">
                  {settingsSections.map((item) => (
                    <li key={item.id}>
                      <a
                        href={item.path}
                        className={`panel-row${path === item.path ? ' panel-row-active' : ''}`}
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
            </>
          ) : (
            chats
          )}
        </div>
      </section>
      {panelHidden && (
        <Tooltip
          content="Show menu"
          shortcut={desktop ? shortcutLabel('b', mac) : undefined}
          side="right"
        >
          <button
            type="button"
            className="side-panel-show"
            aria-label="Show menu"
            onClick={() => onToggle(true)}
          >
            <PanelLeftOpen size={16} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      <div className="mobile-top-bar">
        <a
          href="/"
          className="mobile-chat-link"
          aria-label={chatLabel}
          aria-current={path === '/' ? 'page' : undefined}
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              event.button !== 0
            )
              return;
            event.preventDefault();
            setMobileMenuOpen(false);
            onNavigate('/');
          }}
        >
          <span className="nav-icon">
            <BrandMark />
            {unreadBadge}
            {statusDot}
          </span>
        </a>
        <div className="mobile-top-spacer" />
        <button
          type="button"
          ref={mobileTrigger}
          className="mobile-menu-trigger"
          aria-label="Navigation menu"
          aria-haspopup="dialog"
          aria-expanded={mobileMenuOpen}
          onClick={() => setMobileMenuOpen(true)}
        >
          <LayoutGrid size={24} aria-hidden="true" />
        </button>
        <dialog
          ref={mobileSheet}
          className="mobile-sheet"
          aria-label="Navigation menu"
          onClose={closeMobileMenu}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeMobileMenu();
          }}
        >
          <div className="mobile-sheet-body" tabIndex={-1}>
            <nav className="mobile-sections" aria-label="Sections">
              {sidebarItems.map((item) => {
                const Icon = item.icon;
                if (item.path === '/' && chats)
                  return (
                    <div
                      key={item.path}
                      className="mobile-chats"
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest('a')) closeMobileMenu();
                      }}
                    >
                      {chats}
                    </div>
                  );
                return (
                  <Fragment key={item.path}>
                    <a
                      href={item.path}
                      className="mobile-section"
                      aria-label={item.path === '/' ? chatLabel : item.label}
                      aria-current={path === item.path ? 'page' : undefined}
                      onClick={(event) => {
                        if (
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey ||
                          event.button !== 0
                        )
                          return;
                        event.preventDefault();
                        closeMobileMenu();
                        onNavigate(item.path);
                      }}
                    >
                      <span className="nav-icon">
                        <Icon size={20} solid={path === item.path} aria-hidden="true" />
                      </span>
                      <span>{item.path === '/' ? 'Main chat' : item.label}</span>
                      {item.path === '/' && unreadBadge}
                    </a>
                  </Fragment>
                );
              })}
            </nav>

            {account && (
              <div className="mobile-sheet-actions">
                <button
                  type="button"
                  onClick={() => {
                    closeMobileMenu();
                    queueMicrotask(() =>
                      account.onSettings('General', mobileTrigger.current ?? undefined),
                    );
                  }}
                >
                  <Settings size={20} aria-hidden="true" />
                  <span>Settings</span>
                </button>
              </div>
            )}
          </div>
        </dialog>
      </div>
    </aside>
  );
}
