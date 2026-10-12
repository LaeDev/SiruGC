// 모바일과 PC의 UI가 같은지 확인한다. 같은 시나리오(입장 → 채팅 → 각 탭 → 설정 창 → 음성)를 PC와 여러 모바일 크기에서 실행하고
// 화면 요소를 수치로 비교한다. 다른 점은 표로 출력하고, 화면별 스크린샷을 남긴다.
//   - 컨트롤: PC에 있는 버튼·입력창이 모바일에도 있고 보이는가 (반대도)
//   - 라벨: 글자가 같이 보이는가 (모바일에서만 아이콘만 보이면 '다름')
//   - 문구: 화면에 보이는 글자가 같은가
//   - 스타일: 같은 부품의 색·글꼴·모서리·그림자가 같은가
//   - 테마 토큰: 색상 값이 같은가
//   - 모바일: 터치 크기 44px 이상, 가로 넘침 없음
// 실행: node tools/parity-check.js [출력폴더]   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'parity'));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 4700 + Math.floor(Math.random() * 90), CDP_PORT = 9700 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { key: 'PC 1280x860', w: 1280, h: 860, mobile: false, dpr: 1 };
const MOBILES = [
  { key: '폰 세로 390x844', w: 390, h: 844, mobile: true, dpr: 3 },
  { key: '작은 폰 360x640', w: 360, h: 640, mobile: true, dpr: 2 },
  { key: '폰 가로 844x390', w: 844, h: 390, mobile: true, dpr: 3 },
  { key: '태블릿 768x1024', w: 768, h: 1024, mobile: true, dpr: 2 },
];

// ---- 브라우저 안에서 실행되는 화면 요약 (Function.toString으로 넘기므로 이스케이프 걱정이 없다) ----
function snapshot() {
  const vis = (e) => {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('[hidden]') && !e.closest('dialog:not([open])');
  };
  const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  const nameOf = (e) => clean(e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || e.placeholder || e.value);
  const controls = [...document.querySelectorAll('button, a[href], input:not([type=hidden]):not([type=file]), select, textarea, summary, [role=tab]')]
    .filter(vis).filter((e) => !e.classList.contains('skip')).map((e) => {
      const r = e.getBoundingClientRect();
      return { name: nameOf(e), tag: e.tagName.toLowerCase() + (e.type && e.tagName === 'INPUT' ? ':' + e.type : ''), label: clean(e.innerText), w: Math.round(r.width), h: Math.round(r.height),
        clipped: r.left < -1 || r.right > innerWidth + 1 };
    });
  const copy = [...document.querySelectorAll('h1,h2,h3,h4,p,label,legend,summary,.lbl,.tag,.sys,.bubble b,.t,.tc-n,.tc-d,.badge')]
    .filter(vis).map((e) => clean(e.innerText)).filter(Boolean).map((t) => t.replace(/(오전|오후) \d+:\d+/g, '').trim()).filter(Boolean);
  const SEL = ['body', '.btn', '.btn.primary', '.btn.go', '.btn.blue', '.stabs button[aria-selected=true]', '.bubble', '.tag', '.av', 'input[type=text]', '.now', '.frame', '.maker', '.tc', '.dot'];
  const styles = {};
  for (const sel of SEL) {
    const e = [...document.querySelectorAll(sel)].find(vis); if (!e) continue;
    const cs = getComputedStyle(e);
    styles[sel] = Object.fromEntries(['fontFamily', 'fontWeight', 'fontSize', 'color', 'backgroundColor', 'borderTopLeftRadius', 'borderTopColor', 'borderTopWidth', 'boxShadow'].map((p) => [p, cs[p]]));
  }
  const root = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries(['--bg', '--surface', '--surface-2', '--line', '--text', '--muted', '--accent', '--on-accent', '--accent-text', '--danger', '--focus', '--ok', '--info', '--on-ok', '--on-info', '--on-danger'].map((k) => [k, root.getPropertyValue(k).trim()]));
  return { controls, copy, styles, tokens, hscroll: document.documentElement.scrollWidth - innerWidth, title: document.title };
}

