async page => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.reload();
  const f = page.frames().find(f => f.url().endsWith('/panel'));
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const results = [];
  await f.getByRole('tab', {name:'上下文',exact:true}).click();
  await f.locator('#ctxBrowser .brCatHead').first().waitFor();
  await f.locator('#ctxTokensBody .lgRow').first().hover();
  check(await f.locator('#ctxTokensBody .segArc.dimmed').count() === 3, 'donut does not dim other slices');
  check((await f.locator('#ctxTokensBody .lc-donut-center').innerText()).includes('缓存读取'), 'donut center does not follow legend');
  await f.locator('#ctxTokensBody .lgRow').first().click();
  await f.locator('#ctxStats').hover();
  check(await f.locator('#ctxTokensBody .segArc.highlighted').count() === 1, 'pinned donut lost on mouse leave');
  await page.keyboard.press('Escape');
  check(await f.locator('#ctxTokensBody .segArc.dimmed').count() === 0, 'escape does not reset donut');
  results.push('donut hover, pin, reset');

  await f.locator('#ctxCurLegend [data-pick-cat=tool_results]').click();
  check(await f.locator('#ctxBrowser .brCat').count() === 1, 'category filter does not link to browser');
  await f.locator('#ctxBrowser .brItem').first().waitFor();
  const firstItem = await f.locator('#ctxBrowser .brItem').first().elementHandle();
  const beforeKey = await firstItem.getAttribute('data-item');
  await f.locator('#refreshBtn').click();
  await f.locator('#refreshBtn:not([disabled])').waitFor();
  check(await firstItem.evaluate(el => el.isConnected), 'refresh replaced keyed row');
  check(await f.locator('#ctxBrowser .brItem').first().getAttribute('data-item') === beforeKey, 'refresh lost expansion');
  results.push('category linked selection and refresh identity');

  await f.locator('#ctxBrowser .brItem').first().click();
  await f.locator('#inspectorCopy:not([disabled])').waitFor();
  check((await f.locator('#inspectorContent').innerText()).includes('export function'), 'full content did not load');
  await f.locator('#inspectorNext').click();
  await f.locator('#inspectorCopy:not([disabled])').waitFor();
  check(await f.locator('#itemDialog').evaluate(el => el.open), 'next item closed inspector');
  await page.keyboard.press('Escape');
  check(!await f.locator('#itemDialog').evaluate(el => el.open), 'dialog escape failed');
  results.push('content inspector, next item, Escape');

  await f.locator('#browserSelection button').click();
  await f.locator('#dnaMode [data-m=dna]').click();
  const seq = await f.locator('.dnaRow .ix').allTextContents();
  check(seq.every((v, i) => i === 0 || Number(v) > Number(seq[i - 1])), 'DNA not in request order');
  await f.locator('#browserSearch').fill('TrendChart');
  check((await f.locator('.dnaRow').count()) > 0, 'DNA search empty');
  check((await f.locator('.dnaRow').count()) < seq.length, 'DNA search did not filter');
  await f.locator('#browserClear').click();
  await f.locator('#dnaMode [data-m=map]').click();
  check(await f.locator('.mapTile').count() > 10, 'map tiles missing');
  await f.locator('.mapTile').first().click();
  await f.locator('#inspectorCopy:not([disabled])').waitFor();
  await page.keyboard.press('Escape');
  await f.locator('[data-snapshot=prev]').click();
  await f.locator('#browserPanel[aria-busy=false]').waitFor();
  check((await f.locator('#browserMeta').innerText()).includes('122.5k'), 'previous snapshot not displayed');
  await f.locator('[data-snapshot=live]').click();
  await f.locator('#browserPanel[aria-busy=false]').waitFor();
  results.push('DNA order, search, map, previous snapshot');

  await f.locator('#trendMode [data-m=delta]').click();
  check(await f.locator('#ctxTrend rect[fill="#e5735f"]').count() > 0, 'negative deltas missing');
  const last = f.locator('#ctxTrend [data-step]').last();
  await last.click();
  check(await f.locator('#ctxTrendDetail').isVisible(), 'trend detail not shown');
  await last.focus(); await page.keyboard.press('ArrowLeft');
  check((await f.locator('#ctxTrendDetail').innerText()).includes('第 71 步'), 'keyboard trend navigation failed');
  await page.keyboard.press('Escape');
  check(!await f.locator('#ctxTrendDetail').isVisible(), 'trend selection not cleared');
  await f.locator('#ctxEvents [data-event-ts]').first().click();
  check(await f.locator('#ctxTrend .selected').count() === 1, 'event did not focus trend');
  results.push('signed delta, trend selection, keyboard, event link');

  await f.getByRole('tab', {name:'洞察',exact:true}).click();
  await f.locator('#insSessions .sCard').first().waitFor();
  check(await f.locator('#insSessions .sCard').count() === 6, 'session data not loaded');
  await f.locator('#sessArchive').evaluate(el => { el.value = 'active'; el.dispatchEvent(new Event('change', {bubbles:true})); });
  check(await f.locator('#insSessions .sCard').count() === 5, 'archived session filter failed');
  await f.locator('#clearSessionFilters').click();
  await f.locator('#sessSearch').fill('缓存');
  check(await f.locator('#insSessions .sCard').count() === 2, 'session search failed');
  await f.locator('#clearSessionFilters').click();
  await f.locator('#insDailyChart [data-day]').first().click();
  check(await f.locator('#insSessions .sCard').count() === 2, 'day filter failed');
  await f.locator('#clearSessionFilters').click();
  results.push('archive, search and day filters');

  await f.locator('#insCmdsList [data-activity]').first().click();
  await f.locator('#activitySummary [data-lens=failed]').waitFor();
  await f.locator('#activitySummary [data-lens=failed]').click();
  check(await f.locator('#activityRows .activityRecord').count() === 6, 'failed command filter failed');
  await f.locator('#activitySummary [data-lens=background]').click();
  check(await f.locator('#activityRows .activityRecord').count() === 5, 'background command filter failed');
  await f.locator('#activitySummary [data-lens=all]').click();
  await f.locator('#activitySearch').fill('pnpm');
  check(await f.locator('#activityRows .activityRecord').count() === 10, 'command search failed');
  await f.locator('.activityRecordHead').first().click();
  check(await f.locator('.activityDetail').count() === 1, 'command detail did not expand');
  await page.keyboard.press('Escape');
  results.push('activity summary lenses, search, details');

  await f.getByRole('tab',{name:'Agent',exact:true}).click();
  await f.locator('.agentCard').first().waitFor();
  check(await f.locator('.agentCard').count() === 3, 'agent graph missing');
  await f.locator('#agentEdges path').first().waitFor({state:'attached'});
  check(await f.locator('#agentEdges path').first().evaluate(el => el.namespaceURI === 'http://www.w3.org/2000/svg' && el.getTotalLength() > 20), 'agent connectors did not render as SVG');
  await f.locator('.agentChildren .agentCard').first().hover();
  check(await f.locator('.agentHot').count() === 2, 'agent graph and row not linked');
  await f.locator('.agentChildren .agentCard').first().click();
  await f.locator('#tab-context[aria-busy=false]').waitFor();
  check((await f.locator('#ctxStatsSub').innerText()).includes('缓存'), 'agent context navigation failed');
  results.push('agent hover and navigation');

  for (const width of [760, 390]) {
    await page.setViewportSize({width,height:900});
    for (const tab of ['用量','洞察','上下文','Agent']) {
      await f.getByRole('tab',{name:tab,exact:true}).click();
      const overflow = await f.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      check(!overflow, `${tab} overflows at ${width}`);
    }
  }
  await page.setViewportSize({width:1440,height:1100});
  await page.emulateMedia({reducedMotion:'reduce'});
  check(await f.locator('#themebtn svg').evaluate(el => getComputedStyle(el).transitionDuration === '0s'), 'reduced motion not respected');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await f.getByRole('tab',{name:'上下文',exact:true}).click();
  await f.locator('#themebtn').click();
  results.push('760px / 390px all pages, reduced motion, theme');
  check(errors.length === 0, errors.join('\n'));
  return {passed:results,errors};
}
