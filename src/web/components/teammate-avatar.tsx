import { useRef } from 'react';
import type { TeammateAvatar as Avatar } from '../../shared/teammates';

type Size = 'sm' | 'md' | 'lg';

export function NodAvatar({ size = 'md' }: { size?: Size }) {
  return (
    <span className={`av av-${size} av-nod`} aria-hidden="true">
      <i />
    </span>
  );
}

function useChangeKey(signature: string) {
  const shown = useRef(signature);
  const changed = useRef(false);
  if (shown.current !== signature) {
    shown.current = signature;
    changed.current = true;
  }
  return changed.current ? signature : undefined;
}

export function TeammateAvatar({
  name,
  avatar,
  size = 'md',
}: {
  name: string;
  avatar: Avatar;
  size?: Size;
}) {
  const glyph = avatar.mark || [...name.trim()][0]?.toUpperCase() || '?';
  const changeKey = useChangeKey(
    [
      avatar.hue,
      glyph,
      avatar.image ? `${avatar.image.length}${avatar.image.slice(-24)}` : '',
    ].join('|'),
  );
  const changed = changeKey ? ' av-changed' : '';
  if (avatar.image)
    return (
      <span
        key={changeKey}
        className={`av av-${size} av-image h-${avatar.hue}${changed}`}
        aria-hidden="true"
      >
        <img src={avatar.image} alt="" draggable={false} />
      </span>
    );
  return (
    <span
      key={changeKey}
      className={`av av-${size} h-${avatar.hue}${avatar.mark ? ' av-mark' : ''}${changed}`}
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}
