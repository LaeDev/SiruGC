// 폰·패드 화면 비율을 Chrome 으로 흉내 내서(크기·배율·터치·UA) 여러 화면을 돌며 기계로 잴 수 있는 문제를 찾는다.
//  - 가로 넘침, 터치 크기(40px 미만), 화면 밖으로 나간 버튼, 다른 요소에 가려서 눌리지 않는 버튼, 너무 작은 글씨(12px 미만)
//  - 화면마다 사진도 남긴다(SHOTS=폴더). 사진은 사람이 보고 UX 를 판단하는 용도다.
// 실행: node tools/device-audit.js   (CHROME 환경변수로 chrome.exe 경로 지정, ONLY=기기이름일부 로 일부만, SHOTS=폴더)
// 이 도구는 문제 목록을 보여 줄 뿐 실패로 끝나지 않는다(*-check.js 와 달리 전체 점검에 안 들어간다).
const { AUTH_ENV, signup, loginJs } = require('./_auth');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 7300 + Math.floor(Math.random() * 90), CDP_PORT = 9800 + Math.floor(Math.random() * 90);
const SHOTS = process.env.SHOTS || '', ONLY = process.env.ONLY || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const AND = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const DEVICES = [
  ['iPhone SE 375x667', 375, 667, 2, IOS], ['iPhone 14 390x844', 390, 844, 3, IOS], ['iPhone 14 가로 844x390', 844, 390, 3, IOS],
  ['Pixel 7 412x915', 412, 915, 2.6, AND], ['소형 Android 360x640', 360, 640, 2, AND],
  ['iPad mini 세로 744x1133', 744, 1133, 2, IPAD], ['iPad 세로 820x1180', 820, 1180, 2, IPAD], ['iPad 가로 1180x820', 1180, 820, 2, IPAD],
  ['iPhone 14 Pro 393x852', 393, 852, 3, IOS], ['iPad Pro 12.9 세로 1024x1366', 1024, 1366, 2, IPAD], ['iPad Pro 12.9 가로 1366x1024', 1366, 1024, 2, IPAD],
].filter((d) => !ONLY || d[0].includes(ONLY));

// 화면 안에서 재는 코드: 문제 목록(문자열)을 돌려준다
const LINT = `(() => {
  const out = [], vw = innerWidth, vh = innerHeight;
  const vis = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05; };
  const nm = (e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/)[0] : '')) + '「' + (e.getAttribute('aria-label') || e.innerText || e.value || '').trim().replace(/\\s+/g, ' ').slice(0, 14) + '」';
  if (document.documentElement.scrollWidth > vw + 1) out.push('가로 넘침 ' + (document.documentElement.scrollWidth - vw) + 'px (' + [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > vw + 1).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right).slice(0, 4).map((e) => nm(e) + Math.round(e.getBoundingClientRect().right)).join(', ') + ')');
  // 모달 창·안내·패닉 화면이 떠 있으면 그 안의 것만 본다 (뒤의 화면은 못 누르는 게 정상이라 "가려짐"으로 잡히면 안 된다)
  const top = document.querySelector('dialog[open]') || document.querySelector('#tour') || (document.querySelector('#saver:not([hidden])') && document.querySelector('#saver'));
  const q = [...document.querySelectorAll('button, a[href], input:not([type=hidden]):not([type=file]), select, textarea, summary, [role=tab], [role=button], [tabindex="0"]')].filter(vis).filter((e) => !top || top.contains(e));
  const seen = new Set();
  for (const e of q) {
    const r = e.getBoundingClientRect(); if (e.closest('[inert]')) continue;
    if (e.matches('input.swt, .tc input, input[type=radio], input[type=checkbox]')) continue;
    if (e.classList.contains('skip') || e.id === 'resizer') continue;
    if (e.closest('details:not([open])') && e.tagName !== 'SUMMARY') continue; // 접힌 칸 안은 안 보이는 것
    if (e.tagName === 'SUMMARY' && e.parentElement.matches('details') && e.closest('details:not([open]) details:not([open])') && e.parentElement.parentElement.closest('details:not([open])')) continue; // (resizer: 영상과 채팅 사이를 끄는 손잡이. 일부러 가늘다)
    if (Math.min(r.width, r.height) < 40 && !e.closest('.tc, .sw, .emojis, .swatches, .picker')) out.push('작은 터치 대상 ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + nm(e));
    if (r.left < -1 || r.right > vw + 1) out.push('옆으로 잘림 ' + nm(e) + ' (' + Math.round(r.left) + '~' + Math.round(r.right) + ' / ' + vw + ')');
    // 가려짐: 가운데 점의 맨 위 요소가 자기(또는 안쪽)가 아니면 못 누른다 (화면 안에 있는 것만)
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx >= 0 && cx <= vw && cy >= 0 && cy <= vh) {
      const top = document.elementFromPoint(cx, cy);
      if (top && top !== e && !e.contains(top) && !top.contains(e) && !(e.closest('label') && e.closest('label').contains(top))) { const k = nm(e) + '>' + nm(top); if (!seen.has(k)) { seen.add(k); out.push('가려짐 ' + nm(e) + ' ← ' + nm(top)); } }
    }
  }
  const small = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim(); if (!t) continue; const p = n.parentElement; if (!p || !vis(p) || p.closest('[hidden], script, style, .sr')) continue;
    const fs = parseFloat(getComputedStyle(p).fontSize); if (fs < 12 && !small.has(p)) { small.add(p); out.push('작은 글씨 ' + fs + 'px ' + nm(p)); }
  }
  return [...new Set(out)];
})()`;

