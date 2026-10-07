// Real Native renderer and conversation manager against the isolated OpenSSH fixture.
const {app, BrowserWindow, ipcMain} = require('electron');
const {build} = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const output = path.resolve('dist/native-startup-acceptance');
const fixtureRoot = process.env.AGENT_FLEET_STARTUP_FIXTURE_ROOT;
const samples = Number(process.env.AGENT_FLEET_STARTUP_SAMPLES ?? 20);
if (![1, 20].includes(samples)) throw new Error('Acceptance samples must be 1 or 20');
if (!fixtureRoot || !fixtureRoot.startsWith('/home/')) throw new Error('An isolated fixture root is required');
fs.mkdirSync(output, {recursive:true});
fs.rmSync(path.join(output,'saved-session-state'), {recursive:true,force:true});
app.disableHardwareAcceleration();
app.setPath('userData', path.join(output, 'user-data'));
app.on('window-all-closed',()=>{});
for(const name of ['failure.txt','timeout-state.json','timeout.png','receipt.json','console.log','ipc.log','transport.log']) fs.rmSync(path.join(output,name),{force:true});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let activeWindow, manager, store, identity, terminal;
let failSend = false;
let terminalDimensions = {cols:130, rows:45};
const deadline = setTimeout(() => { app.exit(2); }, 240000);
(async () => {
  await build({entryPoints:['src/main/conversation-manager.ts'], bundle:true, platform:'node', format:'cjs', external:['electron'], outfile:path.join(output,'manager.cjs')});
  await build({entryPoints:['src/main/wsl-process-ownership.ts'], bundle:true, platform:'node', format:'cjs', outfile:path.join(output,'ownership.cjs')});
  await build({entryPoints:['src/main/session-state-store.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(output,'state-store.cjs')});
  const {SessionStateStore}=require(path.join(output,'state-store.cjs'));
  store=new SessionStateStore(path.join(output,'saved-session-state'));
  const {ConversationManager} = require(path.join(output,'manager.cjs'));
  const {WslProcessOwnership} = require(path.join(output,'ownership.cjs'));
  const ownership = new WslProcessOwnership();
  const tab = {id:'startup',sessionId:'native-startup:native-startup',hostId:'native-startup',project:'native-startup',internalName:'native-startup',label:'Native startup',tool:'codex',backend:'linux',viewMode:'native',status:'live',statusMessage:''};
  manager = new ConversationManager({tempPath:output,getDistro:()=> 'Ubuntu',resolveTab:()=>tab,
    hostCapabilities:()=>['conversation.turns.v1','terminal.exact-attach.v1'], sendTerminalInput:(_tabId,text)=>{if(failSend || !terminal) return false; terminal.write(text);return true;},
    processOwnership:ownership, logger:{info(){},warn(){}},
    onEvent:event=>{fs.appendFileSync(path.join(output,'ipc.log'),JSON.stringify({method:'frame',type:event.frame?.type,window:activeWindow?.id})+'\n');if(activeWindow && !activeWindow.isDestroyed()) activeWindow.webContents.send('startup-frame',event);},
    spawnProcess:(_command,args,options)=>{
      const end=args.indexOf('--');
      // Only relocate the launcher/config into the private fixture. Its real
      // client routing, pinned OpenSSH, runtime protocol and frame parser run.
      fs.appendFileSync(path.join(output,'transport.log'),JSON.stringify({args})+'\n');
      const child=spawn('wsl.exe',['-d','Ubuntu','--','env',
        `WTMUX_CONFIG_PATH=${fixtureRoot}/client.conf`, `WTMUX_KNOWN_HOSTS_FILE=${fixtureRoot}/known_hosts`,
        `WTMUX_ENDPOINT_TRUST_DIR=${fixtureRoot}/trust`,
        `WTMUX_SSH_REUSE=${process.env.AGENT_FLEET_STARTUP_SSH_REUSE ?? '1'}`,
        `${process.env.AGENT_FLEET_STARTUP_RUNTIME_SOURCE}/scripts/wtmux`,...args.slice(end+2)],options);
      child.on('exit',code=>fs.appendFileSync(path.join(output,'transport.log'),JSON.stringify({kind:'exit',code})+'\n'));
      child.stderr?.on('data',data=>fs.appendFileSync(path.join(output,'transport.log'),data.toString()));
      return child;
    }});
  ipcMain.handle('startup-call',async(event,method,args)=>{
    if(!activeWindow || activeWindow.isDestroyed() || event.sender.id!==activeWindow.webContents.id) return null;
    fs.appendFileSync(path.join(output,'ipc.log'),JSON.stringify({method,argsCount:args.length})+'\n');
    if(method==='sync') return manager.sync(...args);
    if(method==='start') return manager.start(...args);
    if(method==='getSaved') {identity=await manager.identity(tab.id);fs.appendFileSync(path.join(output,'ipc.log'),JSON.stringify({method:'identity-result',verified:Boolean(identity)})+'\n');return identity?store.get(identity,'linux'):null;}
    if(method==='updateSaved') return identity?store.update(identity,'linux',args[1],args[2]):null;
    if(method==='clearSaved') return identity?store.clear(identity,'linux',args[1],args[2],args[3]):null;
    if(method==='send') return manager.send(...args);
    if(method==='loadHistory') return manager.history(tab.id);
    if(method==='resize') {terminalDimensions={cols:args[1],rows:args[2]};terminal?.resize(terminalDimensions.cols,terminalDimensions.rows);return true;}
    if(method==='terminalInput') {terminal?.write(args[1]);return Boolean(terminal);}

    throw new Error('Unknown acceptance method');
  });
  fs.writeFileSync(path.join(output,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron'); contextBridge.exposeInMainWorld('startupBridge',{call:(method,args)=>ipcRenderer.invoke('startup-call',method,args),onFrame:fn=>ipcRenderer.on('startup-frame',(_,event)=>fn(event)),onTerminal:fn=>ipcRenderer.on('startup-terminal',(_,event)=>fn(event))});`);
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
      getSavedSessionState:async(id)=>window.startupBridge.call('getSaved',[id]),
      updateSavedSessionState:async(...args)=>window.startupBridge.call('updateSaved',args),
      clearSavedSessionState:async(...args)=>window.startupBridge.call('clearSaved',args),
      sendConversationMessage:async(...args)=>window.startupBridge.call('send',args),
      syncTerminalTabs:async()=>[], terminalResize:async(...args)=>window.startupBridge.call('resize',args),terminalInput:async(...args)=>window.startupBridge.call('terminalInput',args),
      loadTerminalHistory:async()=>window.startupBridge.call('loadHistory',[]),
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
    window.startupBridge.onTerminal(event=>handlers.onTerminalData?.(event));
    const workspace=new SessionWorkspace(createDefaultSettings()); workspace.mount(document.body);
    document.body.addEventListener('click',event=>{const target=event.target.closest('[data-action]'); if(target) workspace.handleAction(target.dataset.action,target);});
    window.readStartup=()=>({text:document.body.innerText,readOnly:document.querySelector('[data-action="native-send"]')?.disabled,
      draft:document.querySelector('[data-native-message]')?.value,connection:workspace.nativeState(tab.id).connection});
    window.startupAction=(action)=>{const b=document.querySelector('[data-action='+action+']');if(!b)throw new Error('Missing '+action);const details=b.closest('details');if(details)details.open=true;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};};
    window.readStartupHistory=()=>{const s=workspace.terminalHistoryState(tab.id);const r=workspace.runtimes.get(tab.id);const t=r?.historyTerminal;return{active:s.active,status:s.status,error:s.error,revision:s.snapshot?.revision,snapshotCols:s.snapshot?.columns,snapshotRows:s.snapshot?.rows,binding:s.binding,pendingOpen:workspace.pendingHistoryOpen.get(tab.id),historyCols:t?.cols,historyRows:t?.rows,cols:r?.terminal.cols,rows:r?.terminal.rows,rendered:t?Array.from({length:t.buffer.active.length},(_,i)=>t.buffer.active.getLine(i)?.translateToString(true)).join('\\n'):''};};
    window.startupPoint=(mode)=>{const button=document.querySelector('[data-action="workspace-view"][data-mode="'+mode+'"]'); if(!button) throw new Error('View switch absent'); const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};};
    window.setStartupDraft=(text='Retain this draft')=>{const input=document.querySelector('[data-native-message]');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));};
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
    const processProbe = spawnSync('wsl.exe',['-d','Ubuntu','--exec','python3','-c',
      'import os,pathlib,json,sys; token=("WTMUX_CONFIG_PATH="+sys.argv[1]+"/client.conf").encode(); rows=[]\nfor p in list(pathlib.Path("/proc").iterdir())[:4096]:\n if not p.name.isdigit():continue\n try:\n  if token not in (p/"environ").read_bytes().split(b"\\0"):continue\n  s=(p/"stat").read_text().rsplit(")",1)[1].split(); rows.append({"pid":int(p.name),"state":s[0],"ppid":int(s[1]),"group":int(s[2]),"session":int(s[3]),"comm":(p/"comm").read_text().strip(),"wait":(p/"wchan").read_text().strip()})\n except (OSError,ValueError):pass\nprint(json.dumps(rows))',fixtureRoot],{encoding:'utf8',timeout:3000,windowsHide:true});
    fs.writeFileSync(path.join(output,'timeout-processes.json'),processProbe.stdout||JSON.stringify({error:processProbe.error?.message,status:processProbe.status}));
    throw new Error('Native content was not visible within '+timeout+'ms');
  }
  async function makeWindow() {
    activeWindow=new BrowserWindow({width:1100,height:900,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,preload:path.join(output,'preload.cjs')}});
    activeWindow.once('closed',()=>manager.stop(tab.id));
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
  for(let i=0;i<samples;i++) {
    const started=performance.now(); const window=await makeWindow();
    await waitVisible(window); cold.push(performance.now()-started);
    window.destroy(); manager.stop(tab.id); if(!await ownership.releaseAllAndWait('detach',5000)) throw new Error('Owned WSL processes did not drain'); await delay(50);
  }
  const window=await makeWindow(); await waitVisible(window);
  await window.webContents.executeJavaScript('window.setStartupDraft()');
  for(let i=0;i<samples;i++) {
    await click(window,'terminal'); await delay(50);
    const started=performance.now(); await click(window,'native');
    const state=await waitVisible(window,500); warm.push(performance.now()-started);
    if(state.draft!=='Retain this draft') throw new Error('Draft was lost during Native/Terminal switching');
    await delay(50);
  }
  await delay(500);store.flush();
  window.destroy(); manager.stop(tab.id);
  store=new SessionStateStore(path.join(output,'saved-session-state'));
  const reopened=await makeWindow(); await waitVisible(reopened); await delay(500);
  if((await reopened.webContents.executeJavaScript('window.readStartup()')).draft!=='Retain this draft') throw new Error('Draft not restored after store restart');
  async function action(action) {const point=await reopened.webContents.executeJavaScript('window.startupAction('+JSON.stringify(action)+')');for(const type of ['mouseDown','mouseUp']) reopened.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});await delay(400);}
  await action('native-send');
  if((await reopened.webContents.executeJavaScript('window.readStartup()')).draft!=='Retain this draft') throw new Error('Failed send erased draft');
  await action('native-message-clear');store.flush();
  if(store.get(identity,'linux').message!=='') throw new Error('Clear was not durable');
  const pty=require('node-pty');
  terminal=pty.spawn('wsl.exe',['-d','Ubuntu','--','env',
    'WTMUX_CONFIG_PATH='+fixtureRoot+'/client.conf','WTMUX_KNOWN_HOSTS_FILE='+fixtureRoot+'/known_hosts',
    'WTMUX_ENDPOINT_TRUST_DIR='+fixtureRoot+'/trust', 'TERM=xterm-256color',fixtureRoot+'/terminal-client.sh'],{name:'xterm-256color',...terminalDimensions,cwd:process.cwd(),env:process.env});
  let terminalReady=false;let terminalOutput='';terminal.onData(data=>{terminalOutput+=data;if(terminalOutput.includes('TERMINAL_STARTUP_READY'))terminalReady=true;if(activeWindow&&!activeWindow.isDestroyed())activeWindow.webContents.send('startup-terminal',{tabId:tab.id,data});});
  for(let i=0;i<100 && !terminalReady;i++) await delay(50);
  if(!terminalReady) throw new Error('Verified pinned terminal did not attach');
  const sent='native-input-windows-'+Date.now();
  await reopened.webContents.executeJavaScript('window.setStartupDraft('+JSON.stringify(sent)+')');
  const inputStarted=performance.now();await action('native-send');
  for(let i=0;i<100;i++){if((await reopened.webContents.executeJavaScript('window.readStartup()')).text.includes('INPUT_RECEIVED: '+sent))break;await delay(50);}
  const verifiedInputMillis=performance.now()-inputStarted;
  if(!(await reopened.webContents.executeJavaScript('window.readStartup()')).text.includes('INPUT_RECEIVED: '+sent)) throw new Error('Input receipt not visible');
  store.flush(); if(store.get(identity,'linux').message!=='') throw new Error('Successful Send was not durable');
  fs.writeFileSync(path.join(output,'native-startup.png'),(await reopened.webContents.capturePage()).toPNG());
  let historyAcceptance;
  if(process.env.AGENT_FLEET_STARTUP_HISTORY==='1') {
    await click(reopened,'terminal'); await delay(1000);
    // The real terminal stream stays attached while the read-only History renderer is open.
    await action('workspace-history');
    async function waitHistory(predicate,message) {for(let i=0;i<100;i++){const s=await reopened.webContents.executeJavaScript('window.readStartupHistory()');if(predicate(s))return s;await delay(100);}fs.writeFileSync(path.join(output,'history-timeout-state.json'),JSON.stringify(await reopened.webContents.executeJavaScript('window.readStartupHistory()'),null,2));fs.writeFileSync(path.join(output,'history-timeout.png'),(await reopened.webContents.capturePage()).toPNG());throw new Error(message);}
    const first=await waitHistory(s=>s.active&&s.rendered.includes('TERMINAL_STARTUP_READY'),'Real pane History was not displayed');
    terminal.write('history-background-'+Date.now()+'\r');await delay(1200);
    const stable=await reopened.webContents.executeJavaScript('window.readStartupHistory()');
    if(stable.revision!==first.revision || stable.rendered!==first.rendered)throw new Error('Background output replaced the reading snapshot');
    await action('workspace-history-refresh');
    const refreshed=await waitHistory(s=>s.active&&s.revision!==first.revision,'Explicit History refresh did not show new output');
    await action('workspace-history-live');
    const live=await waitHistory(s=>!s.active,'Return to live terminal failed');
    await action('workspace-history');
    const reopenedHistory=await waitHistory(s=>s.active,'History reopening failed');
    if(reopenedHistory.revision!==refreshed.revision)throw new Error('Unchanged History revision was rebuilt incorrectly');
    fs.writeFileSync(path.join(output,'terminal-history.png'),(await reopened.webContents.capturePage()).toPNG());
    historyAcceptance={actualPaneCapture:true,explicitEntry:true,stableWhileReading:true,explicitRefresh:true,returnToLive:true,unchangedRevisionReopened:true,livePtyPreserved:true};
  }
  const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
  const receipt={verifiedInputMillis,draftStoreRestart:true,failedSendRetained:true,clearDurable:true,successfulSendCleared:true,historyAcceptance,coldMillis:cold,warmMillis:warm,coldP95Millis:p95(cold),warmP95Millis:p95(warm),transport:'real pinned OpenSSH fixture',renderer:'production SessionWorkspace and ConversationManager'};
  fs.writeFileSync(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2));
  if(receipt.coldP95Millis>5000 || receipt.warmP95Millis>500) throw new Error('Startup performance target exceeded');
  manager.dispose(); terminal?.kill(); reopened.destroy(); clearTimeout(deadline); app.exit(0);
})().catch(error=>{fs.writeFileSync(path.join(output,'failure.txt'),error.stack);manager?.dispose();terminal?.kill();clearTimeout(deadline);app.exit(1);});
