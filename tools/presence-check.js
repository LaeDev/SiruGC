// 참가자 목록의 기기 종류(PC/태블릿/모바일)와, 영상·공유 화면 아래에 뜨는 음성 참가자 바를 실제 브라우저 세 창으로 확인한다.
//  PC 창 하나, iPhone으로 위장한 창 하나(390px), iPad로 위장한 창 하나(820px)
// 실행: node tools/presence-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5300 + Math.floor(Math.random() * 90), CDP_PORT = 9400 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

(async () => {
  const state = path.join(os.tmpdir(), `presence-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env'), AWAY_MS: '1500' }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  try {
    await wait(2500);
    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
    async function page(name, { ua, w, h, mobile }) {
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      if (ua) await call('Emulation.setUserAgentOverride', { userAgent: ua });
      await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile });
      if (mobile) await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log(`[${name}] JS 오류:`, r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      await call('Page.navigate', { url: `http://localhost:${PORT}/?step=profile` }); await wait(1200);
      await js(`(() => { document.querySelector('#nameIn').value = '${name}'; document.querySelector('#joinForm').requestSubmit(); })()`); await wait(1000);
      return { js, call, name };
    }
    const until = async (p, expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await p.js(expr)) return true; await wait(200); } return false; };

    const A = await page('피씨', { w: 1100, h: 800 });
    const B = await page('폰', { ua: IPHONE, w: 390, h: 844, mobile: true });
    const C = await page('패드', { ua: IPAD, w: 820, h: 1180, mobile: true });

    console.log('참가자 목록의 기기 종류');
    await A.js(`document.querySelector('#tab-users').click()`);
    const devOf = (p, name) => p.js(`(() => { const li = [...document.querySelectorAll('#users li')].find((l) => l.querySelector('.nm').textContent.startsWith('${name}')); const t = li?.querySelector('.tag.dev'); return t ? t.textContent.trim() : null; })()`);
    await until(A, `document.querySelectorAll('#users li').length === 3`);
    check(await devOf(A, '피씨') === 'PC', '내 줄에 "PC"가 보임');
    check(await devOf(A, '폰') === '모바일', 'iPhone 접속은 "모바일"로 보임');
    check(await devOf(A, '패드') === '태블릿', 'iPad 접속은 "태블릿"으로 보임');
    check(await A.js(`[...document.querySelectorAll('#users .tag.dev')].every((t) => t.querySelector('svg') && t.textContent.trim().length >= 2)`), '기기 표시가 아이콘과 글자를 함께 가짐 (색에만 의존하지 않음)');
    check(await C.js(`document.querySelector('#tab-users').click(), document.querySelector('#users li:nth-child(1) .tag.dev') !== null`), '다른 사람 화면에서도 보임');
    check(await B.js(`document.querySelector('#tab-users').click(), document.documentElement.scrollWidth - innerWidth <= 0`), '폰(390px)에서 기기 표시가 넘치지 않음');
    check(await B.js(`[...document.querySelectorAll('#users .urow')].every((r) => r.scrollWidth <= r.clientWidth + 1)`), '폰에서 줄 안에 이름과 표시가 모두 들어감');
    check(await B.js(`(() => { users = users.concat([{ id: 'zz1', name: '긴이름테스트사용자', uid: 'aaaaaaaaaaaa', away: true, canQueue: true, acct: true, device: 'mobile', prev: '예전이름' }]); sharerId = 'zz1'; renderUsers(); const r = [...document.querySelectorAll('#users .urow')].pop(), nm = r.querySelector('.nm > span').getBoundingClientRect(), box = r.getBoundingClientRect(), tg = r.querySelector('.tags').getBoundingClientRect(); const res = { h: box.height, nameW: nm.width, tagsIn: tg.right <= box.right + 1 && tg.left >= box.left - 1, tags: r.querySelectorAll('.tag').length }; users.pop(); sharerId = null; renderUsers(); return res.tags >= 5 && res.h <= 110 && res.nameW >= 100 && res.tagsIn; })()`), '꼬리표가 5개 넘게 붙어도 닉네임이 줄어들지 않고(100px 이상), 줄 높이가 두 줄 안쪽이며, 꼬리표가 줄 밖으로 안 나감');

    console.log('영상 아래 음성 참가자 바');
    check(await A.js(`document.querySelector('#voiceBar').hidden`), '아무도 음성에 없으면 바가 숨겨져 있음');
    await A.js(`(voicePrefs.ns = false, document.querySelector('#voiceBtn').click())`); await wait(600);
    await B.js(`(voicePrefs.ns = false, document.querySelector('#voiceBtn').click())`);
    check(await until(A, `document.querySelectorAll('#voiceBar .vp').length === 2 && !document.querySelector('#voiceBar').hidden`) && await until(B, `document.querySelectorAll('#voiceBar .vp').length === 2`), '음성에 들어간 두 사람이 양쪽 화면의 바에 보임');
    check(await until(C, `document.querySelectorAll('#voiceBar .vp').length === 2`), '음성에 안 들어간 사람(패드)에게도 누가 음성에 있는지 보임');
    const below = (p) => p.js(`(() => { const bar = document.querySelector('#voiceBar').getBoundingClientRect(); const above = ['#empty', '#ytWrap', '#screenWrap', '#seg'].map((s) => document.querySelector(s)).filter((e) => e && !e.hidden).map((e) => e.getBoundingClientRect().bottom); return above.length > 0 && bar.top >= Math.max(...above) - 1; })()`);
    check(await below(A), 'PC: 바가 영상(또는 안내) 영역 바로 아래에 있음');
    check(await below(B), '폰: 바가 영상 영역 아래에 있음');
    check(await below(C), '태블릿: 바가 영상 영역 아래에 있음');
    check(await A.js(`[...document.querySelectorAll('#voiceBar .vp')].map((c) => c.querySelector('.nm').textContent).sort().join() === '나,폰'`), '내 칩은 "나", 상대는 이름으로 보임');
    check(await until(A, `!!document.querySelector('#voiceBar .vp .av.speaking')`, 8000), '말하는 사람의 아바타에 말하는 표시(테두리)가 켜짐');
    check(await A.js(`[...document.querySelectorAll('#voiceBar .vp .av')].every((a) => a.dataset.id)`), '칩의 아바타는 말하는 표시와 연결되는 번호를 가짐');

    await B.js(`document.querySelector('#micBtn').click()`);
    check(await until(A, `(() => { const c = [...document.querySelectorAll('#voiceBar .vp')].find((x) => x.querySelector('.nm').textContent === '폰'); return !!c?.querySelector('.vi') && c.getAttribute('aria-label').includes('마이크 꺼짐'); })()`), '마이크를 끄면 그 사람 칩에 꺼짐 아이콘과 설명이 생김');
    await B.js(`document.querySelector('#micBtn').click()`);

    console.log('폰·태블릿 화면 맞춤');
    const geo = (p) => p.js(`(() => { const bar = document.querySelector('#voiceBar'); return { overflow: document.documentElement.scrollWidth - innerWidth, barRight: bar.getBoundingClientRect().right - innerWidth, minH: Math.min(...[...bar.querySelectorAll('.vp')].map((c) => c.getBoundingClientRect().height)) }; })()`);
    const gb = await geo(B), gc = await geo(C), ga = await geo(A);
    check(gb.overflow <= 0 && gb.barRight <= 0, `폰: 가로로 넘치지 않음 (${gb.overflow}px)`);
    check(gc.overflow <= 0 && gc.barRight <= 0, `태블릿: 가로로 넘치지 않음 (${gc.overflow}px)`);
    check(Math.min(gb.minH, gc.minH, ga.minH) >= 44, `칩 높이가 터치 크기(44px) 이상 (${Math.round(Math.min(gb.minH, gc.minH, ga.minH))}px)`);
    await B.js(`document.querySelector('#tab-chat').click()`); await wait(300);
    check(await B.js(`(() => { const chat = document.querySelector('#chatIn').getBoundingClientRect(); return chat.bottom <= innerHeight && chat.top > 0; })()`), '폰에서 바가 생겨도 채팅 입력창이 화면 안에 그대로 보임');

    await B.js(`(voicePrefs.ns = false, document.querySelector('#voiceBtn').click())`);
    check(await until(A, `document.querySelectorAll('#voiceBar .vp').length === 1`), '나가면 바에서 사라짐');
    await A.js(`(voicePrefs.ns = false, document.querySelector('#voiceBtn').click())`);
    check(await until(C, `document.querySelector('#voiceBar').hidden`), '모두 나가면 바가 다시 숨겨짐');
    console.log('폰 화면이 꺼졌을 때(전원 버튼)');
    await A.js(`document.querySelector('#tab-users').click()`);
    const rowOf = (name) => `[...document.querySelectorAll('#users li')].find((l) => l.querySelector('.nm').textContent.startsWith('${name}'))`;
    await B.js(`window.__attempt = attempt; attempt = () => {}`); // 꺼진 화면은 다시 연결하지 못한다
    await B.js(`dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))`); // 화면이 꺼질 때 오는 이벤트
    await wait(800);
    check(await A.js(`!!(${rowOf('폰')})`), '화면이 꺼져도(pagehide) 폰은 바로 나가지 않고 참가자 목록에 남아 있음');
    await B.js(`dropSocket('screen-off')`); // 연결이 끊김
    check(await until(A, `(() => { const li = ${rowOf('폰')}; return !!li && [...li.querySelectorAll('.tag')].some((t) => t.textContent === '자리 비움'); })()`, 6000), '연결이 끊긴 폰은 참가자 목록에 "자리 비움" 글자와 함께 남음');
    check(await A.js(`![...document.querySelectorAll('.sys')].some((x) => x.textContent.includes('폰 님이 나갔어요'))`), '그 사이 "나갔어요" 알림은 없음');
    check(await A.js(`(() => { const li = ${rowOf('폰')}; const a = li.querySelector('.av'); return getComputedStyle(a).opacity < 1; })()`), '자리 비움은 아바타가 흐려져 한눈에 구분됨');
    await B.js(`attempt = window.__attempt; scheduleAttempt(0)`); // 화면을 켜고 돌아옴
    check(await until(B, `joined && !reconnecting && ws.readyState === 1`, 8000), '화면을 켜면 같은 자리로 다시 연결됨');
    check(await until(A, `(() => { const li = ${rowOf('폰')}; return !!li && ![...li.querySelectorAll('.tag')].some((t) => t.textContent === '자리 비움'); })()`, 6000), '돌아오면 "자리 비움"이 사라짐');
    check(await A.js(`[...document.querySelectorAll('.sys')].filter((x) => x.textContent.includes('폰 님이 들어왔어요')).length === 1 && ![...document.querySelectorAll('.sys')].some((x) => x.textContent.includes('폰 님이 나갔어요'))`), '돌아와도 "들어왔어요"가 또 찍히거나 "나갔어요"가 찍히지 않음 (처음 입장 때 한 번뿐)');
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
