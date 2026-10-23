// Run: node dist/browser-cli.js run < demo/example.mjs
// A minimal script: open a tab, read the accessibility-oriented snapshot, close it.

const ui = await page.newTab('https://example.com');
console.log('title:', await ui.title());
console.log(await ui.snapshot({ scope: 'viewport' }));
console.log('url:', await ui.url());
await ui.closeTab();
