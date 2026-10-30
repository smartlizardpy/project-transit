import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import '@fontsource-variable/figtree/wght.css';
import './styles/site.css';
import { App } from './App.tsx';

// Marks that scripts run, so the load animation only plays when the page is live.
document.documentElement.classList.add('js');

const root = document.getElementById('root')!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);
// The build prerenders the page into index.html (scripts/prerender.mjs); dev starts empty.
if (root.firstElementChild) hydrateRoot(root, app);
else createRoot(root).render(app);
