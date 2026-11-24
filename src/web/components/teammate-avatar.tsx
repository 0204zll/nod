import type { TeammateAvatar as Avatar } from '../../shared/teammates';

type Size = 'sm' | 'md' | 'lg';

export function NodAvatar({ size = 'md' }: { size?: Size }) {
  return (
    <span className={`av av-${size} av-nod`} aria-hidden="true">
      <i />
    </span>
  );
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
  if (avatar.image)
    return (
      <span className={`av av-${size} av-image h-${avatar.hue}`} aria-hidden="true">
        <img src={avatar.image} alt="" draggable={false} />
      </span>
    );
  const glyph = avatar.mark || [...name.trim()][0]?.toUpperCase() || '?';
  return (
    <span
      className={`av av-${size} h-${avatar.hue}${avatar.mark ? ' av-mark' : ''}`}
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}
