// Axes are HTML, so their font sizes never scale with the SVG viewBox.
// 实际速率（绿色）带基线浅色填充；理论速率（蓝/橙）仅折线，填充先铺、线最后画保证叠放次序。
function healthChart(data, { escape, curve }) {
  const dates = data.xTime || [], count = dates.length, W = 600, H = 148;
  const valid = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const actual = data.actual || [];
  const values = [...(data.proMax || []), ...(data.lite || []), ...actual].filter(valid).map(Number);
  if (!count || !values.length) return '<div class="empty">暂无健康度数据</div>';
  const max = Math.max(20, Math.ceil(Math.max(...values) / 20) * 20);
  const x = i => count === 1 ? W / 2 : i / (count - 1) * W;
  const y = value => H - Number(value) / max * H;
  const ticks = [0, .25, .5, .75, 1];
  let svg = `<defs><linearGradient id="hActualFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#10b981" stop-opacity=".22"/><stop offset="1" stop-color="#10b981" stop-opacity="0"/></linearGradient></defs>`;
  svg += ticks.map(t => `<line x1="0" x2="${W}" y1="${H - H * t}" y2="${H - H * t}" class="healthGrid" vector-effect="non-scaling-stroke"/>`).join('');
  for (const [series, color, filled] of [[actual, '#10b981', true], [data.proMax || [], '#4082f5'], [data.lite || [], '#ff8e42']]) {
    let segment = [];
    const finish = () => {
      if (segment.length > 1) {
        if (filled) svg += `<path class="areaFill" d="${curve(segment)} L${segment[segment.length - 1][0]},${H} L${segment[0][0]},${H} Z" fill="url(#hActualFill)"/>`;
        svg += `<path class="drawLine" d="${curve(segment)}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" pathLength="1" vector-effect="non-scaling-stroke"/>`;
      }
      else if (segment.length) svg += `<circle cx="${segment[0][0]}" cy="${segment[0][1]}" r="2.5" fill="${color}"/>`;
      segment = [];
    };
    dates.forEach((_, i) => { if (valid(series[i])) segment.push([x(i), y(series[i])]); else finish(); }); finish();
  }
  const every = Math.max(1, Math.ceil((count - 1) / 4));
  const indexes = [...new Set([0, ...dates.map((_, i) => i).filter(i => i % every === 0), count - 1])];
  const labels = indexes.map(i => `<span style="left:${x(i) / W * 100}%" class="${i === 0 ? 'first' : i === count - 1 ? 'last' : ''}">${escape(String(dates[i]).slice(5, 10))}</span>`).join('');
  const value = v => valid(v) ? Number(v).toFixed(1) : '未报告';
  const actualTip = (v, n) => valid(v) ? `${Number(v).toFixed(1)} tokens/s${n ? `（${n} 次）` : ''}` : '未采样';
  const hits = dates.map((date, i) => {
    const left = count === 1 ? 0 : Math.max(0, (i - .5) / (count - 1) * 100);
    const right = count === 1 ? 100 : Math.min(100, (i + .5) / (count - 1) * 100);
    const tip = `${date}，Max / Pro：${value(data.proMax?.[i])} tokens/s，Lite：${value(data.lite?.[i])} tokens/s，实际：${actualTip(actual[i], (data.actualN || [])[i])}`;
    // 交互为十字游标（见 interactions.js highlightHealth）：垂线贴点、顶不过最高交点、交点带数值；
    // 数值走游标层渲染，这里只保留 aria-label 说明，不再弹浮动 tooltip
    return `<button class="healthPoint" data-health-index="${i}" style="left:${left}%;width:${right - left}%" aria-label="${escape(tip)}"></button>`;
  }).join('');
  return `<div class="healthChart" data-max="${max}"><div class="healthYAxis">${ticks.map(t => `<span style="bottom:${t * 100}%">${Math.round(max * t)}</span>`).join('')}</div><div class="healthPlot"><svg class="hSpeed" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${svg}</svg><div class="healthHits">${hits}</div><div class="healthCross" hidden><span class="hxDate"></span><i class="hxLine"></i><div class="hxDots"></div></div></div><div class="healthXAxis">${labels}</div></div>`;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { healthChart };
