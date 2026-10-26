(() => {
  const storageKey = 'curriculum-atlas-theme-v1';
  const root = document.documentElement;
  let theme = null;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === 'dark' || stored === 'light') theme = stored;
  } catch {
    // Storage may be unavailable; fall back to the system preference.
  }
  if (!theme) theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.dataset.theme = theme;
  root.dataset.js = '';
  root.style.colorScheme = theme;
  // index.html is also the fallback for /document/…, /historical/… and old links;
  // hide the home content for those paths before it paints.
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/' && path !== '/index.html' && !/^\/(s\/[a-z]+|taiwan|search|ai|discussions|admin)(\.html)?$/.test(path)) {
    root.dataset.route = 'app';
  }
})();
