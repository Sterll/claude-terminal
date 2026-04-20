const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('http://localhost:8787/brand/banner-readme.html');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'banner-readme.png', type: 'png' });
  await browser.close();
  console.log('Banner screenshot saved to banner-readme.png');
})();
