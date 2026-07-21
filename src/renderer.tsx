import React from 'react';
import { createRoot } from 'react-dom/client';
import { Whiteboard } from './whiteboard/Whiteboard';
import './styles.css';

function App(): React.JSX.Element {
  return (
    <main className="app">
      <Whiteboard />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
