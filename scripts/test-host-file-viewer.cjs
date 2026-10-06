// Runs the built viewer and preload in a sandboxed Electron window without a host.
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
protocol.registerSchemesAsPrivileged([{ scheme: 'fleet-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const root = path.resolve(process.env.HOST_FILE_VIEWER_APP_ROOT || path.join(__dirname, '..'));
const output = path.resolve(process.env.HOST_FILE_VIEWER_REPORT_ROOT || path.join(__dirname, '..', 'build', 'reports', 'host-file-viewer'));
app.disableHardwareAcceleration();
app.setPath('userData', path.join(output, 'isolated-user-data'));
let win; let state; let bytes = Buffer.from(''); let generation = 0; const actions = []; const checks = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(script, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await win.webContents.executeJavaScript(script)) return;
    await pause(200);
  }
  throw new Error(message);
}
async function show(kind, name, text) {
  console.log('Rendering ' + kind + ': ' + name);
  state = { metadata: { protocolVersion: 1, name, size: bytes.length, modifiedAt: '2026-10-06T10:00:00Z', revision: 'a'.repeat(64), mediaKind: kind },
    message: 'Verified current host file', host: 'origin-host', ready: true, busy: false, excerpt: false, url: 'fleet-preview://fixture/content?generation=' + (++generation), text };
  win.webContents.send('hostFilePreview:updated');
}
app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  ipcMain.handle('hostFilePreview:state', () => state || { message: 'Loading', ready: false, busy: true, url: '' });
  ipcMain.handle('hostFilePreview:action', (_event, action) => { actions.push(action); });
  win = new BrowserWindow({ width: 1060, height: 780, show: false, webPreferences: {
    preload: path.join(root, 'out/preload/host-file-preview.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'viewer-test'
  } });
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const rendererRoot = path.join(root, 'out', 'renderer');
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const url = new URL(details.url);
    let allowed = !['http:', 'https:', 'ftp:', 'ws:', 'wss:'].includes(url.protocol);
    if (url.protocol === 'file:') {
      const file = path.resolve(require('node:url').fileURLToPath(url));
      allowed = details.resourceType !== 'subFrame' && (file === path.join(rendererRoot, 'host-file-preview.html') || file.startsWith(path.join(rendererRoot, 'assets') + path.sep));
    }
    callback({ cancel: !allowed });
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-frame-navigate', (event) => { if (!['about:blank', 'about:srcdoc'].includes(event.url)) event.preventDefault(); });
  win.webContents.session.protocol.handle('fleet-preview', () => new Response(bytes, { headers: { 'Content-Type': state?.metadata?.mediaKind === 'pdf' ? 'application/pdf' : 'image/svg+xml', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } }));
  await win.loadFile(path.join(root, 'out/renderer/host-file-preview.html'));
  await show('text', 'outside-project.txt', 'Current host bytes');
  await poll("document.querySelector('pre')?.textContent==='Current host bytes'", 'Text preview did not render');
  await win.webContents.executeJavaScript("document.querySelector('[data-action=save]').click()");
  await poll("document.querySelector('#title').textContent.includes('origin-host')", 'Origin was not shown');
  assert.deepEqual(actions, ['save']); checks.push('text, immutable origin label, Save action');
  await fs.writeFile(path.join(output, 'text.png'), await (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("window.sandboxProbe=null;window.addEventListener('message',event=>{if(event.data?.type==='preview-probe')window.sandboxProbe=event.data})");
  const html = `<button id="counter" onclick="this.textContent='Clicked'">Click me</button><script>
    const probe={type:'preview-probe',bridge:'',network:'',file:'',interactive:''};
    try{probe.bridge=typeof parent.hostFilePreview}catch{probe.bridge='blocked'}
    Promise.all([fetch('https://example.invalid/preview-test').then(()=>probe.network='allowed').catch(()=>probe.network='blocked'),
    fetch('file:///C:/Windows/win.ini').then(()=>probe.file='allowed').catch(()=>probe.file='blocked')]).then(()=>{
      document.getElementById('counter').click();probe.interactive=document.getElementById('counter').textContent;parent.postMessage(probe,'*')})
    </script>`;
  await show('html', 'interactive.html', html);
  await poll('window.sandboxProbe!==null', 'Interactive HTML did not complete its probe');
  const probe = await win.webContents.executeJavaScript('window.sandboxProbe');
  assert.equal(probe.bridge, 'blocked'); assert.equal(probe.network, 'blocked'); assert.equal(probe.file, 'blocked'); assert.equal(probe.interactive, 'Clicked');
  checks.push('HTML scripts work; parent bridge, network and local files blocked');
  await fs.writeFile(path.join(output, 'html.png'), await (await win.webContents.capturePage()).toPNG());
  bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#146c94"/><text x="30" y="150" fill="white" font-size="30">Host image preview</text></svg>');
  await show('image', 'image.svg');
  await poll("document.querySelector('#content>img')?.naturalWidth===600", 'Image did not render');
  await win.webContents.executeJavaScript("const zoom=document.querySelector('#zoom');zoom.value='200';zoom.dispatchEvent(new Event('input'))");
  assert.ok(await win.webContents.executeJavaScript("parseInt(document.querySelector('#content>img').style.width)>1000")); checks.push('image decode and zoom');
  const pdfWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await pdfWindow.loadURL('data:text/html,<h1>Page one</h1><h1 style="break-before:page">Page two</h1>');
  bytes = await pdfWindow.webContents.printToPDF({}); pdfWindow.close();
  await show('pdf', 'two-pages.pdf');
  await poll("document.querySelector('#pages').textContent==='of 2'&&document.querySelector('canvas')", 'PDF pages did not render');
  await win.webContents.executeJavaScript("const page=document.querySelector('#page');page.value='2';page.dispatchEvent(new Event('change'))");
  await poll("document.querySelector('[data-page=\\\"2\\\"]')?.getAttribute('aria-busy')==='false'", 'PDF navigation did not finish rendering page two');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#page').value"), '2');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('[data-page=\\\"2\\\"] canvas').getContext('2d').getImageData(0,0,1,1).data[3]"), 255);
  checks.push('bundled PDF worker, page render and page navigation');
  await pause(1000);
  await fs.writeFile(path.join(output, 'pdf.png'), await (await win.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify({ status: 'passed', appRoot: root, checks, htmlProbe: probe, limitations: ['Fixture state replaces live transport; production viewer and preload are used.'] }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }));
  win.close(); app.quit();
}).catch((error) => { console.error(error.stack); app.exit(1); });
setTimeout(() => { console.error('Viewer test timed out'); app.exit(1); }, 120000).unref();
