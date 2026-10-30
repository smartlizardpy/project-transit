// Full-screen viewer for the screenshots. A native <dialog> gives focus trapping, Esc to
// close and focus return for free; arrows and swipes move between images.
import { useEffect, useRef } from 'react';
import { Close, Next, Prev } from './Icons.tsx';
import { Picture } from './Picture.tsx';

export interface Shot {
  id: string;
  title: string;
  caption: string;
  alt: string;
}

export function Lightbox({ shots, index, onIndex }: { shots: Shot[]; index: number | null; onIndex: (i: number | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const touch = useRef<number | null>(null);
  const shot = index === null ? null : shots[index];
  const go = (d: number) => index !== null && onIndex((index + d + shots.length) % shots.length);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (index !== null && !d.open) d.showModal();
    if (index === null && d.open) d.close();
  }, [index]);

  // warm the neighbours so stepping through feels instant
  useEffect(() => {
    if (index === null) return;
    for (const d of [1, -1]) {
      const s = shots[(index + d + shots.length) % shots.length];
      const img = new Image();
      img.sizes = '100vw';
      img.srcset = document.querySelector<HTMLImageElement>(`[data-shot="${s.id}"] img`)?.srcset ?? '';
    }
  }, [index, shots]);

  return (
    <dialog
      ref={dialog}
      className="lightbox"
      aria-label={shot ? `Screenshot: ${shot.title}` : 'Screenshot viewer'}
      onClose={() => onIndex(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') go(1);
        else if (e.key === 'ArrowLeft') go(-1);
      }}
      onClick={(e) => {
        // a click on the dark area around the image closes it
        const t = e.target as HTMLElement;
        if (t === dialog.current || t.classList.contains('lightbox-stage')) onIndex(null);
      }}
      onPointerDown={(e) => (touch.current = e.pointerType === 'mouse' ? null : e.clientX)}
      onPointerUp={(e) => {
        if (touch.current === null) return;
        const dx = e.clientX - touch.current;
        touch.current = null;
        if (Math.abs(dx) > 48) go(dx < 0 ? 1 : -1);
      }}
    >
      {shot && index !== null && (
        <>
          <div className="lightbox-bar">
            <span className="lightbox-count tnum" aria-live="polite">
              {index + 1} of {shots.length}
            </span>
            <button className="icon-btn" onClick={() => onIndex(null)} aria-label="Close" autoFocus>
              <Close />
            </button>
          </div>
          <div className="lightbox-stage">
            <div className="lightbox-img" key={shot.id}>
              <Picture id={shot.id} alt={shot.alt} sizes="(max-width: 700px) 100vw, 88vw" />
            </div>
            <button className="icon-btn lightbox-prev" onClick={() => go(-1)} aria-label="Previous screenshot">
              <Prev />
            </button>
            <button className="icon-btn lightbox-next" onClick={() => go(1)} aria-label="Next screenshot">
              <Next />
            </button>
          </div>
          <p className="lightbox-caption">
            <strong>{shot.title}.</strong> {shot.caption}
          </p>
        </>
      )}
    </dialog>
  );
}
