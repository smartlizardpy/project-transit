// Used only at build time to prerender the page into static HTML (scripts/prerender.mjs).
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { App } from './App.tsx';

export const render = () =>
  renderToString(
    <StrictMode>
      <App />
    </StrictMode>,
  );
