// Isolated visual acceptance: actual Native renderer, synthetic content, no host processes.
const { app, BrowserWindow, nativeTheme } = require('electron');
const { build } = require('esbuild');
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const output = resolve('dist/native-conversation-preview');
mkdirSync(output, { recursive: true });
const trace = (value) => appendFileSync(join(output, 'capture.log'), new Date().toISOString()+' '+value+'\n');
trace('started');
app.disableHardwareAcceleration();
app.setPath('userData', join(output, 'user-data'));
const deadline = setTimeout(() => { trace('timed out'); app.exit(2); }, 60000);
(async () => {
  mkdirSync(output, { recursive: true });
  await build({ stdin: { contents: `
    import { SessionWorkspace } from './src/renderer/src/session-workspace';
    import { ActivityCache } from './src/shared/conversation-view';
    import { createDefaultLocalSuggestionSettings } from './src/shared/local-suggestions';
    import './src/renderer/src/style.css';
    const workspace = Object.create(SessionWorkspace.prototype);
    workspace.nativeStates = new Map(); workspace.activityCache = new ActivityCache();
    workspace.localSuggestionSettings = createDefaultLocalSuggestionSettings();
    const tab = {id:'fixture', sessionId:'fixture', hostId:'fixture', internalName:'fixture', tool:'codex'};
    workspace.tabs = new Map([[tab.id, tab]]); workspace.selectedId = tab.id;
    const base = {id:'user', kind:'message', timestamp:'now', role:'user', title:'', text:'Make Native view easier to read.', detail:'', state:'complete', tool:'', attachments:[], choices:[], turnId:'turn', messagePurpose:'user'};
    const summary = {...base, id:'activity', kind:'activity', role:'', text:'', messagePurpose:undefined, activitySummary:{turnId:'turn', state:'complete', toolCount:1001, changeCount:3, progressCount:2, otherCount:1, partial:false, latestProgress:'', cursor:'cursor'}};
    const final = {...base, id:'final', role:'assistant', messagePurpose:'final', text:'Native view now puts your messages and my replies first.\\n\\nOpen Activity to inspect tools and edits. Use Actions to switch to Detailed whenever you want the full timeline.'};
    const tool = {...base, id:'tool', kind:'tool', role:'', text:'', title:'Read source', tool:'exec_command', input:'rg conversation src', result:'Matched source files', action:'read', target:'src', messagePurpose:undefined};
    window.checkReadingPosition = () => {
      const state = workspace.nativeState('fixture');
      state.draft = 'Preserve this draft'; state.scrollInitialized = true; state.renderMode = 'preserve';
      const messages = Array.from({length:60}, (_, i) => ({...base, id:'anchor-'+i, text:'Message '+i+' remains readable.', role:i%2 ? 'assistant':'user'}));
      state.items = messages; workspace.nativeView = 'conversation';
      document.body.innerHTML = '<main style="height:100vh;width:100vw"><div data-native-host="fixture" style="height:100%">'+workspace.renderNative(tab)+'</div></main>';
      workspace.element = document.body.firstElementChild;
      let host = document.querySelector('[data-native-host]');
      let feed = host.querySelector('.native-messages'); feed.scrollTop = feed.scrollHeight * .4;
      const before = workspace.captureRenderSnapshot('fixture');
      if (!before.anchorId || before.nearBottom) throw new Error('Reading fixture did not establish an anchor');
      state.items = messages.flatMap((message, i) => [message, {...tool, id:'between-'+i}]);
      workspace.nativeView = 'detailed';
      host.innerHTML = workspace.renderNative(tab);
      workspace.restoreRenderSnapshot('fixture', before);
      feed = host.querySelector('.native-messages');
      const anchor = host.querySelector('[data-message-anchor="'+before.anchorId+'"]');
      const difference = Math.abs(anchor.getBoundingClientRect().top-feed.getBoundingClientRect().top-before.anchorTop);
      const draft = host.querySelector('[data-native-message]').value;
      if (difference > 2 || draft !== 'Preserve this draft') throw new Error('View change lost reading position or draft');
      state.draft = '';
      return {anchorId:before.anchorId, difference, draftPreserved:true};
    };
    window.renderFixture = (mode, expanded) => {
      workspace.nativeView = mode;
      const state = workspace.nativeState('fixture');
      state.connection = 'Live'; state.providerState = {...state.providerState, mutationsAllowed:true};
      state.items = mode === 'detailed' ? [base, tool, final] : [base, summary, final];
      state.expandedDetails = new Set(expanded ? ['activity-activity'] : []);
      workspace.activityCache.set('fixture:activity', {items:[tool], cursor:null, sourceCursor:'cursor', loading:false, error:''});
      document.body.innerHTML = '<main class="session-workspace" style="height:100vh;width:100vw;display:block">' + workspace.renderNative(tab) + '</main>';
      const input = document.querySelector('[data-native-message]'); input.style.height = 'auto'; input.style.height = input.scrollHeight+'px';
      return {messages:document.querySelectorAll('.native-message').length, activities:document.querySelectorAll('.native-turn-activity').length, tools:document.querySelectorAll('.tool-call').length, composerHeight:input.getBoundingClientRect().height};
    };
    // Production frame handling and real Native HTML; only pane selection, DOM
    // scheduling and suggestion work are substituted for this isolated window.
    workspace.queueNativeRender = () => {}; workspace.maybeStartAutomaticSuggestion = () => {};
    workspace.selectFromControl = () => {};
    workspace.renderSelectedNative = () => {
      const previous = workspace.captureRenderSnapshot(tab.id);
      document.querySelector('[data-native-host]').innerHTML = workspace.renderNative(tab);
      workspace.restoreRenderSnapshot(tab.id, previous);
    };
    document.addEventListener('click', (event) => {
      const control = event.target.closest('[data-action]');
      if (control) workspace.handleAction(control.dataset.action, control);
    });
    window.renderQuestionFixture = (kind) => {
      workspace.nativeStates.clear(); workspace.nativeView = 'conversation';
      const state = workspace.nativeState(tab.id);
      if (kind !== 'cold') {
        const questions = Array.from({length:7}, (_, index) => ({...base, id:'old-'+index,
          kind:'question', role:'assistant', timestamp:'2026-09-22T00:00:00Z', state:'pending', source:'codex_async_question',
          title:'Answer needed', text:'', revision:'stable-'+index,
          questions:[{id:'q1', header:'Earlier question '+(index+1), prompt:'Which approach should this earlier request use?',
            type:'single', required:true, allowOther:true, options:[{id:'a', label:'Keep the existing approach', description:'Preserve the current behavior'}]}]}));
        workspace.applyConversationFrame(tab.id, {type:'conversation.snapshot', session:tab.internalName,
          items:[{...base, timestamp:'2026-09-22T00:01:00Z', text:'Continue with the conversation improvements.'},
            {...final, timestamp:'2026-09-22T00:02:00Z', text:'Your earlier questions remain available below. You can keep typing while reviewing them.'}, ...questions],
          providerState:{...state.providerState, confidence:'verified', fallback:'none', mutationsAllowed:true}});
        state.draft = 'Preserve this composer draft';
        state.questionDrafts.set('old-0', [{questionId:'q1', choiceIds:[], text:'Preserve this question draft'}]);
        if (kind !== 'earlier-collapsed') state.expandedDetails.add('earlier-questions');
      }
      document.body.innerHTML = '<main class="session-workspace" style="height:100vh;width:100vw;display:block"><div data-native-host="fixture" style="height:100%">'+workspace.renderNative(tab)+'</div></main>';
      workspace.element = document.body.firstElementChild;
      if (kind === 'earlier-open') document.querySelector('[data-conversation-item="old-0"] [data-action="native-question-open"]').click();
      const text = document.body.innerText;
      return {warning: text.includes('Terminal-only provider state'), updateHint:text.includes('Update this host'), waiting: text.includes('questions waiting'),
        connecting:text.includes('Connecting'), earlier: text.includes('Earlier questions (7)'),
        sheet: Boolean(document.querySelector('.native-question-sheet')),
        sendDisabled:document.querySelector('[data-action="native-send"]').disabled,
        composerDraft:document.querySelector('[data-native-message]').value,
        questionDraft:document.querySelector('[data-question-text]')?.value ?? ''};
    };
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'browser', outfile: join(output, 'fixture.js'), loader: { '.woff': 'dataurl', '.woff2': 'dataurl' } });
  writeFileSync(join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><script src="fixture.js"></script></body></html>');
  trace('bundled');
  await app.whenReady();
  trace('app ready');
  const window = new BrowserWindow({ width: 960, height: 820, show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('render-process-gone', (_, details) => trace(JSON.stringify(details)));
  window.webContents.on('console-message', (_, details) => trace(JSON.stringify(details)));
  await window.loadFile(join(output, 'index.html'));
  trace('page loaded');
  const evidence = [{readingPosition:await window.webContents.executeJavaScript('window.checkReadingPosition()')}];
  for (const [name, theme, scale, mode, expanded] of [
    ['conversation-dark', 'dark', 1, 'conversation', false],
    ['conversation-light', 'light', 1, 'conversation', false],
    ['conversation-large', 'dark', 1.35, 'conversation', false],
    ['conversation-expanded', 'dark', 1, 'conversation', true],
    ['conversation-detailed', 'dark', 1, 'detailed', false]
  ]) {
    nativeTheme.themeSource = theme;
    window.webContents.setZoomFactor(scale);
    const result = await window.webContents.executeJavaScript(`window.renderFixture(${JSON.stringify(mode)},${expanded})`);
    if (result.messages !== 2 || result.activities !== (mode === 'conversation' ? 1 : 0) || result.tools !== (expanded || mode === 'detailed' ? 1 : 0)) throw new Error('Unexpected renderer contents: '+JSON.stringify(result));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const png = await window.webContents.capturePage();
    writeFileSync(join(output, name+'.png'), png.toPNG());
    evidence.push({name, theme, scale, ...result});
  }
  for (const [kind, theme, scale] of [
    ['cold', 'dark', 1], ['earlier-collapsed', 'dark', 1], ['earlier-expanded', 'dark', 1],
    ['earlier-expanded', 'light', 1], ['earlier-expanded', 'dark', 1.35], ['earlier-open', 'light', 1]
  ]) {
    nativeTheme.themeSource = theme; window.webContents.setZoomFactor(scale);
    const result = await window.webContents.executeJavaScript(`window.renderQuestionFixture(${JSON.stringify(kind)})`);
    if (result.warning || result.waiting || (kind === 'cold' ? !result.connecting || !result.sendDisabled || result.updateHint
      : !result.earlier || result.sendDisabled || result.composerDraft !== 'Preserve this composer draft')) throw new Error('Unexpected question state: '+JSON.stringify(result));
    if (kind === 'earlier-open' && (!result.sheet || result.questionDraft !== 'Preserve this question draft')) throw new Error('Earlier question did not reopen with its draft');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const name = `${kind}-${theme}-${scale}`;
    writeFileSync(join(output, name+'.png'), (await window.webContents.capturePage()).toPNG());
    evidence.push({name, theme, scale, ...result});
  }
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(evidence, null, 2));
  trace('complete'); clearTimeout(deadline); window.destroy(); app.exit(0);
})().catch((error) => { trace(String(error)); console.error(error); app.exit(1); });
