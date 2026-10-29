import type { Map as MlMap } from 'maplibre-gl';

function canvasImage(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, ratio = 2) {
  const c = document.createElement('canvas');
  c.width = w * ratio;
  c.height = h * ratio;
  const ctx = c.getContext('2d')!;
  ctx.scale(ratio, ratio);
  draw(ctx);
  return { image: ctx.getImageData(0, 0, c.width, c.height), ratio };
}

/** Procedural map icons (original artwork). */
export function addMapImages(map: MlMap) {
  // One-way arrow painted onto the road surface.
  const arrow = canvasImage(30, 12, (ctx) => {
    ctx.fillStyle = '#8a959c';
    ctx.strokeStyle = '#8a959c';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(3, 6);
    ctx.lineTo(20, 6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(27, 6);
    ctx.lineTo(19, 1.2);
    ctx.lineTo(19, 10.8);
    ctx.closePath();
    ctx.fill();
  });
  if (!map.hasImage('oneway')) map.addImage('oneway', arrow.image, { pixelRatio: arrow.ratio });

  // Direction chevron used along route lines (white disc, coloured chevron drawn via SDF tint).
  const chevron = canvasImage(18, 18, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(9, 9, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1b2420';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(7.2, 5.2);
    ctx.lineTo(11, 9);
    ctx.lineTo(7.2, 12.8);
    ctx.stroke();
  }, 3);
  if (!map.hasImage('route-chevron')) map.addImage('route-chevron', chevron.image, { pixelRatio: chevron.ratio });
}
