import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { I18nProvider, readStoredLocale } from './client/i18n';
import { loadZhMessages } from './client/i18n/messages';
import './index.css';

function render() {
  createRoot(document.getElementById('root')!).render(
    <I18nProvider>
      <App />
    </I18nProvider>
  );
}

// Fetch the Chinese dictionary before first paint when it is the saved locale (no English flash).
if (readStoredLocale() === 'zh-CN') {
  loadZhMessages().catch(() => undefined).finally(render);
} else {
  render();
}
