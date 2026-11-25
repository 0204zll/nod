import { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Copy, Download, List, Plus } from './icons';
import type { Artifact } from '../../shared/contracts';
import type { ImagePreview } from './attachment-images';
import { ownedArtifactUrl } from '../lib/attachment-url';
import { copyImage, selectedText } from '../lib/clipboard';
import { desktopFileAction, desktopFilesAvailable, nativeFileMenu } from '../lib/desktop';
import { errorMessage } from '../lib/api';
import { Button } from './ui';
import { analyticsForCurrentSession } from '../lib/analytics';
import { attachmentKind } from '../lib/attachment-kind';
import { ActionMenu, ActionMenuItem, actionMenuTabTarget } from './action-menu';
import { appStyles, inlineBlobs, printDocument, printReset } from '../lib/print';

export function reuseFile(
  item: ImagePreview,
  location: 'message' | 'drawer' | 'commands' | 'composer',
  capture = analyticsForCurrentSession(),
) {
  const artifact = artifactFromPreview(item);
  if (!ownedArtifactUrl(artifact.url)) return false;
  window.dispatchEvent(new CustomEvent('nod:attach-artifact', { detail: artifact }));
  capture('artifact_action', {
    kind: attachmentKind(artifact.mimeType, artifact.name) ?? 'file',
    location,
    action: 'reuse_requested',
  });
  return true;
}

export function fileDrag(event: React.DragEvent, item: ImagePreview) {
  const artifact = artifactFromPreview(item);
  if (!ownedArtifactUrl(artifact.url)) return;
  event.dataTransfer.setData('application/x-nod-artifact', JSON.stringify(artifact));
  event.dataTransfer.setData('text/uri-list', new URL(artifact.url, location.origin).href);
  event.dataTransfer.effectAllowed = 'copy';
  if (desktopFilesAvailable()) {
    event.preventDefault();
    void desktopFileAction(artifact.id, 'drag').catch((cause) =>
      window.dispatchEvent(new CustomEvent('nod:file-notice', { detail: errorMessage(cause) })),
    );
  }
}

export function prepareFile(item: ImagePreview) {
  const artifact = artifactFromPreview(item);
  if (desktopFilesAvailable() && ownedArtifactUrl(artifact.url))
    void desktopFileAction(artifact.id, 'prepare').catch(() => {});
}

