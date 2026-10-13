// 처음 쓰는 사람을 위한 안내(그룹방 / 쪽지)를 실제 브라우저로 확인한다.
//  - 그룹방에 처음 들어오면 그룹방 안내, 쪽지 탭을 처음 열거나 쪽지함으로 들어오면 쪽지 안내가 뜬다 (게스트는 쪽지 안내 없음)
//  - 하이라이트 단계에서는 해당 버튼이 실제로 밝게 비춰지고 안내 카드가 그걸 가리지 않으며, 폰(390px)에서도 화면 안에 들어온다
//  - 끝내거나 건너뛰면 다시 안 뜨고(이 기기에 기록), 설정 → 앱 설치·정보의 "도움말 다시 보기"로 다시 볼 수 있다
//  - 직접 열기(?step=profile)에서는 안 뜬다
// 실행: node tools/tour-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능, SHOTS=폴더 로 화면 사진 저장)
const { AUTH_ENV, signup, loginJs } = require('./_auth');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 6500 + Math.floor(Math.random() * 90), CDP_PORT = 9700 + Math.floor(Math.random() * 90);
const SHOTS = process.env.SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `tour-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...AUTH_ENV, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  try {
    await wait(2500);
    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); if (m.method === 'Runtime.exceptionThrown') console.log('  페이지 예외:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
    async function page(w, h, mobile, query = '') {
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      const p = { js, call };
      p.rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height }; })()`);
      p.tap = async (sel) => {
        await js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`); await wait(100);
        const r = await p.rect(sel); if (!r || !r.w) throw new Error('보이지 않음: ' + sel);
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await wait(250);
      };
      p.type = async (sel, text) => { await p.tap(sel); await call('Input.insertText', { text }); await wait(100); };
      p.key = async (k, code, vk) => { for (const type of ['rawKeyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }); await wait(200); };
      p.shot = async (name) => { if (!SHOTS) return; const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
      p.until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await wait(200); } return false; };
      p.open = async () => { await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/${query}` }); await wait(1500); };
      p.guestIn = async (name) => { await p.tap('#gGuest'); await p.type('#nameIn', name); await p.tap('#enter'); await p.until(`joined`); };
      p.step = () => js(`(document.querySelector('#tourStep') || {}).textContent || ''`);
      p.title = () => js(`(document.querySelector('#tourTitle') || {}).textContent || ''`);
      return p;
    }
    // 하이라이트: 비추는 틀이 대상 버튼을 감싸고, 카드는 그 대상과 겹치지 않으며 화면 안에 있다
    const spotOk = (sel) => `(() => { const t = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(), s = document.querySelector('.tour-spot'), c = document.querySelector('.tour-card').getBoundingClientRect(), sr = s.getBoundingClientRect();
      const wraps = !s.hidden && sr.left <= t.left && sr.top <= t.top && sr.right >= t.right && sr.bottom >= t.bottom;
      const apart = c.right <= t.left || c.left >= t.right || c.bottom <= t.top || c.top >= t.bottom;
      const inside = c.left >= 0 && c.right <= innerWidth && c.top >= 0 && c.bottom <= innerHeight;
      return wraps && apart && inside; })()`;

    console.log('그룹방 안내 (게스트, PC)');
    const G = await page(1280, 860, false); await G.open(); await G.guestIn('안내손님');
    check(await G.until(`!!document.querySelector('#tour')`, 5000), '처음 그룹방에 들어오면 안내가 뜸');
    check((await G.title()) === '그룹방에 오신 걸 환영해요' && (await G.step()) === '1 / 6', '첫 단계는 환영 카드 (1 / 6)');
    check(await G.js(`document.querySelector('#app').inert === true && document.querySelector('#tourNext').textContent === '다음' && document.querySelector('#tourPrev').hidden`), '안내가 떠 있는 동안 뒤 화면은 잠기고, 첫 단계에는 "이전"이 없음');
    await G.shot('1-room-1');
    await G.tap('#tourNext');
    check((await G.step()) === '2 / 6' && await G.js(spotOk('#tab-queue')), '2단계: 대기열 탭을 밝게 비추고, 카드가 그걸 가리지 않음');
    await G.shot('1-room-2');
    for (const [sel, n] of [['#tab-users', 3], ['#voiceBtn', 4], ['#panicBtn', 5], ['#settingsBtn', 6]]) {
      await G.tap('#tourNext');
      check((await G.step()) === `${n} / 6` && await G.js(spotOk(sel)), `${n}단계: ${sel} 를 비춤`);
    }
    check(await G.js(`document.querySelector('#tourNext').textContent === '시작하기' && document.querySelector('#tourSkip').hidden`), '마지막 단계는 "시작하기"');
    await G.tap('#tourPrev'); check((await G.step()) === '5 / 6', '"이전"으로 돌아갈 수 있음');
    await G.tap('#tourNext'); await G.tap('#tourNext');
    check(await G.js(`!document.querySelector('#tour') && get('tour:room') === '1' && document.querySelector('#app').inert === false`), '"시작하기"를 누르면 끝나고, 이 기기에 기록되고, 뒤 화면이 풀림');

    console.log('다시 안 뜨고, 도움말에서 다시 볼 수 있음');
    await G.js('location.reload()'); await wait(1800); await G.guestIn('안내손님');
    await wait(1800);
    check(await G.js(`!document.querySelector('#tour')`), '이미 본 기기에서는 다시 들어와도 안 뜸');
    await G.tap('#settingsBtn'); await G.js(`setPage('app')`); await wait(200);
    check(await G.js(`!document.querySelector('#helpRows').hidden && document.querySelector('#helpDm').closest('.srow').hidden && !document.querySelector('#helpRoom').closest('.srow').hidden`), '설정 → 앱 설치·정보에 "그룹방 도움말"이 있고, 게스트에게는 쪽지 도움말이 없음');
    await G.tap('#helpRoom');
    check(await G.until(`!!document.querySelector('#tour') && !document.querySelector('#settings').open`, 4000) && (await G.step()) === '1 / 6', '"다시 보기"를 누르면 설정 창이 닫히고 안내가 처음부터 다시 뜸');
    await G.key('Escape', 'Escape', 27);
    check(await G.js(`!document.querySelector('#tour')`), 'Esc로 건너뛸 수 있음');
    await G.tap('#tab-dm'); await wait(1200);
    check(await G.js(`!document.querySelector('#tour')`), '게스트가 쪽지 탭을 열어도 쪽지 안내는 안 뜸');

    console.log('쪽지 안내 (로그인한 사람)');
    const A = await signup(PORT, '안내회원');
    const U = await page(1280, 860, false); await U.open(); await U.js(loginJs(A)); await wait(500);
    await U.tap('#gRoom'); await U.tap('#enter'); await U.until(`joined`);
    check(await U.until(`!!document.querySelector('#tour')`, 5000) && (await U.title()) === '그룹방에 오신 걸 환영해요', '로그인한 사람도 그룹방 안내가 먼저 뜸');
    await U.tap('#tourSkip');
    check(await U.js(`get('tour:room') === '1' && get('tour:dm') !== '1'`), '건너뛰어도 그룹방 안내만 본 것으로 기록되고, 쪽지 안내는 따로 남음');
    await U.tap('#tab-dm');
    check(await U.until(`!!document.querySelector('#tour')`, 4000) && (await U.title()) === '쪽지는 암호화돼요' && (await U.step()) === '1 / 4', '쪽지 탭을 처음 열면 쪽지 안내가 뜸');
    await U.tap('#tourNext');
    check((await U.step()) === '2 / 4' && await U.js(spotOk('#dmNew')), '2단계: "새 쪽지" 버튼을 비춤');
    await U.shot('2-dm-2');
    await U.tap('#tourNext'); check((await U.title()) === '정말 암호화되는지 확인하기' && await U.js(`document.querySelector('.tour-spot').hidden`), '3단계: 암호화 확인 방법 (비출 버튼이 없으면 가운데 카드)');
    await U.tap('#tourNext'); await U.tap('#tourNext');
    check(await U.js(`!document.querySelector('#tour') && get('tour:dm') === '1'`), '쪽지 안내를 끝내면 기록됨');
    await U.tap('#settingsBtn'); await U.js(`setPage('app')`);
    check(await U.js(`!document.querySelector('#helpDm').closest('.srow').hidden`), '로그인한 사람에게는 "쪽지 도움말"도 보임');
    await U.js(`closeSettings()`);

    console.log('쪽지함으로 바로 들어온 사람');
    const B = await signup(PORT, '안내쪽지'); const D = await page(1280, 860, false); await D.open(); await D.js(loginJs(B)); await wait(500);
    await D.tap('#gDm'); await D.tap('#inboxBtn'); await D.until(`joined && dmOnly`);
    check(await D.until(`!!document.querySelector('#tour')`, 5000) && (await D.title()) === '쪽지는 암호화돼요', '쪽지함으로 들어오면 그룹방 안내 없이 쪽지 안내가 뜸');
    check(await D.js(`get('tour:room') !== '1'`), '(그룹방 안내는 안 본 것으로 남음)');
    await D.js(`endTour()`);

    console.log('직접 열기에서는 안 뜸');
    const X = await page(1280, 860, false, '?step=profile'); await X.open(); await X.js(`document.querySelector('#nameIn').value = '직접열기'; document.querySelector('#joinForm').requestSubmit()`); await X.until(`joined`); await wait(1800);
    check(await X.js(`!document.querySelector('#tour')`), '?step=profile 로 열면 안내가 안 뜸 (자동 점검 도구용)');

    console.log('폰 (390px)');
    const P = await page(390, 844, true); await P.open(); await P.guestIn('안내폰');
    check(await P.until(`!!document.querySelector('#tour')`, 5000), '폰에서도 안내가 뜸');
    const sizes = await P.js(`[...document.querySelectorAll('.tour-btns button:not([hidden])')].every((b) => { const r = b.getBoundingClientRect(); return r.height >= 44 && r.left >= 0 && r.right <= innerWidth; })`);
    check(sizes, '버튼이 터치 크기(44px) 이상이고 화면 안에 있음');
    await P.shot('3-phone-1');
    for (const [sel, n] of [['#tab-queue', 2], ['#tab-users', 3], ['#voiceBtn', 4], ['#panicBtn', 5], ['#settingsBtn', 6]]) {
      await P.tap('#tourNext');
      check((await P.step()) === `${n} / 6` && await P.js(spotOk(sel)), `폰 ${n}단계: ${sel} 를 비추고 카드가 안 가리며 화면 안에 있음`);
      if (n === 5) await P.shot('3-phone-5');
    }
    await P.tap('#tourNext');
    check(await P.js(`!document.querySelector('#tour')`), '폰에서도 끝까지 갈 수 있음');
    browser.close();
  } catch (e) { console.log('  실패 예외:', e.stack || e); failed++; }
  finally {
    srv.kill(); try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} await wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(state, { force: true }); } catch {}
  }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})();
