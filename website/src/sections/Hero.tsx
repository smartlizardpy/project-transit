import { useEffect, useRef, useState } from 'react';
import { Download, GitHub, Pause, Play } from '../components/Icons.tsx';
import { Picture } from '../components/Picture.tsx';
import { HERO, RELEASE, RELEASES, REPO } from '../content/site.ts';

/** The hero's moving picture: a still first, then the real gameplay loop. Reduced motion or
 *  data saver keep the still until the visitor presses Play. */
function HeroMedia() {
  const video = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const v = HERO.video;
    const box = document.querySelector('.hero-media');
    if (!v || !box) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    // the file that fits the hero's shape. Phones show a slice of the 16:9 loop, so they get
    // a cut of that slice (aspect 1.15, cut at 58% like the still's object-position) instead
    // of the full 2560px loop; small landscape screens get 720p.
    const { width, height } = box.getBoundingClientRect();
    const wide = window.matchMedia('(min-width: 861px)').matches;
    setSrc(wide ? v.mp4 : width / height <= 1.15 ? v.phone : v.small);
    setAuto(!still && !saveData);
  }, []);

  // Started from script as well as by autoplay: iOS can refuse (Low Power Mode, for one),
  // and then the still stays and the Play button is there.
  useEffect(() => {
    const v = video.current;
    if (!v || !auto) return;
    v.muted = true;
    void v.play().catch(() => {});
  }, [src, auto]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  return (
    <>
      <Picture id={HERO.image} alt={HERO.alt} sizes="100vw" priority />
      {src && (
        <>
          <video
            ref={video}
            className="hero-video"
            data-playing={playing}
            src={src}
            autoPlay={auto}
            muted
            loop
            playsInline
            preload={auto ? 'auto' : 'none'}
            aria-hidden="true"
            onPlaying={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
          <button className="hero-video-toggle" onClick={toggle} aria-label={playing ? 'Pause the background video' : 'Play the background video'}>
            {playing ? <Pause /> : <Play />}
            {playing ? 'Pause' : 'Play'}
          </button>
        </>
      )}
    </>
  );
}

export function Hero() {
  return (
    <section className="hero" id="top" aria-labelledby="hero-title">
      <div className="hero-media">
        <HeroMedia />
      </div>
      <div className="wrap hero-wrap">
        <div className="hero-copy">
          <h1 className="display" id="hero-title">
            Build the bus network your city deserves.
          </h1>
          <p className="lead">
            Project Transit is a desktop game about running a bus company on the real streets of real cities. Draw the lines, buy the buses, write the timetable, then watch a miniature city ride to work.
          </p>
          <div className="actions">
            <a className="btn" href={RELEASES}>
              <Download />
              Download the early build
            </a>
            <a className="btn btn--quiet" href={REPO}>
              <GitHub />
              Follow on GitHub
            </a>
          </div>
          <p className="hero-meta">
            Version {RELEASE.version} for macOS, Windows and Linux. An early build, so expect rough edges.
          </p>
        </div>
      </div>
    </section>
  );
}
