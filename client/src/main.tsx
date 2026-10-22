import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installDisplayScaling } from './utils/displayScale';

installDisplayScaling();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
