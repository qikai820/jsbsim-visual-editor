import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installDisplayScaling } from './utils/displayScale';
import { trimBrowserCaches } from './utils/browserCache';
import { NativePx4Toolbox } from './components/Px4ToolboxWindow';

trimBrowserCaches();
installDisplayScaling();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get('window')==='px4-toolbox'?<NativePx4Toolbox/>:<App />}
  </React.StrictMode>
);
