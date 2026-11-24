/* A classic, blocking script in <head>: applies a stored theme choice before the first paint, so a window set to light or dark never flashes the other. */
try {
  const choice = JSON.parse(localStorage.getItem('orbit.theme') ?? 'null')
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice
} catch {}
