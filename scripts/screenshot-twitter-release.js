const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1200, height: 675 });
  await page.goto('http://localhost:8787/brand/twitter/post-0.9.6.html');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'brand/twitter/post-0.9.6.png', type: 'png' });
  await browser.close();
  console.log('Twitter post screenshot saved to brand/twitter/post-0.9.6.png');
})();
