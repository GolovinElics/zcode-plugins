import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Keep the MCP resource self-contained: ZCode's sandbox does not fetch local assets.
export async function panelResource(root = resolve(import.meta.dirname, '..')) {
  const names = ['bridge.js', 'panel.css', 'app.js', 'request-metrics.js', 'health-chart.js', 'charts.js', 'context-browser.js', 'interactions.js', 'activity.js', 'pricing-ui.js', 'persistence.js'];
  const [html, ...assets] = await Promise.all([
    readFile(resolve(root, 'panel.html'), 'utf8'),
    ...names.map(name => readFile(resolve(root, name), 'utf8')),
  ]);
  return names.reduce((text, name, i) => text.replace(`/* @inline:${name} */`, () => assets[i]), html);
}
