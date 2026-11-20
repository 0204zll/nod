const ease = 'cubic-bezier(0.32, 0.72, 0, 1)';
const duration = 300;
const anchored: Array<[string, 'left' | 'center']> = [
  ['.chat-header-copy', 'left'],
  ['.conversation-column', 'center'],
  ['.draft-chat > *', 'center'],
  ['.content-page', 'left'],
];
const running = new Set<Animation>();

export function movePanel(shell: HTMLElement | null, change: () => void, animate: boolean) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (!shell || !animate || typeof shell.animate !== 'function') {
    for (const animation of running) animation.cancel();
    running.clear();
    change();
    return;
  }
  const panel = shell.querySelector<HTMLElement>('.side-panel');
  const panelFrom = panel ? getComputedStyle(panel).transform : 'none';
  const items = reduce
    ? []
    : anchored.flatMap(([selector, anchor]) =>
        [...shell.querySelectorAll<HTMLElement>(`.main-workspace ${selector}`)]
          .filter((element) => element.getClientRects().length)
          .map((element) => ({ element, anchor, before: element.getBoundingClientRect() })),
      );
  for (const animation of running) animation.cancel();
  running.clear();
  change();
  const opening = !shell.classList.contains('panel-hidden');
  const track = (animation: Animation) => {
    running.add(animation);
    animation.finished.then(
      () => running.delete(animation),
      () => running.delete(animation),
    );
  };
  if (panel)
    track(
      panel.animate(
        reduce
          ? [
              { opacity: opening ? 0 : 1, visibility: 'visible', transform: 'none' },
              { opacity: opening ? 1 : 0, visibility: 'visible', transform: 'none' },
            ]
          : [
              {
                transform: panelFrom === 'none' && !opening ? 'translateX(0)' : panelFrom,
                visibility: 'visible',
              },
              { transform: opening ? 'translateX(0)' : 'translateX(-100%)', visibility: 'visible' },
            ],
        { duration: reduce ? 200 : duration, easing: reduce ? 'ease' : ease },
      ),
    );
  if (!opening) {
    const show = shell.querySelector<HTMLElement>('.side-panel-show');
    if (show)
      track(
        show.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 150,
          delay: reduce ? 0 : duration / 2,
          easing: 'ease',
          fill: 'backwards',
        }),
      );
  }
  for (const { element, anchor, before } of items) {
    const after = element.getBoundingClientRect();
    const dx =
      anchor === 'left'
        ? before.left - after.left
        : before.left + before.width / 2 - (after.left + after.width / 2);
    if (Math.abs(dx) < 1) continue;
    track(
      element.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], {
        duration,
        easing: ease,
        composite: 'add',
      }),
    );
  }
}
