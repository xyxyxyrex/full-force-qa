# Parity 1.4.8

## WebView stability

- Fix a crash when switching from multiple device previews to a single viewport after a Firefox or WebKit comparison.
- Fix the same crash when leaving Edit for another workspace after a browser comparison.
- Handle Electron's synchronous errors when a preview WebView detaches before temporary scrollbar CSS is cleaned up, including delayed CSS insertion during navigation.

This patch changes desktop preview cleanup only. No database migration is required.
