// The screenshot strip. Every image is a capture of the real game with its interface hidden
// (F10), made by website/scripts/capture-media.mjs. Captions say exactly what is on screen.
// Shots whose media has not been made yet are skipped.
import type { Shot } from '../components/Lightbox.tsx';

export const GALLERY: Shot[] = [
  {
    id: 'closeup',
    title: 'İstanbul, the Galata Bridge',
    caption: 'Three buses on the Galata Bridge, where lines 1, 2 and 3 share the road.',
    alt: 'Three buses in coral livery on the Galata Bridge with teal, amber and violet lines beneath them.',
  },
  {
    id: 'closeup-tokyo',
    title: 'Tokyo, near Omotesando',
    caption: 'Buses on lines 1 and 2 at a junction between tall blocks, with the depot on the corner.',
    alt: 'Three buses at a junction near Omotesando in Tokyo, between tall miniature buildings, with teal and amber lines and a depot.',
  },
  {
    id: 'closeup-hamburg',
    title: 'Hamburg, the Altstadt',
    caption: 'Three lines share a main road through the old town, with a canal behind.',
    alt: 'Buses on a wide road in Hamburg’s old town with teal, amber and violet lines and a canal behind the buildings.',
  },
  {
    id: 'closeup-b',
    title: 'İstanbul, into Karaköy',
    caption: 'The same bridge from the other side, with buses heading for the Karaköy stops.',
    alt: 'Buses crossing the Galata Bridge towards Karaköy, with stop markers on the shore.',
  },
  {
    id: 'closeup-barcelona',
    title: 'Barcelona, Plaça de Catalunya',
    caption: 'Three buses meet at the edge of Plaça de Catalunya.',
    alt: 'Three buses at a junction on the edge of Plaça de Catalunya in Barcelona, with the square’s gardens below.',
  },
  {
    id: 'closeup-durham',
    title: 'Durham, by the Wear',
    caption: 'Two buses on Leazes Road, with the river Wear and a park behind.',
    alt: 'Two buses on a road in Durham beside a roundabout, with the river Wear and trees behind.',
  },
  {
    id: 'territory',
    title: 'Operating areas',
    caption: 'The map squares a company owns, the ones it can license next with their prices, and blank map beyond.',
    alt: 'The operating areas view over İstanbul: owned map squares in full colour, neighbouring squares under a veil with prices, and blank map beyond.',
  },
];