export function FileActions({
  item,
  location = 'message',
}: {
  item: ImagePreview;
  location?: 'message' | 'drawer';
}) {
  const artifact = artifactFromPreview(item);
  const kind = attachmentKind(item.mimeType ?? '', item.name) ?? 'file';
  const actions = useRef<HTMLSpanElement>(null);
  const noticePanel = useRef<HTMLDivElement>(null);
  const noticeTabTarget = useRef<HTMLElement | null>(null);
  const focusNotice = useRef(false);
  const focusOrigin = useRef<HTMLElement | null>(null);
  const returnFocus = useRef(true);
  const activeId = useRef(item.id);
  activeId.current = item.id;
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setNotice('');
    setBusy(false);
    focusNotice.current = false;
    focusOrigin.current = null;
  }, [item.id]);
  useEffect(() => {
    if (!busy || !focusNotice.current) return;
    const cancel = () => {
      focusNotice.current = false;
    };
    const moved = (event: FocusEvent) => {
      if (event.target !== focusOrigin.current) cancel();
    };
    document.addEventListener('focusin', moved, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    return () => {
      document.removeEventListener('focusin', moved, true);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
    };
  }, [busy]);
  const image = /^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(item.mimeType ?? '');
  useEffect(() => {
    const target =
      actions.current?.closest<HTMLElement>(
        '.attachment-card,.attachment-image-item,.artifact-drawer-panel',
      ) ?? actions.current;
    if (!target || !desktopFilesAvailable()) return;
    const open = (event: MouseEvent) => {
      if (
        selectedText(target) ||
        (event.target as Element).closest('a[href],input,textarea,select,[contenteditable]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void menu();
    };
    target.addEventListener('contextmenu', open);
    return () => target.removeEventListener('contextmenu', open);
  }, [item.id, item.url, item.downloadUrl, image]);
  useEffect(() => {
    if (!notice || notice === 'Saved to Downloads') return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const exportable =
    location !== 'drawer'
      ? null
      : kind === 'html'
        ? 'HTML file'
        : kind === 'presentation'
          ? 'PowerPoint file'
          : kind === 'data-page'
            ? 'Data file'
            : null;
  if (!ownedArtifactUrl(artifact.url)) return null;
  async function run(action: string, origin?: HTMLElement, capture = analyticsForCurrentSession()) {
    if (action === 'reuse') {
      reuseFile(item, location, capture);
      return;
    }
    focusOrigin.current = origin ?? null;
    focusNotice.current = action === 'save' && origin === document.activeElement;
    const id = item.id;
    if (activeId.current === id) setBusy(true);
    try {
      if (action === 'print') {
        if (kind === 'presentation') {
          const slides = actions.current
            ?.closest('.artifact-drawer')
            ?.querySelector('.artifact-slides');
          if (!slides) throw new Error('The slides have not finished loading.');
          printDocument(
            await inlineBlobs(slides.outerHTML),
            `<style>${appStyles()}\n@page{size:landscape;margin:10mm}${printReset}.artifact-slides{display:block;overflow:visible;padding:1px;background:none}.artifact-slide{display:block;break-after:page;break-inside:avoid}.artifact-slide:last-child{break-after:auto}.artifact-slide figcaption{display:none}.artifact-slide,.artifact-slides{border:0!important;box-shadow:none!important;outline:0!important}.slide-canvas{box-sizing:border-box;border:1px solid #d6d6d6;border-radius:0;box-shadow:none!important}</style>`,
          );
          capture('artifact_action', { kind, location, action: 'print' });
          return;
        }
        const response = await fetch(artifact.url, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`The file could not be read (${response.status}).`);
        const text = await response.text();
        if (kind === 'data-page') {
          const [{ renderToStaticMarkup }, { DataPageView }, { createElement }] = await Promise.all(
            [import('react-dom/server'), import('./data-page'), import('react')],
          );
          printDocument(
            renderToStaticMarkup(
              createElement(DataPageView, {
                text,
                fallback: createElement('p', null, 'This data page could not be read.'),
              }),
            ),
            `<style>${appStyles()}\n@page{margin:14mm}${printReset}.data-page-scroll{height:auto;overflow:visible}.data-page{max-width:none;padding:0}.data-block-heading button{display:none}.data-block,.data-figure,.data-callout,.data-table tr{break-inside:avoid}</style>`,
          );
        } else printDocument(text);
        capture('artifact_action', { kind, location, action: 'print' });
      } else if (action === 'copy') {
        await copyImage(artifact.url);
        capture('artifact_action', { kind, location, action: 'copy' });
        if (activeId.current === id) setNotice('Image copied');
      } else {
        await desktopFileAction(artifact.id, action as 'save' | 'open' | 'show' | 'prepare');
        if (action === 'save') capture('artifact_action', { kind, location, action: 'download' });
        else if (action === 'open' || action === 'show')
          capture('artifact_action', {
            kind,
            location,
            action: action === 'open' ? 'open' : 'reveal',
          });
        if (activeId.current === id) setNotice(action === 'save' ? 'Saved to Downloads' : '');
      }
    } catch (cause) {
      if (activeId.current === id) setNotice(errorMessage(cause));
    } finally {
      if (activeId.current === id) setBusy(false);
    }
  }
  async function menu() {
    const capture = analyticsForCurrentSession();
    try {
      const action = await nativeFileMenu(artifact.id, image);
      if (action) await run(action, undefined, capture);
    } catch (cause) {
      setNotice(errorMessage(cause));
    }
  }
  return (
    <Popover.Root
      open={Boolean(notice)}
      onOpenChange={(open) => {
        if (!open) setNotice('');
      }}
    >
      <Popover.Anchor asChild>
        <span className="file-actions" ref={actions}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Use ${item.name} in message`}
            title="Add to message"
            onClick={() => reuseFile(item, location)}
          >
            <Plus size={15} />
          </Button>
          {image && (
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label={`Copy image ${item.name}`}
              title="Copy image"
              onClick={() => void run('copy')}
            >
              <Copy size={15} />
            </Button>
          )}
          {exportable ? (
            <ActionMenu
              label={`Download ${item.name}`}
              disabled={busy}
              trigger={
                <Button variant="ghost" size="icon" title="Download">
                  <Download size={15} />
                </Button>
              }
            >
              {(close) => (
                <>
                  <ActionMenuItem
                    onClick={() => {
                      close();
                      if (desktopFilesAvailable()) void run('save');
                      else {
                        const link = document.createElement('a');
                        link.href = artifact.url;
                        link.download = item.name;
                        link.click();
                        analyticsForCurrentSession()('artifact_action', {
                          kind,
                          location,
                          action: 'download_requested',
                        });
                      }
                    }}
                  >
                    {exportable}
                  </ActionMenuItem>
                  <ActionMenuItem
                    onClick={() => {
                      close();
                      void run('print');
                    }}
                  >
                    PDF
                  </ActionMenuItem>
                </>
              )}
            </ActionMenu>
          ) : desktopFilesAvailable() ? (
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label={`Save ${item.name}`}
              title="Save to Downloads"
              onClick={(event) =>
                void run('save', event.detail === 0 ? event.currentTarget : undefined)
              }
            >
              <Download size={15} />
            </Button>
          ) : (
            <Button variant="ghost" size="icon" title="Download file" asChild>
              <a href={artifact.url} download={item.name} aria-label={`Download ${item.name}`}>
                <Download size={15} />
              </a>
            </Button>
          )}
          {desktopFilesAvailable() && (
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label={`File actions for ${item.name}`}
              title="More file actions"
              onClick={() => void menu()}
            >
              <List size={15} />
            </Button>
          )}
        </span>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          ref={noticePanel}
          role="status"
          className="file-action-notice"
          data-analytics-private
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            noticeTabTarget.current = null;
            returnFocus.current = true;
            const origin = focusOrigin.current;
            if (
              focusNotice.current &&
              (document.activeElement === origin ||
                (document.activeElement === document.body && origin && !origin.isConnected))
            )
              (
                noticePanel.current?.querySelector<HTMLElement>('button') ?? noticePanel.current
              )?.focus({ preventScroll: true });
            focusNotice.current = false;
            focusOrigin.current = null;
          }}
          onInteractOutside={() => {
            returnFocus.current = false;
            noticeTabTarget.current = null;
          }}
          onKeyDownCapture={(event) => {
            if (
              event.key !== 'Tab' ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.nativeEvent.isComposing
            )
              return;
            const items = Array.from(
              noticePanel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a') ?? [],
            );
            if (document.activeElement !== (event.shiftKey ? items[0] : items.at(-1))) return;
            event.preventDefault();
            event.stopPropagation();
            const controls = Array.from(
              actions.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a') ?? [],
            );
            noticeTabTarget.current = actionMenuTabTarget(
              event.shiftKey ? controls[0] : controls.at(-1),
              event.shiftKey,
              noticePanel.current,
            );
            setNotice('');
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = noticeTabTarget.current;
            noticeTabTarget.current = null;
            if (!returnFocus.current) return;
            if (target?.isConnected) target.focus({ preventScroll: true });
            else if (document.activeElement === document.body)
              actions.current
                ?.querySelector<HTMLElement>('button:not(:disabled),a')
                ?.focus({ preventScroll: true });
          }}
        >
          {notice}
          {notice === 'Saved to Downloads' && (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => void run('open')}>
                Open
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void run('show')}>
                Show in folder
              </Button>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function artifactFromPreview(item: ImagePreview): Artifact {
  const url = item.downloadUrl && ownedArtifactUrl(item.downloadUrl) ? item.downloadUrl : item.url;
  return {
    id: ownedArtifactUrl(url) ? url.slice('/api/artifacts/'.length) : item.id,
    name: item.name,
    mimeType: item.mimeType ?? 'application/octet-stream',
    size: item.size,
    url,
  };
}
