// Actual Windows SessionWorkspace mounting, xterm parsing and resize presentation; synthetic output only.
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve('build/reports/stable-terminal');
app.disableHardwareAcceleration(); app.setPath('userData', path.join(output, 'user-data'));
let window;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  await fs.mkdir(output, {recursive:true});
  await build({stdin:{contents:`
    import {SessionWorkspace} from './src/renderer/src/session-workspace';
    import {createDefaultSettings} from './src/shared/settings';
    import '@xterm/xterm/css/xterm.css'; import './src/renderer/src/style.css';
    const sizes=[];
    window.limitsWidget={terminalResize:async(...args)=>{sizes.push(args)},terminalInput:async()=>true};
    const workspace=Object.create(SessionWorkspace.prototype);
    workspace.element=document.querySelector('#workspace'); workspace.settings=createDefaultSettings();
    workspace.runtimes=new Map();workspace.terminalHistories=new Map();workspace.scheduleTerminalHistory=()=>{};
    const pane={id:'test-pane',viewMode:'terminal'};
    const tab={id:'test-tab',sessionId:'synthetic',hostId:'synthetic',viewMode:'terminal',tool:'codex'};
    workspace.mountTerminal(pane,tab);
    const runtime=workspace.runtimes.get(tab.id);
    window.fixture={
      loading:()=>runtime.element.classList.contains('terminal-loading'),
      write:text=>runtime.presentation.output(text),
      rows:()=>Array.from({length:runtime.terminal.buffer.active.length},(_,i)=>runtime.terminal.buffer.active.getLine(i).translateToString(true)).join('\\n'),
      begin:()=>runtime.presentation.begin(),
      resize:width=>{workspace.element.style.width=width+'px';workspace.fitRuntime(runtime);},
      sizes:()=>sizes,
      offer:()=>!runtime.element.querySelector('button').hidden,
      show:()=>runtime.element.querySelector('button').click(),
      position:()=>runtime.terminal.buffer.active.viewportY,
      read:()=>runtime.terminal.scrollLines(-10)
    };
  `,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',outfile:path.join(output,'fixture.js')});
  await fs.writeFile(path.join(output,'index.html'),'<html><head><link rel="stylesheet" href="fixture.css"></head><body><div id="workspace" style="width:900px;height:600px"><div data-terminal-host="test-pane" style="width:100%;height:100%"></div></div><script src="fixture.js"></script></body></html>');
  await app.whenReady();
  window=new BrowserWindow({width:1000,height:740,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadFile(path.join(output,'index.html')); window.showInactive();
  const run=js=>window.webContents.executeJavaScript(js);
  await delay(200);
  assert.equal(await run('fixture.loading()'),true,'Must wait for initial output');
  await fs.writeFile(path.join(output,'loading.png'),(await window.webContents.capturePage()).toPNG());
  const samples=[];
  for(let i=0;i<20;i++) {
    const start=Date.now(); await run('fixture.begin()');
    const text=Array.from({length:200},(_,j)=>'synthetic-'+i+'-'+j+'\r\n').join('')+'\x1b[31mשלום 😀\x1b[0m\r\n';
    // Fragment ANSI and Unicode through the production presentation queue.
    for(const chunk of [text.slice(0,text.indexOf('😀')+1),text.slice(text.indexOf('😀')+1,-3),text.slice(-3)]) await run(`fixture.write(${JSON.stringify(chunk)})`);
    for(let j=0;j<100 && await run('fixture.loading()');j++) await delay(10);
    assert.equal(await run('fixture.loading()'),false);
    samples.push(Date.now()-start);
  }
  assert.ok((await run('fixture.rows()')).includes('שלום 😀'),'Unicode/ANSI must survive batching');
  await run('fixture.read()'); const before=await run('fixture.position()');
  await run('fixture.write("continued output\\r\\n")'); await delay(200);
  assert.equal(await run('fixture.position()'),before,'Output must preserve the reading position');
  const sizeBefore=(await run('fixture.sizes()')).length;
  for(const width of [700,720,740,800,850]) await run(`fixture.resize(${width})`);
  await delay(350);
  assert.equal((await run('fixture.sizes()')).length-sizeBefore,1,'Intermediate sizes must coalesce');
  await run('fixture.begin();fixture.write("busy")');
  for(let i=0;i<21;i++){await run('fixture.write(".")');await delay(100)}
  assert.equal(await run('fixture.offer()'),true); await run('fixture.show()');
  assert.equal(await run('fixture.loading()'),false);
  await delay(200);
  assert.equal(await run("getComputedStyle(document.querySelector('.terminal-preparing')).display"),'none');
  assert.equal(await run("getComputedStyle(document.querySelector('.xterm-screen')).visibility"),'visible');
  await fs.writeFile(path.join(output,'ready.png'),(await window.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify({synthetic:true,platform:process.platform,samplesMs:samples,medianMs:samples.slice().sort((a,b)=>a-b)[10],readingBefore:before,readingAfter:await run('fixture.position()'),sizes:await run('fixture.sizes()'),showLive:true},null,2));
  app.exit(0);
})().catch(async error=>{await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'failure.txt'),error.stack||String(error));app.exit(1)});
