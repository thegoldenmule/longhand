import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@longhand/editor/styles.css';
import '@longhand/annotations/styles.css';
import '@longhand/provenance-ui/styles.css';
import '@longhand/binder/styles.css';
import '@longhand/research/research.css';
import '@longhand/report/styles.css';
import './globals.css';
import { configFromEnv } from '../src/config';

export const metadata: Metadata = {
  title: 'Longhand',
  description: 'A calm writing app with an AI editor that never writes your words.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f4ee' },
    { media: '(prefers-color-scheme: dark)', color: '#1a1917' },
  ],
};

// Read the environment per request, so one build runs anywhere.
export const dynamic = 'force-dynamic';

// Sets data-theme before first paint: the saved choice, a ?theme= override, or the system.
const THEME_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search).get('theme');var p=q||localStorage.getItem('longhand:theme')||'system';var d=p==='dark'||(p!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.dataset.theme=d?'dark':'light';r.dataset.themePref=p;}catch(e){document.documentElement.dataset.theme='light';}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  const config = configFromEnv(process.env);
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__LONGHAND__=${JSON.stringify(config).replace(/</g, '\\u003c')};`,
          }}
        />
      </head>
      <body className="lh-app">{children}</body>
    </html>
  );
}
