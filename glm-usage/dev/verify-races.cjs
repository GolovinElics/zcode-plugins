async page => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.reload();
  const f = page.frames().find(f => f.url().endsWith('/panel'));
  await f.getByRole('tab', { name: '上下文', exact: true }).click();
  await f.locator('#ctxBrowser .brCatHead').first().waitFor();
  const check = (condition, message) => { if (!condition) throw Error(message); };
  let slow = true;
  await page.route('**/rpc', async route => {
    const req = route.request().postDataJSON();
    const delay = slow && ((req.name === 'get_session_context' && req.arguments.session_id === 'sess_demo_1') || (req.name === 'get_context_browser' && req.arguments.prev) || (req.name === 'get_insights' && req.arguments.range === 'today'));
    const response = await route.fetch();
    if (delay) await new Promise(resolve => setTimeout(resolve, 650));
    await route.fulfill({ response });
  });
  await f.locator('#ctxSession').selectOption('sess_demo_1', { force: true });
  await f.locator('#ctxSession').selectOption('sess_demo_2', { force: true });
  await f.locator('#ctxStatsSub').getByText('构建项目知识检索接口', { exact: true }).waitFor();
  await page.waitForTimeout(750);
  check((await f.locator('#ctxStatsSub').innerText()) === '构建项目知识检索接口', 'late session overwrote current one');
  check(await f.evaluate(() => state.browser.session_id) === 'sess_demo_2', 'browser belongs to wrong session');
  await f.locator('[data-snapshot=prev]').click();
  await f.locator('[data-snapshot=live]').click();
  await page.waitForTimeout(750);
  check((await f.locator('#browserMeta').innerText()).includes('128.6k'), 'late previous snapshot overwrote live');
  await f.getByRole('tab', { name: '洞察', exact: true }).click();
  await f.locator('#rangeBar [data-r=today]').click();
  await f.locator('#rangeBar [data-r="30d"]').click();
  await page.waitForTimeout(750);
  check(await f.locator('#insDailyChart [data-day]').count() === 30, 'late range response overwrote selected range');
  slow = false;
  await page.unroute('**/rpc');

  // Exercise the custom combobox using keyboard input.
  await f.getByRole('tab', { name: '上下文', exact: true }).click();
  await f.locator('.ctxHead .selectTrigger').click();
  await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  await f.locator('#ctxStatsSub').getByText('优化插件上下文交互与数据联动', { exact: true }).waitFor();
  check(!await f.locator('.ctxHead .selectPopup').isVisible(), 'combobox did not close');
  check(await f.locator('.ctxHead .selectTrigger').evaluate(el => el === document.activeElement), 'combobox did not return focus');

  // Empty session must clear the old chart rather than retaining another session's data.
  await page.route('**/rpc', async route => {
    const req = route.request().postDataJSON(), response = await route.fetch();
    if (req.name === 'get_session_context' && req.arguments.session_id === 'sess_demo_3') {
      const body = await response.json(), payload = JSON.parse(body.content[0].text);
      payload.data.steps = []; payload.data.session.steps = 0; payload.data.live = null;
      body.content[0].text = JSON.stringify(payload);
      await route.fulfill({ response, body: JSON.stringify(body) });
    } else if (req.name === 'get_context_browser' && req.arguments.session_id === 'sess_demo_3') {
      await route.fulfill({ response, body: JSON.stringify({ content: [{type:'text',text:JSON.stringify({ok:false,error:'该会话没有可读的 model-io 记录'})}] }) });
    } else await route.fulfill({ response });
  });
  await f.locator('#ctxSession').selectOption('sess_demo_3', { force: true });
  await f.locator('#ctxTrend').getByText('该会话暂无模型请求记录').waitFor();
  check(await f.locator('#ctxTrend [data-step]').count() === 0, 'empty session retained chart');
  check((await f.locator('#ctxCurN').innerText()) === '—', 'empty session retained current context');
  await page.unroute('**/rpc');
  await f.locator('#ctxSession').selectOption('sess_demo_0', { force: true });
  await f.locator('#ctxBrowser .brCatHead').first().waitFor();
  await f.locator('#ctxBrowser .brCatHead').first().focus();
  await page.keyboard.press('Enter');
  check(await f.locator('#ctxBrowser .brCat').first().getAttribute('class').then(x => x.includes('open')), 'category keyboard expansion failed');
  await f.locator('#ctxBrowser .brItem').first().focus();
  await f.locator('#hoverTip').waitFor({state:'visible'});
  const inside = await f.locator('#hoverTip').evaluate(el => { const r = el.getBoundingClientRect(); return !el.hidden && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
  check(inside, 'tooltip outside viewport');
  check((await f.locator('#hoverTip').innerText()).includes('tokens'), 'keyboard tooltip does not describe focused item');
  return { passed: ['late session response', 'late snapshot response', 'late range response', 'combobox keyboard and focus', 'empty state clears stale content', 'category keyboard expansion', 'tooltip bounds'] };
}
