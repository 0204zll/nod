import { useEffect, useState, type ComponentProps } from 'react';
import type { Page, PageVersion } from '../../shared/contracts';
import { useArtifactDrawer } from '../components/artifact-context';
import { ArtifactWorkspace } from '../components/artifact-drawer';
import { DataThumbnail } from '../components/attachment-card';
import type { ImagePreview } from '../components/attachment-images';
import { FileText, Trash2 } from '../components/icons';
import { PageTitle } from '../components/page-title';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Loading,
  Notice,
  SearchField,
} from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { attachmentKind } from '../lib/attachment-kind';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { navigate } from '../lib/navigation';
import './pages.css';

type ThumbnailKind = ComponentProps<typeof DataThumbnail>['kind'];

interface PageList {
  pages: Page[];
  next?: string;
}

function PageCards({
  pages,
  onVersions,
  onDelete,
}: {
  pages: Page[];
  onVersions(page: Page, versions: PageVersion[]): void;
  onDelete(page: Page): void;
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
    <ul className="pages-grid">
      {pages.map((page) => {
        const kind = attachmentKind(page.artifact.mimeType, page.artifact.name);
        return (
          <li key={page.id} className="pages-card">
            <button type="button" className="pages-card-open" onClick={() => void open(page)}>
              {kind ? (
                <DataThumbnail item={page.artifact} kind={kind as ThumbnailKind} wide />
              ) : (
                <span className="pages-card-blank" aria-hidden="true">
                  <FileText size={32} />
                </span>
              )}
              <span className="pages-card-details">
                <span className="pages-card-title">{page.title}</span>
                <span className="pages-card-meta">
                  Version {page.version} ·{' '}
                  <time dateTime={page.createdAt}>{formatDateTime(page.createdAt, format)}</time>
                </span>
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="pages-card-delete"
              aria-label={`Delete ${page.title}`}
              title="Delete"
              onClick={() => onDelete(page)}
            >
              <Trash2 size={15} />
            </Button>
            {failed === page.id && <Notice>This page could not be opened. Try again.</Notice>}
          </li>
        );
      })}
    </ul>
  );
}

export function Pages() {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const filter = search ? `q=${encodeURIComponent(search)}` : '';
  const { data, error, refresh } = usePageData<PageList>(`/api/pages${filter && `?${filter}`}`);
  const [older, setOlder] = useState<Page[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [opened, setOpened] = useState<{ page: Page; versions: PageVersion[] } | null>(null);
  const [deleting, setDeleting] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    setDeleteError('');
    try {
      await api(`/api/pages/${deleting.id}`, { method: 'DELETE' });
      if (opened?.page.id === deleting.id) setOpened(null);
      setOlder((current) => current.filter((page) => page.id !== deleting.id));
      setDeleting(null);
      await refresh();
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
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
        `/api/pages?before=${encodeURIComponent(next)}${filter && `&${filter}`}`,
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
          <SearchField
            className="pages-search"
            type="search"
            value={query}
            placeholder="Search"
            aria-label="Search pages by title"
            onChange={(event) => setQuery(event.target.value)}
          />
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
            ) : !shown.length && search ? (
              <p className="pages-no-results">No pages match “{search}”.</p>
            ) : !shown.length ? (
              <section className="pages-empty" aria-labelledby="pages-empty-title">
                <span className="pages-empty-icon" aria-hidden="true">
                  <FileText size={32} />
                </span>
                <h2 id="pages-empty-title">No pages yet</h2>
                <p>
                  Ask Nod for a specification, a runbook, a weekly update or meeting notes as a
                  page. Each one is kept here, with every version.
                </p>
              </section>
            ) : (
              <>
                <PageCards
                  pages={shown}
                  onVersions={(page, versions) => setOpened({ page, versions })}
                  onDelete={(page) => {
                    setDeleteError('');
                    setDeleting(page);
                  }}
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
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Delete {deleting?.title}?</DialogTitle>
          <p className="field-hint">
            Every version is deleted and the page is removed from the chat it was made in. This
            cannot be undone.
          </p>
          {deleteError && <Notice>{deleteError}</Notice>}
          <div className="dialog-actions">
            <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </ArtifactWorkspace>
  );
}
