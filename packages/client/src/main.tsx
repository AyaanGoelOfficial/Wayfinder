import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const el = document.getElementById('root');
if (el === null) throw new Error('#root is missing from index.html');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