(async () => {
  const state = path.join(os.tmpdir(), `par-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env'), RESUME_GRACE_MS: '200' }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', '--hide-scrollbars',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'], { stdio: 'ignore' });
  const results = {}; // 프로필 → 상태 → 요약
  try {
    await wait(2500);
    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });

    for (const prof of [DESKTOP, ...MOBILES]) {
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank' });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log(`[${prof.key}] JS 오류:`, r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: prof.w, height: prof.h, deviceScaleFactor: prof.dpr, mobile: prof.mobile, screenOrientation: prof.w > prof.h ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 } });
      await call('Emulation.setTouchEmulationEnabled', { enabled: prof.mobile, maxTouchPoints: prof.mobile ? 5 : 0 });
      await call('Page.navigate', { url: `http://localhost:${PORT}` }); await wait(1500);
      const snap = async (stateKey) => {
        await wait(350);
        (results[prof.key] ||= {})[stateKey] = await js(`(${snapshot.toString()})()`);
        const shot = await call('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT, `${prof.key.replace(/[ ]/g, '_')}__${stateKey}.png`), Buffer.from(shot.result.data, 'base64'));
      };
      await snap('1 입장 화면');
      await js(`(() => { const n = document.querySelector('#nameIn'); n.value = '하늘'; n.dispatchEvent(new Event('input')); document.querySelector('#joinForm').requestSubmit(); })()`);
      await wait(1200);
      // 같은 상황을 만들기 위해 다른 참가자가 들어와 채팅한다
      const guest = new WebSocket(`ws://localhost:${PORT}`);
      await new Promise((r) => guest.on('open', r));
      guest.send(JSON.stringify({ t: 'join', name: '지나가던 코끼리', cid: 'guest-cid-000001', color: '#6ee7a8' })); await wait(400);
      for (const t of ['안녕하세요! 오늘 같이 볼 영상 올릴게요', '조회수 1,234,567,890회짜리 영상인데 제목이 아주아주아주아주 길어요']) { guest.send(JSON.stringify({ t: 'chat', text: t })); await wait(400); }
      await wait(600); // 마지막 채팅이 화면에 그려질 시간
      await snap('2 방 - 채팅 탭');
      for (const [tab, label] of [['queue', '3 방 - 대기열 탭'], ['users', '4 방 - 참가자 탭'], ['dm', '5 방 - 쪽지 탭']]) {
        if (!(await js(`!!document.querySelector('#tab-${tab}')`))) continue;
        await js(`document.querySelector('#tab-${tab}').click()`); await snap(label);
      }
      await js(`document.querySelector('#tab-chat').click()`);
      await js(`document.querySelector('#voiceBtn').click()`); await wait(1000);
      await snap('6 방 - 음성 참가 중');
      await js(`document.querySelector('#settingsBtn').click()`); await snap('7 설정 창');
      await js(`document.querySelector('#settings').close()`);
      guest.close();
      await raw('Target.closeTarget', { targetId }); await wait(700); // 이전 프로필의 접속이 정리될 시간
    }
    browser.close();
  } finally { chrome.kill(); srv.kill(); fs.rmSync(state, { force: true }); }

  // ================= 비교 =================
  const D = results[DESKTOP.key];
  let total = 0;
  for (const m of MOBILES) {
    const M = results[m.key];
    console.log(`\n══ ${DESKTOP.key} ↔ ${m.key}`);
    const diffs = [];
    for (const state of Object.keys(D)) {
      const d = D[state], x = M[state];
      if (!x) { diffs.push([state, '화면 자체가 없음', '']); continue; }
      const key = (c) => `${c.tag} "${c.name}"`;
      const dm = new Map(d.controls.map((c) => [key(c), c])), xm = new Map(x.controls.map((c) => [key(c), c]));
      for (const [k, c] of dm) {
        const o = xm.get(k);
        if (!o) diffs.push([state, '컨트롤이 모바일에 없음', k]);
        else {
          if (!!c.label !== !!o.label) diffs.push([state, `라벨 표시가 다름 (PC: ${c.label ? '"' + c.label + '"' : '아이콘만'} / 모바일: ${o.label ? '"' + o.label + '"' : '아이콘만'})`, k]);
        }
      }
      for (const k of xm.keys()) if (!dm.has(k)) diffs.push([state, '컨트롤이 PC에 없음', k]);
      for (const c of x.controls) {
        if (c.tag.startsWith('input') && c.tag !== 'input:text' && c.tag !== 'input:search' && c.tag !== 'input:color' && c.tag !== 'input:radio') continue;
        if ((c.h < 44 || c.w < 44) && !/^(input:radio)$/.test(c.tag)) diffs.push([state, `터치 크기가 작음 (${c.w}x${c.h})`, key(c)]);
        if (c.clipped && m.w < 900 && !/^(skip)/.test(c.name)) diffs.push([state, '화면 밖으로 잘림', key(c)]);
      }
      const dc = new Set(d.copy), xc = new Set(x.copy);
      for (const t of dc) if (!xc.has(t)) diffs.push([state, '문구가 모바일에서 안 보임', `"${t.slice(0, 40)}"`]);
      for (const t of xc) if (!dc.has(t)) diffs.push([state, '문구가 PC에서 안 보임', `"${t.slice(0, 40)}"`]);
      for (const sel of Object.keys(d.styles)) for (const p of Object.keys(d.styles[sel])) {
        const a = d.styles[sel][p], b = x.styles[sel]?.[p];
        if (b !== undefined && a !== b && !(sel === 'body' && p === 'fontSize')) diffs.push([state, `스타일이 다름 ${p}`, `${sel}: ${a} → ${b}`]);
      }
      for (const k of Object.keys(d.tokens)) if (d.tokens[k] !== x.tokens[k]) diffs.push([state, '테마 토큰이 다름', `${k}: ${d.tokens[k]} → ${x.tokens[k]}`]);
      if (x.hscroll > 0) diffs.push([state, `가로로 넘침 ${x.hscroll}px`, '']);
    }
    // 같은 내용은 하나로 합쳐 보여 준다
    const grouped = new Map();
    for (const [state, what, detail] of diffs) { const k = what + '|' + detail; (grouped.get(k) || grouped.set(k, { what, detail, states: [] }).get(k)).states.push(state.split(' ')[0]); }
    for (const g of grouped.values()) console.log(`  ✗ ${g.what}${g.detail ? ' — ' + g.detail : ''}   [화면 ${[...new Set(g.states)].join(',')}]`);
    if (!grouped.size) console.log('  ✓ 다른 점 없음');
    total += grouped.size;
  }
  console.log(`\n스크린샷: ${OUT}`);
  console.log(total ? `다른 점 ${total}건` : '모든 크기에서 PC와 동일');
  process.exit(total ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
