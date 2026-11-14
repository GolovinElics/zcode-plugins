import { test } from 'node:test';
import assert from 'node:assert/strict';
import chart from '../plugin/health-chart.js';

const helpers = {
  escape: s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  curve: points => 'M' + points.map(p => p.join(',')).join('L'),
};
test('health chart handles missing samples without connecting across gaps or scaling labels', () => {
  const html = chart.healthChart({ xTime: ['2026-11-12','2026-11-13','2026-11-14'], proMax: [120, null, 130], lite: [90, 95, 100] }, helpers);
  assert(!html.includes('<text')); // typography belongs to HTML, not the scalable SVG
  assert(!html.includes('NaN'));
  assert.equal((html.match(/<circle/g) || []).length, 2);
  assert.equal((html.match(/<path/g) || []).length, 1);
  assert(html.includes('未报告')); assert(html.includes('130.0 tokens/s'));
  assert(html.includes('healthXAxis')); assert(html.includes('non-scaling-stroke'));
});
test('one health sample stays visible and missing data has a clear empty state', () => {
  const html = chart.healthChart({xTime:['2026-11-14'],proMax:[121.5],lite:[98]},helpers);
  assert.equal((html.match(/<circle/g) || []).length, 2);
  assert(html.includes('width:100%'));
  assert(chart.healthChart({xTime:[],proMax:[],lite:[]},helpers).includes('暂无健康度数据'));
});
