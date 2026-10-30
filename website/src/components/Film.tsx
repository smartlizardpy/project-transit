// A gameplay clip that plays while it is on screen. It starts as a still (the poster) and
// only loads the video when scrolled to. Reduced motion or data saver keep the still until
// the visitor presses Play.
import { useEffect, useRef, useState } from 'react';
import { BASE } from '../content/site.ts';
import { Pause, Play } from './Icons.tsx';
import { Picture, hasMedia } from './Picture.tsx';

export const hasFilm = (id: string) => hasMedia(`${id}-poster`);

export function Film({ id, alt, sizes }: { id: string; alt: string; sizes: string }) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const held = useRef(false); // paused by the visitor, or held still by their settings

  useEffect(() => {
    const el = box.current;
    const v = video.current;
    if (!el || !v) return;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || saveData) held.current = true;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !held.current) void v.play().catch(() => {});
        else if (!e.isIntersecting) v.pause();
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    held.current = !v.paused;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  return (
    <div className="film" ref={box}>
      <Picture id={`${id}-poster`} alt={alt} sizes={sizes} />
      <video
        ref={video}
        data-playing={playing}
        muted
        loop
        playsInline
        preload="none"
        aria-hidden="true"
        onPlaying={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      >
        <source src={`${BASE}media/${id}.mp4`} type="video/mp4" />
        <source src={`${BASE}media/${id}.webm`} type="video/webm" />
      </video>
      <button className="film-toggle" onClick={toggle} aria-label={playing ? 'Pause the gameplay video' : 'Play the gameplay video'}>
        {playing ? <Pause /> : <Play />}
        {playing ? 'Pause' : 'Play'}
      </button>
    </div>
  );
}
