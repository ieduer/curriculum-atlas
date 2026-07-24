(() => {
  const storageKey = 'curriculum-atlas-theme-v1';
  let theme = 'dark';
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === 'dark' || stored === 'light') theme = stored;
  } catch {
    // Storage may be unavailable in privacy-restricted contexts; dark remains the default.
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#edf1ee' : '#050814');
})();
