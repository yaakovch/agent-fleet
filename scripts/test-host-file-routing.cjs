// Actual Native DOM clicks and production terminal activation; no host transport.
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve('build/reports/host-file-routing');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(output, 'isolated-user-data'));
(async () => {
  await fs.mkdir(output, { recursive: true });
  await build({ stdin: { contents: `
    import { SessionWorkspace } from './src/renderer/src/session-workspace';
    import { ActivityCache } from './src/shared/conversation-view';
    import { createDefaultLocalSuggestionSettings } from './src/shared/local-suggestions';
    import './src/renderer/src/style.css';
    const workspace = Object.create(SessionWorkspace.prototype);
    workspace.nativeStates = new Map(); workspace.activityCache = new ActivityCache();
    workspace.localSuggestionSettings = createDefaultLocalSuggestionSettings();
    const origin = {id:'origin-tab',sessionId:'origin-session',hostId:'origin-host',internalName:'managed-origin',tool:'codex'};
    const other = {id:'other-tab',sessionId:'other-session',hostId:'other-host',internalName:'managed-other',tool:'codex'};
    workspace.tabs = new Map([[origin.id,origin],[other.id,other]]); workspace.selectedId = other.id;
    const pane = {kind:'pane',id:'origin-pane',sessionId:origin.sessionId,viewMode:'native'};
    workspace.workspaceState = {layout:{schemaVersion:1,focusedPaneId:'other-pane',sessionMru:[other.sessionId],root:{kind:'split',id:'split',direction:'row',ratio:.5,first:pane,second:{kind:'pane',id:'other-pane',sessionId:other.sessionId,viewMode:'native'}}}};
    workspace.nativeView = 'conversation';
    const calls = []; window.limitsWidget = {
      openHostFile:async(sessionId,reference)=>{calls.push({sessionId,reference});return {ok:true,message:'Preview opened'}},
      openExternalLink:async()=>{throw new Error('File was routed to external URL handler')}
    };
    window.runChecks = async () => {
      const state = workspace.nativeState(origin.id); state.draft='Keep this composer draft';
      state.connection='Live'; state.providerState={...state.providerState,mutationsAllowed:true};
      const base={kind:'message',role:'assistant',timestamp:'now',title:'',detail:'',state:'complete',tool:'',attachments:[],choices:[],turnId:'turn',messagePurpose:'final'};
      state.items=Array.from({length:50},(_,i)=>({...base,id:'message-'+i,text:i===20?'Open [report](</tmp/report with spaces.txt>) or file:///tmp/report.pdf.':'Message '+i+' preserves the reading position.'}));
      document.body.innerHTML='<main style="height:100vh" data-pane-id="origin-pane">'+workspace.renderNative(origin)+'</main>';
      workspace.element=document.body.firstElementChild;
      const feed=document.querySelector('.native-messages'); feed.scrollTop=feed.scrollHeight*.4;
      const before=feed.scrollTop;
      document.addEventListener('click',event=>{const control=event.target.closest('[data-action]');if(control)workspace.handleAction(control.dataset.action,control)});
      const links=[...document.querySelectorAll('[data-action="native-open-file"]')];
      if(links.length!==2)throw new Error('Expected two Native file links');
      links[0].click(); await Promise.resolve();
      const draft=document.querySelector('[data-native-message]').value;
      if(feed.scrollTop!==before||draft!=='Keep this composer draft')throw new Error('Native click changed scroll or draft');
      if(calls[0]?.sessionId!==origin.sessionId||calls[0]?.reference!=='/tmp/report with spaces.txt')throw new Error('Native link lost its originating pane or quoted path');
      let provider;
      const rows=['../docs/rep','ort.md'];
      const terminal={options:{},registerLinkProvider:value=>{provider=value},buffer:{active:{length:2,getLine:i=>i>=0&&i<2?{isWrapped:i===1,translateToString:()=>rows[i],getCell:col=>({getWidth:()=>1,getChars:()=>rows[i][col]||''})}:undefined}}};
      workspace.bindHostFileLinks(terminal,origin);
      let visible=[]; provider.provideLinks(2,value=>{visible=value});
      if(visible.length!==1||visible[0].text!=='../docs/report.md')throw new Error('Wrapped terminal path was lost');
      visible[0].activate(new MouseEvent('click'),visible[0].text); await Promise.resolve();
      if(calls.length!==1)throw new Error('Terminal opened without Ctrl');
      const ctrl=new MouseEvent('click',{ctrlKey:true,cancelable:true});visible[0].activate(ctrl,visible[0].text);await Promise.resolve();
      terminal.options.linkHandler.activate(new MouseEvent('click',{ctrlKey:true,cancelable:true}),'file:///tmp/hidden.pdf');await Promise.resolve();
      if(!ctrl.defaultPrevented||calls.length!==3||calls.slice(1).some(call=>call.sessionId!==origin.sessionId))throw new Error('Terminal activation lost Ctrl handling or origin');
      return {calls,draftPreserved:true,scrollPreserved:true,plainTerminalClickIgnored:true,wrappedPath:true,osc8Target:true};
    };
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'browser', outfile: path.join(output, 'fixture.js'), loader: { '.woff':'dataurl','.woff2':'dataurl' } });
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><script src="fixture.js"></script></body></html>');
  await app.whenReady();
  const win = new BrowserWindow({width:960,height:820,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await win.loadFile(path.join(output, 'index.html'));
  const result = await win.webContents.executeJavaScript('window.runChecks()');
  assert.equal(result.calls.length,3);
  await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify({status:'passed',...result,limitations:['Native renderer and click handling are production code. Terminal buffer and IPC transport are deterministic fixtures.']},null,2)+'\n');
  await fs.writeFile(path.join(output,'native.png'),(await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({status:'passed',output,...result}));win.close();app.quit();
})().catch(error=>{console.error(error.stack);app.exit(1)});
setTimeout(()=>app.exit(2),60000).unref();
