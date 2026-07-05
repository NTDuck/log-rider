const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  await page.goto('http://localhost:3001/dashboard');
  
  // Login
  await page.type('#username', 'Ayin');
  await page.type('#password', 'admin123');
  await page.click('button[type="submit"]');
  
  await page.waitForTimeout(2000);
  
  // Reload
  await page.reload();
  await page.waitForTimeout(2000);
  
  const trs = await page.$$eval('#logs-body tr', rows => rows.length);
  console.log('NUM ROWS:', trs);
  
  await browser.close();
})();