(async () => {
  const state = path.join(os.tmpdir(), `audit-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...AUTH_ENV, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const report = [];
  try {
    await wait(2500);
    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); if (m.method === 'Runtime.exceptionThrown') report.push(['예외', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text]); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
    const acct = await signup(PORT, '감사회원'), peer = await signup(PORT, '감사상대');
    for (const [dname, w, h, dpr, ua] of DEVICES) {
      console.log('\n== ' + dname);
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setUserAgentOverride', { userAgent: ua });
      await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: true });
      await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) report.push([dname, 'JS 오류', r.result.exceptionDetails.exception?.description]); return r.result?.result?.value; };
      const tap = async (sel) => {
        await js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`); await wait(80);
        const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; })()`);
        if (!r || !r.w) { report.push([dname, '화면 준비', '보이지 않음: ' + sel]); return false; }
        await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] }); await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(250); return true;
      };
      const audit = async (label, shot = true) => {
        await wait(250);
        const issues = await js(LINT);
        for (const i of issues || []) report.push([dname, label, i]);
        if (SHOTS && shot) { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, (dname + '_' + label).replace(/[^\w가-힣]+/g, '_') + '.png'), Buffer.from(r.result.data, 'base64')); }
        console.log('  ' + label + ': ' + (issues?.length ? issues.length + '건' : '문제 없음'));
      };
      const nav = async (q = '') => { await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/${q}` }); await wait(1500); };

      await nav(); await audit('1 첫화면 로그인가입');
      await js(loginJs(acct)); await wait(500); await audit('2 첫화면 쪽지-그룹방 선택');
      await tap('#gRoom'); await audit('3 프로필 설정');
      await tap('#joinSettings'); await audit('3b 첫화면 설정 목록'); await js('closeSettings()');
      await tap('#enter'); await js('joined').then(() => wait(1200));
      await audit('4 그룹방 안내(온보딩) 1단계');
      for (let i = 2; i <= 6; i++) { await tap('#tourNext'); await audit('4 온보딩 ' + i + '단계', i === 2 || i === 5); }
      await tap('#tourNext');
      await audit('5 그룹방 채팅');
      await js(`users = users.concat([{ id: 'a1', name: '길고긴닉네임테스트사용자', uid: 'aaaaaaaaaaaa', away: true, canQueue: true, acct: true, device: 'mobile', prev: '예전이름' }, { id: 'a2', name: '호스트', uid: 'bbbbbbbbbbbb', host: true, device: 'pc' }]); renderUsers()`);
      await tap('#tab-queue'); await audit('6 대기열');
      await tap('#tab-users'); await audit('7 참가자(꼬리표 많음)');
      await js(`openUser = 'a1'; renderUsers()`); await audit('7b 참가자 메뉴 펼침');
      await js(`openUser = null; renderUsers()`);
      await tap('#tab-dm'); await wait(800); await js('endTour?.()'); await audit('8 쪽지 목록');
      await js(`dmPeers.set('${peer.uid || 'cccccccccccc'}', { uid: '${peer.uid || 'cccccccccccc'}', name: '감사상대', unread: 2, last: { text: '안녕하세요 오늘 영상 같이 볼까요? 아주 긴 미리보기 문장입니다', ts: Date.now(), mine: false } }); dmRender()`); await audit('8b 쪽지 목록(상대 있음)');
      await js(`openDm('${peer.uid || 'cccccccccccc'}', { name: '감사상대' })`); await wait(600); await audit('9 쪽지 대화창');
      await js(`document.querySelector('#dmBack').click()`);
      await tap('#settingsBtn'); await audit('10 설정 목록');
      for (const cat of ['look', 'voice', 'notif', 'hide', 'acct', 'app']) { await js(`setPage('${cat}')`); await audit('10 설정 ' + cat); }
      await js('closeSettings()');
      await js(`offerUpdate()`); await audit('11 새 버전 띠'); await js(`document.querySelector('#upd')?.remove()`);
      await tap('#panicBtn'); await wait(1200); await audit('12 패닉 화면'); await js('unlockSaver()');
      await js(`openAuth('login')`); await audit('13 로그인 창'); await js(`closeAuth()`);
      await tap('#tab-chat'); await audit('14 채팅(다시)', false);
      await call('Target.closeTarget', { targetId });
    }
    browser.close();
  } finally {
    srv.kill(); try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} await wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(state, { force: true }); } catch {}
  }
  console.log('\n================ 문제 목록 (' + report.length + '건) ================');
  const by = {}; for (const [d, l, m] of report) (by[l + ' | ' + m] ||= new Set()).add(d);
  for (const [k, ds] of Object.entries(by)) console.log('- ' + k + '   ← ' + [...ds].join(', '));
  process.exit(0);
})();
