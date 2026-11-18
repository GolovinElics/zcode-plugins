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
  assert(html.includes('未报告')); assert(html.includes('130.0 tokens/s')); // 由 aria-label 承载（十字游标替代浮动 tooltip）
  assert(html.includes('healthXAxis')); assert(html.includes('non-scaling-stroke'));
  assert(html.includes('healthCross')); assert(html.includes('data-max="140"')); // 游标层 + 标尺最大值供交互换算
  assert(!html.includes('data-tip')); // 矩形带高亮与浮动 tooltip 已由十字游标取代
});
test('one health sample stays visible and missing data has a clear empty state', () => {
  const html = chart.healthChart({xTime:['2026-11-14'],proMax:[121.5],lite:[98]},helpers);
  assert.equal((html.match(/<circle/g) || []).length, 2);
  assert(html.includes('width:100%'));
  assert(chart.healthChart({xTime:[],proMax:[],lite:[]},helpers).includes('暂无健康度数据'));
});
test('actual rate draws as a baseline-filled series with per-day tooltip counts', () => {
  const html = chart.healthChart({ xTime: ['2026-11-14','2026-11-15','2026-11-16','2026-11-17'], proMax:[120,124,126,128], lite:[95,96,98,99], actual:[61.5,58,64.2,null], actualN:[87,105,60,null] }, helpers);
  assert(html.includes('areaFill')); assert(html.includes('hActualFill'));
  assert.equal((html.match(/drawLine/g) || []).length, 3); // 实际 + Max/Pro + Lite 三条线
  assert(html.includes('实际：64.2 tokens/s（60 次）'));
  assert(html.includes('实际：未采样')); // xTime 有但当天无本地样本
});
test('actual-only payload still renders when the official snapshot is unavailable', () => {
  const html = chart.healthChart({ xTime: ['2026-11-15','2026-11-16'], lite:[], proMax:[], actual:[70,72.5] }, helpers);
  assert(html.includes('drawLine')); assert(html.includes('areaFill')); assert(!html.includes('NaN'));
  assert(html.includes('暂无健康度数据') === false);
});
test('the summary uses each series’ latest reported date and skips official zero placeholders', () => {
  const dates = ['2026-11-17', '2026-11-18', '2026-11-19'];
  assert.deepEqual(chart.latestHealthSample(dates, [120, '127.3', 0]), {value:127.3,date:dates[1],index:1});
  assert.deepEqual(chart.latestHealthSample(dates, [89, null, ' ']), {value:89,date:dates[0],index:0});
  assert.deepEqual(chart.latestHealthSample(dates, [65, 62, 0], true), {value:0,date:dates[2],index:2});
  assert.equal(chart.latestHealthSample(dates, [null, false, 'bad']), null);
});
