# Project Transit — Design System (prototype v0.1)

An original system derived from the City Transport Manager research in
[`visual-research.md`](visual-research.md) and [`reference-board.md`](reference-board.md).
We adopt the *principles* that make the reference calm (muted world, saturated
transport layer, dark compact cards). We do not copy its assets, logo, pin shapes,
"H" stop sign or layouts.

> **Core rule:** the world is pale and quiet, the transport network is the only
> saturated thing on the map, and UI lives on dark, compact cards that float above it.

---

## 1. World palette (map)

Measured from the reference (median patches / k-means on the iPad close-ups), then
tuned for our renderer. Source of truth: `src/map/palette.ts`.

| Token | Hex | Measured reference | Use |
|---|---|---|---|
| ground | `#ebe8e0` | `#eceae2` / `#f1f0ea` | land, plazas |
| road | `#c6ced1` | `#c4cccd` / `#c2cbcd` | all drivable roads, one colour, **no casing** |
| roadMajor | `#bfc8cc` | — | primary/secondary, a touch deeper |
| bridge casing | `#a9b4b9` | — | only under bridges so they read over water |
| path | `#d8dbd6` | — | footways, lighter than roads |
| park | `#c9dbbb` | `#c6d8b9` / `#cddbc0` | parks, grass |
| wood | `#bdd3ad` | — | woodland |
| water | `#a4cad6` | `#a2c9d3` | sea, rivers (flat, no reflections) |
| water edge | `#b6d5de` | — | soft blurred shallows line |
| building tops | `#d9d7d0` `#dcd8ce` `#e3e0d8` `#d9cdc2` `#ddd3c4` `#d2d3cd` | tops `#d5d2c9`, warm `#d1c8bd` | weighted per building by hash |
| roofs (hipped) | `#d3bcaa` `#cdb5a6` `#d0cec7` | pinkish hip roofs in Hamburg | muted terracotta suits Istanbul |
| leafy tree | `#8fbd5f` → `#76a957` | fresh yellow-green crowns | |
| conifer / cypress | `#417c5d` / `#3d6e52` | dark teal-green cones | cemeteries get cypresses |
| street label | `#68727d` | slate grey, lies on the road | |

**Lighting.** No cast shadows on buildings: the reference has none. Shading is
baked per face with a fixed sun from the south-west:
- roof/top = 100 % of the base colour
- walls 75 %–96 % by orientation to the sun, with a 7 % darker foot (a hint of
  ambient occlusion)
- hipped roof faces 80 %–106 %
- tree crowns are faceted (70 %–112 %) so the low-poly form reads

Only trees get **soft blob shadows**, which the reference shows under every tree.

**Heights.** OSM height used when present. Otherwise conservative storeys for a
dense Mediterranean centre are inferred from footprint area, plus a stable hash
for variety: <22 m² → 1–2 floors, <70 m² → 2–4, <380 m² → 3–6, <1400 m² → 3–5,
larger → 2–4. The occasional block gets +2. Floor = 3.15 m. Small convex
four-sided footprints get hipped roofs (≈55 %).

**Zoom behaviour.** z < 13.9: flat building footprints and a calm 2D map. z 13.9–14.7:
buildings *grow* out of the ground. Above that, full miniature city. Street
labels appear from z14.6, one-way arrows from z16.3, route chevrons from z14.8.

## 2. Transport layer (the only saturated colours on the map)

| Line | Colour | Notes |
|---|---|---|
| 26 | `#2f9e9a` teal | |
| 32 | `#e3a33b` amber | |
| 46 | `#8b6fd6` violet | |
| draft / editing | `#4fa3e0` blue, dashed | same as the UI accent: "this is your action" |
| company livery | `#e0573e` coral-red | white body, red skirt, dark glazing band |

- Route lines are 2–11 px by zoom, with a thin white halo, **offset to the right
  of travel**. Outbound and return legs on the same street therefore appear as
  two parallel ribbons, like real bus lanes.
- Direction chevrons sit in white discs ringed in the line colour.
- Selection: the focused line widens (×1.25) with a soft white glow and other
  lines dim to 28 %.
- Traffic (simulated): green `#62c98d` → lime → amber `#f0c04f` → orange →
  red `#de5a5a`, drawn per direction.
- Demand heat: transparent teal → sage → amber → coral → raspberry.

## 3. UI palette

Dark, slightly green-tinted charcoal, after the reference panels (`#181e1a` /
`#222b26`), shifted to our own values.

| Token | Hex | Use |
|---|---|---|
| `--card` | `#161c19` | floating card surface |
| `--card-raised` | `#202823` | inner sections, list rows |
| `--card-hover` | `#28312b` | hover on rows/buttons |
| `--seg-active` | `#2e3d3f` | selected segment (blue-slate) |
| `--seg-active-money` | `#2f4436` | selected segment in finance views |
| `--hairline` | `rgba(255,255,255,0.07)` | dividers |
| `--text` | `#f3f2ec` | primary text (warm white) |
| `--text-2` | `#a9b4ac` | secondary |
| `--text-3` | `#738078` | tertiary, captions |
| `--accent` | `#4fa3e0` | primary action, focus ring, drafts |
| `--mint` | `#8fdcae` | money, positive |
| `--green` | `#5fd18e` | good bars |
| `--amber` | `#f0c169` | warning text/bars |
| `--coral` | `#ef8f7d` | losses, errors |
| `--brand` | `#e0573e` | company identity only |

