import { useRef, useState } from 'react';
import { Next, Prev } from '../components/Icons.tsx';
import { Lightbox } from '../components/Lightbox.tsx';
import { Picture, hasMedia } from '../components/Picture.tsx';
import { SectionHead } from '../components/SectionHead.tsx';
import { GALLERY } from '../content/gallery.ts';

export function Screenshots() {
  const shots = GALLERY.filter((s) => hasMedia(s.id));
  const [open, setOpen] = useState<number | null>(null);
  const strip = useRef<HTMLUListElement>(null);
  const scroll = (dir: number) => {
    const el = strip.current;
    const item = el?.querySelector('li');
    if (el && item) el.scrollBy({ left: dir * (item.getBoundingClientRect().width + 20), behavior: 'smooth' });
  };
  return (
    <section className="sec" id="screenshots" aria-labelledby="screenshots-title">
      <div className="wrap">
        <div className="strip-head">
          <SectionHead id="screenshots" title="Straight from the game." lead="Screenshots of the current build with the interface hidden. Open one to see it full size." />
          <div className="strip-buttons">
            <button className="icon-btn" onClick={() => scroll(-1)} aria-label="Scroll the screenshots back">
              <Prev />
            </button>
            <button className="icon-btn" onClick={() => scroll(1)} aria-label="Scroll the screenshots on">
              <Next />
            </button>
          </div>
        </div>
      </div>
      <ul className="strip" ref={strip}>
        {shots.map((s, i) => (
          <li key={s.id} className="strip-item">
            <button onClick={() => setOpen(i)} aria-label={`View full size: ${s.title}`}>
              <Picture id={s.id} alt={s.alt} sizes="(min-width: 900px) 46vw, 84vw" />
            </button>
            <span className="strip-title">{s.title}</span>
          </li>
        ))}
      </ul>
      <Lightbox shots={shots} index={open} onIndex={setOpen} />
    </section>
  );
}
