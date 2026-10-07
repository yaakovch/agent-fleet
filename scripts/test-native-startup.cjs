// Real Native renderer and conversation manager against the isolated OpenSSH fixture.
const {app, BrowserWindow, ipcMain} = require('electron');
const {build} = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const output = path.resolve('dist/native-startup-acceptance');
const fixtureRoot = process.env.AGENT_FLEET_STARTUP_FIXTURE_ROOT;
if (!fixtureRoot || !fixtureRoot.startsWith('/home/')) throw new Error('An isolated fixture root is required');
fs.mkdirSync(output, {recursive:true});
app.disableHardwareAcceleration();
app.setPath('userData', path.join(output, 'user-data'));
app.on('window-all-closed',()=>{});
for(const name of ['failure.txt','timeout-state.json','timeout.png','receipt.json','console.log','ipc.log','transport.log']) fs.rmSync(path.join(output,name),{force:true});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let activeWindow, manager;
const deadline = setTimeout(() => { app.exit(2); }, 240000);
(async () => {
  await build({entryPoints:['src/main/conversation-manager.ts'], bundle:true, platform:'node', format:'cjs', external:['electron'], outfile:path.join(output,'manager.cjs')});
  await build({entryPoints:['src/main/wsl-process-ownership.ts'], bundle:true, platform:'node', format:'cjs', outfile:path.join(output,'ownership.cjs')});
  const {ConversationManager} = require(path.join(output,'manager.cjs'));
  const {WslProcessOwnership} = require(path.join(output,'ownership.cjs'));
  const ownership = new WslProcessOwnership();
  const tab = {id:'startup',sessionId:'native-startup:native-startup',hostId:'native-startup',project:'native-startup',internalName:'native-startup',label:'Native startup',tool:'codex',backend:'linux',viewMode:'native',status:'live',statusMessage:''};
  manager = new ConversationManager({tempPath:output,getDistro:()=> 'Ubuntu',resolveTab:()=>tab,
    hostCapabilities:()=>['conversation.turns.v1','terminal.exact-attach.v1'], sendTerminalInput:()=>false,
    processOwnership:ownership, logger:{info(){},warn(){}},
    onEvent:event=>{if(activeWindow && !activeWindow.isDestroyed()) activeWindow.webContents.send('startup-frame',event);},
    spawnProcess:(_command,args,options)=>{
      const end=args.indexOf('--');
      // Only relocate the launcher/config into the private fixture. Its real
      // client routing, pinned OpenSSH, runtime protocol and frame parser run.
      fs.appendFileSync(path.join(output,'transport.log'),JSON.stringify({args})+'\n');
      const child=spawn('wsl.exe',['-d','Ubuntu','--','env',
        `WTMUX_CONFIG_PATH=${fixtureRoot}/client.conf`, `WTMUX_KNOWN_HOSTS_FILE=${fixtureRoot}/known_hosts`,
        `WTMUX_ENDPOINT_TRUST_DIR=${fixtureRoot}/trust`,
        `${process.env.AGENT_FLEET_STARTUP_RUNTIME_SOURCE}/scripts/wtmux`,...args.slice(end+2)],options);
      child.stderr?.on('data',data=>fs.appendFileSync(path.join(output,'transport.log'),data.toString()));
      return child;
    }});
  ipcMain.handle('startup-call',(_event,method,args)=>{
    fs.appendFileSync(path.join(output,'ipc.log'),JSON.stringify({method,args})+'\n');
    if(method==='sync') return manager.sync(...args);
    if(method==='start') return manager.start(...args);
    throw new Error('Unknown acceptance method');
  });
  fs.writeFileSync(path.join(output,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron'); contextBridge.exposeInMainWorld('startupBridge',{call:(method,args)=>ipcRenderer.invoke('startup-call',method,args),onFrame:fn=>ipcRenderer.on('startup-frame',(_,event)=>fn(event))});`);
  await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
    import {SessionWorkspace} from './src/renderer/src/session-workspace';
    import {createDefaultSettings} from './src/shared/settings';
    import {emptyWorkspaceLayout,assignWorkspaceSession,setWorkspacePaneView,defaultRailState} from './src/shared/workspace-layout';
    import {createDefaultLocalSuggestionSettings} from './src/shared/local-suggestions';
    import './src/renderer/src/style.css';
    const tab=${JSON.stringify(tab)};
    let layout=emptyWorkspaceLayout(); layout=assignWorkspaceSession(layout,layout.focusedPaneId,tab.sessionId);
    let state={version:2,layout,rail:defaultRailState(),tabs:[tab]};
    const handlers={};
    const api={
      getLocalSuggestionSettings:async()=>createDefaultLocalSuggestionSettings(),listTerminalTabs:async()=>state,
      syncConversations:async(ids,view)=>window.startupBridge.call('sync',[ids,view]),
      startConversation:async(id,view)=>window.startupBridge.call('start',[id,view]),
      syncTerminalTabs:async()=>[], terminalResize:async()=>true,terminalInput:async()=>true,
      loadTerminalHistory:async()=>({ok:false,message:'Unavailable in the isolated startup measurement'}),
      getFleetSessionModel:async()=>({ok:false,message:'No model catalog in the fixture'}),
      applyWorkspaceCommand:async(command)=>{
        if(command.type!=='view') throw new Error('Only view changes are accepted');
        layout=setWorkspacePaneView(layout,command.paneId,command.viewMode);
        state={...state,layout,tabs:[{...tab,viewMode:command.viewMode}]};
        return state;
      }
    };
    for(const name of ['onTerminalData','onTerminalStatus','onTerminalClosed','onTerminalOpened','onWorkspaceUpdated','onConversationEvent','onLocalSuggestionSettingsUpdated']) api[name]=fn=>{handlers[name]=fn;};
    window.limitsWidget=api;
    window.startupBridge.onFrame(event=>handlers.onConversationEvent?.(event));
    const workspace=new SessionWorkspace(createDefaultSettings()); workspace.mount(document.body);
    document.body.addEventListener('click',event=>{const target=event.target.closest('[data-action]'); if(target) workspace.handleAction(target.dataset.action,target);});
    window.readStartup=()=>({text:document.body.innerText,readOnly:document.querySelector('[data-action="native-send"]')?.disabled,
      draft:document.querySelector('[data-native-message]')?.value,connection:workspace.nativeState(tab.id).connection});
    window.startupPoint=(mode)=>{const button=document.querySelector('[data-action="workspace-view"][data-mode="'+mode+'"]'); if(!button) throw new Error('View switch absent'); const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};};
    window.setStartupDraft=()=>{const input=document.querySelector('[data-native-message]');input.value='Retain this draft';input.dispatchEvent(new Event('input',{bubbles:true}));};
  `},bundle:true,platform:'browser',outfile:path.join(output,'fixture.js'),loader:{'.woff':'dataurl','.woff2':'dataurl'}});
  fs.writeFileSync(path.join(output,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body style="height:100vh;margin:0"><script src="fixture.js"></script></body></html>');
  await app.whenReady();
  async function waitVisible(window,timeout=5000) {
    const end=Date.now()+timeout;
    while(Date.now()<end) {
      const value=await window.webContents.executeJavaScript('window.readStartup?.()');
      if(value?.text.includes('NATIVE_STARTUP_READY')) return value;
      await delay(10);
    }
    fs.writeFileSync(path.join(output,'timeout-state.json'),JSON.stringify(await window.webContents.executeJavaScript('({state:window.readStartup?.(),html:document.body.innerHTML,hidden:document.hidden})'),null,2));
    fs.writeFileSync(path.join(output,'timeout.png'),(await window.webContents.capturePage()).toPNG());
    throw new Error('Native content was not visible within '+timeout+'ms');
  }
  async function makeWindow() {
    activeWindow=new BrowserWindow({width:1100,height:900,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,preload:path.join(output,'preload.cjs')}});
    activeWindow.webContents.on('console-message',(...args)=>fs.appendFileSync(path.join(output,'console.log'),JSON.stringify(args.slice(1))+'\n'));
    await activeWindow.loadFile(path.join(output,'index.html'));
    return activeWindow;
  }
  async function click(window,mode) {
    const point=await window.webContents.executeJavaScript('window.startupPoint('+JSON.stringify(mode)+')');
    point.x=Math.round(point.x); point.y=Math.round(point.y);
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  }
  const cold=[],warm=[];
  for(let i=0;i<20;i++) {
    const started=performance.now(); const window=await makeWindow();
    await waitVisible(window); cold.push(performance.now()-started);
    manager.stop(tab.id); window.destroy(); await delay(50);
  }
  const window=await makeWindow(); await waitVisible(window);
  await window.webContents.executeJavaScript('window.setStartupDraft()');
  for(let i=0;i<20;i++) {
    await click(window,'terminal'); await delay(50);
    const started=performance.now(); await click(window,'native');
    const state=await waitVisible(window,500); warm.push(performance.now()-started);
    if(state.draft!=='Retain this draft') throw new Error('Draft was lost during Native/Terminal switching');
    await delay(50);
  }
  fs.writeFileSync(path.join(output,'native-startup.png'),(await window.webContents.capturePage()).toPNG());
  const p95=values=>[...values].sort((a,b)=>a-b)[18];
  const receipt={coldMillis:cold,warmMillis:warm,coldP95Millis:p95(cold),warmP95Millis:p95(warm),transport:'real pinned OpenSSH fixture',renderer:'production SessionWorkspace and ConversationManager'};
  fs.writeFileSync(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2));
  if(receipt.coldP95Millis>5000 || receipt.warmP95Millis>500) throw new Error('Startup performance target exceeded');
  manager.dispose(); window.destroy(); clearTimeout(deadline); app.exit(0);
})().catch(error=>{fs.writeFileSync(path.join(output,'failure.txt'),error.stack);manager?.dispose();clearTimeout(deadline);app.exit(1);});