Never use pure black or pure white surfaces. Gradients appear only in load bars
(green→amber→coral) and the demand ramp.

## 4. Typography

**Figtree** (OFL) throughout UI *and* map labels. Map glyphs are generated from
the same TTFs into SDF PBFs (`public/fonts/`), so the world and the cards speak
in one voice. It is friendly and geometric like the reference's rounded sans,
but crisper at desktop sizes.

| Role | Size / weight | Notes |
|---|---|---|
| Big number | 26/800 | balance, clock uses 22/800 |
| Card title | 15/700 | |
| Section label | 11/700, +0.08em, uppercase, `--text-3` | |
| Body | 13/500 | |
| Small / meta | 12/500 `--text-2` | |
| Chip / badge | 11–12/800 | line numbers |
| Map street label | Figtree SemiBold 10–17 px, +0.04em, on the road plane | |
| District label | Figtree Bold, uppercase, +0.22em, `#7d838b` | |

Numbers use tabular figures; currency is compact (`₺18.42M`, `+₺48.9k`).

## 5. Layout

Desktop-first, map fills the window. 16 px safe margin, 8 px grid.

```
┌──────────────────────────────────────────────────────────────────────┐
│ [Company card]         [ ⏸ ▶ ▶▶ ▶▶▶ | 07:42 Tue · Day 38 ]   [₺ | +/day | ☺ | 🔔] │
│ ┌──┐                                                                  │
│ │🖱│  (management panel                         ┌──────────────────┐  │
│ │🚏│   docks here, 400px)                       │  Inspector       │  │
│ │〰│                                            │  360 px, slides  │  │
│ │──│                                            │  in from right   │  │
│ │🕸│                                            └──────────────────┘  │
│ │🚦│                                                                  │
│ │🔥│                                                                  │
│ └──┘                 [ bottom tray: route editing only ]   [zoom/compass] │
└──────────────────────────────────────────────────────────────────────┘
```

- **Left rail** (52 px): tools (Select, Add stop, Create route), then a divider,
  then views (Network, Traffic, Demand).
- **Management panels** (Lines, Fleet, Finances) dock beside the rail at 400 px.
  The inspector on the right can stay open alongside them. That is the desktop
  advantage: list on the left, object detail on the right, map in the middle.
- **Inspector** (360 px) appears only with a selection. Esc or × closes it.
- **Bottom tray** appears only while a route is being drafted.
- At ≤1440 px wide, the inspector narrows to 336 px and panels to 372 px. At
  ≤1280 px, the top-right stats collapse to two.

## 6. Components

- **Card**: radius 14, padding 14–16, `--card`, shadow
  `0 10px 30px rgba(18,22,20,.28), 0 2px 6px rgba(18,22,20,.18)`, 1 px inner
  hairline. No blur, no glass.
- **Section** (inside a card): radius 10, `--card-raised`, padding 12.
- **Segmented control**: track `--card-raised`, 3 px inset, active segment
  `--seg-active` with 8 px radius. A sliding indicator animates 180 ms.
- **Buttons**: primary is `--accent` fill with dark-navy text `#0c2233`, 36 px
  high, radius 9, 600 weight. Secondary is `--card-raised`. Ghost-icon buttons
  are 32 px. Circular close button is 30 px `#262f2a`.
- **Line badge**: rounded rectangle (radius 6), line colour, 800-weight white
  number, min-width 28.
- **Load bar**: 6 px track `#334039`; fill green→amber→coral by value, with a white
  2 px tick at the current value.
- **Stat chip** (top bar): icon + value 15/800 + caption 11/600.
- **Tooltip**: `#0f1412`, radius 8, 12/600 label plus a key-cap for its shortcut.
  It appears after 350 ms and slides 4 px.
- **Stop marker** (map): our own design. A white disc with a dark-green bus
  pictogram on a short stem, line-colour pips below it, and the name in a white
  pill (12/700 `#3d4650`). It is *not* a teardrop and has no "H".
- **Destination marker**: a 22 px rounded square in its category colour with a
  white glyph and a small dark count bubble.

## 7. Iconography

Phosphor icons (MIT) in UI at 18 px (rail) and 16 px (inline), "bold" weight for
tools and "fill" for active states. Map glyphs (bus, stop, landmarks) are
hand-drawn inline SVGs (original).

## 8. Motion

- Panels: 220 ms `cubic-bezier(.2,.8,.2,1)` slide (12 px) plus fade. Exit 160 ms.
- Hover: 120 ms background/colour changes. Buttons press to `scale(.97)`.
- Camera: `flyTo`/`easeTo` 900–1200 ms when selecting from lists. Click-to-select
  on the map never moves the camera; the player stays in control.
- Buildings grow in over 650 ms when a tile arrives and with zoom (z13.9–14.7).
- The selection ring pulses ±6 % at 0.5 Hz. Nothing else on the map pulses.

## 9. Interaction states

| State | Treatment |
|---|---|
| Hover vehicle | thin white ground ring and a floating tag (`26 · 62/98`) |
| Selected vehicle | pulsing ring, inspector opens, its line highlights |
| Hover line | widens with a halo, pointer cursor |
| Selected line | others dim, the stops' catchments draw as dashed rings |
| Hover/selected stop | 300 m catchment ring (dashed) |
| Route tool | crosshair cursor, dashed preview to the cursor, numbered draft stops |
| Disabled (not in demo) | 45 % opacity plus a "Soon" tag in the tooltip |
