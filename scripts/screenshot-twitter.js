const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Set viewport size
  await page.setViewportSize({ width: 1200, height: 675 });

  // Navigate to the Twitter post HTML
  await page.goto('http://localhost:8787/brand/twitter/post-0.8.3.html');

  // Wait for fonts to load
  await page.waitForTimeout(500);

  // Take screenshot
  await page.screenshot({
    path: 'E:/Perso/ClaudeTerminal/brand/twitter/post-0.8.3.png',
    fullPage: false
  });

  await browser.close();
  console.log('Twitter post screenshot saved to brand/twitter/post-0.8.3.png');
})();
