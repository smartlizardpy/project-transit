// Responsive AVIF/WebP images produced by scripts/optimize-media.mjs.
import MEDIA from '../content/media.json';
import { BASE } from '../content/site.ts';

interface Meta {
  width: number;
  height: number;
  widths: number[];
}

const media = MEDIA as Record<string, Meta>;

export const hasMedia = (id: string) => id in media;

export function mediaUrl(id: string, width?: number, ext: 'avif' | 'webp' = 'webp') {
  const m = media[id];
  return `${BASE}media/${id}-${width ?? m.widths.at(-1)}.${ext}`;
}

interface Props {
  id: string;
  alt: string;
  /** the `sizes` attribute: how wide the image is drawn at each viewport width */
  sizes?: string;
  /** above the fold: load first */
  priority?: boolean;
  className?: string;
}

export function Picture({ id, alt, sizes = '100vw', priority = false, className }: Props) {
  const m = media[id];
  if (!m) {
    // only during development, before the image has been generated
    return (
      <div className={`media--placeholder ${className ?? ''}`} role="img" aria-label={alt}>
        missing media: {id}
      </div>
    );
  }
  const set = (ext: 'avif' | 'webp') => m.widths.map((w) => `${mediaUrl(id, w, ext)} ${w}w`).join(', ');
  const fallback = m.widths[Math.min(1, m.widths.length - 1)];
  return (
    <picture className={className}>
      <source type="image/avif" srcSet={set('avif')} sizes={sizes} />
      <img
        src={mediaUrl(id, fallback)}
        srcSet={set('webp')}
        sizes={sizes}
        width={m.width}
        height={m.height}
        alt={alt}
        loading={priority ? 'eager' : 'lazy'}
        decoding={priority ? 'sync' : 'async'}
        fetchPriority={priority ? 'high' : 'auto'}
      />
    </picture>
  );
}
