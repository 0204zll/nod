import { useEffect, useState } from 'react';
import { pageTypes } from '../../shared/contracts';
import type { Page, PageType, PageVersion } from '../../shared/contracts';
import { useArtifactDrawer } from '../components/artifact-context';
import { ArtifactWorkspace } from '../components/artifact-drawer';
import type { ImagePreview } from '../components/attachment-images';
import { ChartColumn, FileText, Presentation } from '../components/icons';
import { PageTitle } from '../components/page-title';
import { Button, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api } from '../lib/api';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { navigate } from '../lib/navigation';
import './pages.css';

const types = {
  docs: { label: 'Docs', icon: FileText },
  data: { label: 'Data', icon: ChartColumn },
  slides: { label: 'Slides', icon: Presentation },
} satisfies Record<PageType, { label: string; icon: typeof FileText }>;

interface PageList {
  pages: Page[];
  next?: string;
}

function Icon({ type, size = 16 }: { type: PageType; size?: number }) {
  const Glyph = types[type].icon;
  return <Glyph size={size} />;
}

function PageRows({
  pages,
  onVersions,
}: {
  pages: Page[];
  onVersions(page: Page, versions: PageVersion[]): void;
}) {
  const drawer = useArtifactDrawer();
  const format = useDateFormat();
  const [failed, setFailed] = useState<string | null>(null);
  const open = async (page: Page) => {
    setFailed(null);
    try {
      const { versions } = await api<{ versions: PageVersion[] }>(`/api/pages/${page.id}`);
      if (!versions.length) throw new Error('The page has no versions.');
      onVersions(page, versions);
      drawer.open(versions[0].artifact.id);
    } catch {
      setFailed(page.id);
    }
  };
  return (
    <ul className="pages-list">
      {pages.map((page) => (
        <li key={page.id}>
          <button type="button" className="pages-row" onClick={() => void open(page)}>
            <span className="pages-row-type" aria-hidden="true">
              <Icon type={page.type} />
            </span>
            <span className="pages-row-title">{page.title}</span>
            <span className="pages-row-meta">
              {types[page.type].label} · Version {page.version} ·{' '}
              <time dateTime={page.createdAt}>{formatDateTime(page.createdAt, format)}</time>
            </span>
          </button>
          {failed === page.id && <Notice>This page could not be opened. Try again.</Notice>}
        </li>
      ))}
    </ul>
  );
}

export function Pages() {
  const [type, setType] = useState<PageType | null>(null);
  const { data, error, refresh } = usePageData<PageList>(
    `/api/pages${type ? `?type=${type}` : ''}`,
  );
  const [older, setOlder] = useState<Page[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [opened, setOpened] = useState<{ page: Page; versions: PageVersion[] } | null>(null);
  useEffect(() => {
    setOlder([]);
    setNext(data?.next);
  }, [data]);
  useEffect(() => {
    const attached = () => navigate('/');
    window.addEventListener('nod:attach-artifact', attached);
    return () => window.removeEventListener('nod:attach-artifact', attached);
  }, []);
  const files: ImagePreview[] = (opened?.versions ?? []).map(({ version, artifact }) => ({
    id: artifact.id,
    url: artifact.url,
    name: `${opened!.page.title} (version ${version})${/\.(?:data\.json|[a-z0-9]+)$/i.exec(artifact.name)?.[0] ?? ''}`,
    size: artifact.size,
    mimeType: artifact.mimeType,
  }));
  const shown = [
    ...(data?.pages ?? []),
    ...older.filter((page) => !data?.pages.some((item) => item.id === page.id)),
  ];
  const loadOlder = async () => {
    if (!next) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    try {
      const more = await api<PageList>(
        `/api/pages?before=${encodeURIComponent(next)}${type ? `&type=${type}` : ''}`,
      );
      setOlder((current) => [...current, ...more.pages]);
      setNext(more.next);
    } catch {
      setOlderFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  };
  return (
    <ArtifactWorkspace files={files} className="pages-workspace">
      <div className="pages-scroll">
        <div className="content-page secondary-page pages-page">
          <header className="page-heading secondary-heading">
            <PageTitle path="/pages" />
          </header>
          <div className="pages-types" role="group" aria-label="Show one type">
            {pageTypes.map((item) => (
              <button
                type="button"
                key={item}
                className="pages-type"
                aria-pressed={type === item}
                onClick={() => setType(type === item ? null : item)}
              >
                <Icon type={item} size={20} />
                {types[item].label}
              </button>
            ))}
            {type && (
              <Button variant="ghost" onClick={() => setType(null)}>
                Show all types
              </Button>
            )}
          </div>
          <div data-analytics-private>
            {error ? (
              <>
                <Notice>Your pages could not be loaded.</Notice>
                <Button variant="outline" onClick={() => void refresh()}>
                  Try again
                </Button>
              </>
            ) : !data ? (
              <div role="status">
                <Loading label="Loading pages" />
              </div>
            ) : !shown.length ? (
              <section className="pages-empty" aria-labelledby="pages-empty-title">
                <span className="pages-empty-icon" aria-hidden="true">
                  <FileText size={32} />
                </span>
                <h2 id="pages-empty-title">
                  {type ? `Nothing in ${types[type].label} yet` : 'No pages yet'}
                </h2>
                <p>
                  Ask Nod for a report, a dashboard, a specification, meeting notes or a
                  presentation. Each one is kept here, with every version.
                </p>
              </section>
            ) : (
              <>
                <PageRows
                  pages={shown}
                  onVersions={(page, versions) => setOpened({ page, versions })}
                />
                {olderFailed && <Notice>Older pages could not be loaded.</Notice>}
                {next && (
                  <Button
                    variant="outline"
                    disabled={loadingOlder}
                    onClick={() => void loadOlder()}
                  >
                    Show older pages
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </ArtifactWorkspace>
  );
}
