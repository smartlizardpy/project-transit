import { useEffect, useRef, useState } from 'react';
import { Download, GitHub, Pause, Play } from '../components/Icons.tsx';
import { Picture, mediaUrl } from '../components/Picture.tsx';
import { HERO, RELEASE, RELEASES, REPO } from '../content/site.ts';

/** The hero's moving picture: a still first, then the real gameplay loop if the visitor's
 *  settings allow it (no reduced motion, no data saver). */
function HeroMedia() {
  const video = useRef<HTMLVideoElement>(null);
  const [allowed, setAllowed] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!HERO.video) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    // phones get the still: the loop is a few megabytes and the hero is small there
    const wide = window.matchMedia('(min-width: 861px)').matches;
    setAllowed(!still && !saveData && wide);
  }, []);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  return (
    <>
      <Picture id={HERO.image} alt={HERO.alt} sizes="100vw" priority />
      {allowed && HERO.video && (
        <>
          <video
            ref={video}
            className="hero-video"
            data-playing={playing}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            poster={mediaUrl(HERO.image, 1920)}
            aria-hidden="true"
            onPlaying={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          >
            {/* H.264 first: every browser plays it, while some WebKit builds stall on VP9 WebM */}
            <source src={HERO.video.mp4} type="video/mp4" />
            {HERO.video.webm && <source src={HERO.video.webm} type="video/webm" />}
          </video>
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
