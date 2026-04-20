const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Set viewport size
  await page.setViewportSize({ width: 1280, height: 420 });

  // Navigate to the banner HTML
  await page.goto('http://localhost:8787/brand/banner-readme.html');

  // Wait for fonts to load
  await page.waitForTimeout(500);

  // Take screenshot
  await page.screenshot({
    path: 'E:/Perso/ClaudeTerminal/banner-readme.png',
    fullPage: false
  });

  await browser.close();
  console.log('Banner screenshot saved to banner-readme.png');
})();
