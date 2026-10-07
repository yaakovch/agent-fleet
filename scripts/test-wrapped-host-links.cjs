// Real xterm pointer gestures and built viewer. Files and host transport are isolated fixtures.
const {app,BrowserWindow,ipcMain} = require('electron');
const {build} = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const output = path.resolve('build/reports/wrapped-host-links');
const viewerAssets = path.resolve(process.env.AGENT_FLEET_REVIEW_VIEWER_ROOT || 'out');
app.disableHardwareAcceleration(); app.setPath('userData',path.join(output,'user-data'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let terminalWindow; let viewer; let state; const calls=[];
async function until(fn,message) { for(let i=0;i<100;i++){if(await fn())return;await delay(50)}throw new Error(message) }
(async()=>{
  await fs.mkdir(output,{recursive:true});
  await fs.writeFile(path.join(output,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('limitsWidget',{openHostFile:(...args)=>ipcRenderer.invoke('wrapped:open',...args),openExternalLink:()=>{throw new Error('unexpected external route')}});`);
  await build({stdin:{contents:`
    import {Terminal} from '@xterm/xterm'; import '@xterm/xterm/css/xterm.css';
    import {SessionWorkspace} from './src/renderer/src/session-workspace';
    const workspace=Object.create(SessionWorkspace.prototype);
    const terminal=new Terminal({cols:72,rows:12,fontSize:16,scrollback:100});terminal.open(document.querySelector('#terminal'));
    workspace.bindHostFileLinks(terminal,{sessionId:'origin-session',hostId:'origin-host',id:'origin-tab'});
    window.fixture={
      write:async(text)=>{terminal.reset();await new Promise(resolve=>terminal.write(text,resolve));},
      point:(row,col)=>{const rect=document.querySelector('.xterm-screen').getBoundingClientRect();return{x:Math.round(rect.x+(col+.5)*rect.width/terminal.cols),y:Math.round(rect.y+(row+.5)*rect.height/terminal.rows)}},
      zoom:()=>{terminal.options.fontSize=20;terminal.resize(72,12);},
      rows:()=>Array.from({length:terminal.buffer.active.length},(_,i)=>({text:terminal.buffer.active.getLine(i).translateToString(true),wrapped:terminal.buffer.active.getLine(i).isWrapped}))
    };
  `,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',outfile:path.join(output,'fixture.js')});
  await fs.writeFile(path.join(output,'index.html'),'<html><head><link rel="stylesheet" href="fixture.css"></head><body style="background:#101010;color:white"><p>Origin host · isolated terminal</p><div id="terminal"></div><script src="fixture.js"></script></body></html>');
  const absolute='/home/user/projects/very-long-project/reports/wrapped-report.md';
  const relative='reports/very-long-report.md';
  const sources=new Map();
  for(const reference of [absolute,relative]) {
    const file=path.join(output,crypto.createHash('sha256').update(reference).digest('hex')+'.txt');
    const body='Verified origin-host / verified-project contents for '+reference;
    await fs.writeFile(file,body); sources.set(reference,{file,body});
  }
  await app.whenReady();
  ipcMain.handle('hostFilePreview:state',()=>state);
  ipcMain.handle('hostFilePreview:action',(_event,action)=>{if(action==='close')viewer?.close()});
  ipcMain.handle('wrapped:open',async(_event,sessionId,reference)=>{
    assert.equal(sessionId,'origin-session');assert.ok(sources.has(reference),'Fragment or wrong destination selected');
    const source=sources.get(reference); const body=await fs.readFile(source.file,'utf8');
    calls.push({sessionId,hostId:'origin-host',project:'/verified-project',reference,body});
    state={metadata:{protocolVersion:1,name:path.basename(reference),size:Buffer.byteLength(body),modifiedAt:'2026-10-07T00:00:00Z',revision:crypto.createHash('sha256').update(body).digest('hex'),mediaKind:'text'},host:'origin-host',text:body,url:'fixture:'+calls.length,ready:true,busy:false,message:'Verified current host file',excerpt:false};
    viewer=new BrowserWindow({width:900,height:600,show:false,webPreferences:{preload:path.join(viewerAssets,'preload/host-file-preview.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await viewer.loadFile(path.join(viewerAssets,'renderer/host-file-preview.html')); return{ok:true};
  });
  terminalWindow=new BrowserWindow({width:1050,height:700,show:false,webPreferences:{preload:path.join(output,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await terminalWindow.loadFile(path.join(output,'index.html'));
  const cases=[['absolute','  Open (/home/user/projects/very-long-project/\r\n  reports/wrapped-report.md)',absolute],['relative','  Open (reports/very-long-\r\n  report.md)',relative]];
  for(const [name,text,target] of cases)for(const zoom of [false,true]){
    if(zoom)await terminalWindow.webContents.executeJavaScript('window.fixture.zoom()');
    await terminalWindow.webContents.executeJavaScript(`window.fixture.write(${JSON.stringify(text)})`);await delay(100);
    const initial=calls.length;
    for(let row=0;row<2;row++){
      const point=await terminalWindow.webContents.executeJavaScript(`window.fixture.point(${row},${row?3:9})`);
      terminalWindow.webContents.sendInputEvent({type:'mouseMove',...point,modifiers:['control']});await delay(350);
      terminalWindow.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1,modifiers:['control']});
      terminalWindow.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1,modifiers:['control']});
      await until(()=>calls.length===initial+row+1,'Actual Ctrl-click did not activate '+name+' row '+row);
      assert.equal(calls.at(-1).reference,target);
      await until(()=>viewer.webContents.executeJavaScript(`document.querySelector('pre')?.textContent===${JSON.stringify(sources.get(target).body)}`),'Full file contents were not displayed');
      await fs.writeFile(path.join(output,`${name}-${zoom?'zoom':'normal'}-${row}.png`),(await viewer.webContents.capturePage()).toPNG());
      viewer.close();viewer=undefined;
    }
  }
  await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify({status:'passed',interaction:'xterm mouse move and Ctrl-click input events',calls,limitations:['Real production xterm resolver, pointer input and built preview; deterministic host transport and synthetic files.']},null,2)+'\n');
  console.log(JSON.stringify({status:'passed',activations:calls.length,output}));terminalWindow.close();app.quit();
})().catch(async error=>{console.error(error.stack);await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.message,calls},null,2)).catch(()=>{});app.exit(1)});
setTimeout(()=>app.exit(2),120000).unref();
