// 첫 화면의 흐름을 실제 브라우저로 확인한다:  로그인·가입 → 쪽지 / 그룹방 → (프로필을 아직 안 정했으면) 프로필 설정
//  - 처음에는 로그인·가입 버튼만 보이고(닉네임·프로필 칸은 숨김), 게스트로 그룹방만 둘러볼 수도 있다
//  - 로그인하면 쪽지 / 그룹방 선택이 나오고, 프로필을 안 정했으면 고른 뒤에 프로필 설정이 나온다. 정한 뒤로는 바로 들어간다
//  - 프로필 바꾸기, 뒤로, 로그아웃, 폰 화면(390px)에서 넘치지 않는지
// 실행: node tools/join-flow-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능, SHOTS=폴더 로 화면 사진 저장)
const { AUTH_ENV, signup, loginJs } = require('./_auth');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 6200 + Math.floor(Math.random() * 90), CDP_PORT = 9400 + Math.floor(Math.random() * 90);
const SHOTS = process.env.SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `joinflow-${Date.now()}.json`);
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
    async function page(w, h, mobile) { // 기기 하나 = 따로 저장소를 쓰는 브라우저 문맥 하나
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      const p = { js, call };
      p.rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, l: b.left, r: b.right, t: b.top, b: b.bottom }; })()`);
      p.tap = async (sel) => { // 실제로 그 자리를 누른다
        await js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`); await wait(100);
        const r = await p.rect(sel); if (!r || !r.w) throw new Error('보이지 않음: ' + sel);
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await wait(200);
      };
      p.type = async (sel, text) => { await p.tap(sel); await call('Input.insertText', { text }); await wait(100); };
      p.shot = async (name) => { if (!SHOTS) return; const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
      p.until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await wait(200); } return false; };
      p.open = async () => { await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await wait(1500); };
      p.visible = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })()`);
      p.step = () => js(`document.querySelector('#joinForm').dataset.step`);
      return p;
    }
    const noOverflow = `document.documentElement.scrollWidth <= innerWidth`;
    const all = async (p, sels) => { for (const s of sels) if (!(await p.visible(s))) return false; return true; };
    const none = async (p, sels) => { for (const s of sels) if (await p.visible(s)) return false; return true; };

    console.log('1단계: 로그인 / 가입 (처음 온 사람)');
    const D = await page(1280, 860, false); await D.open();
    check((await D.step()) === 'auth', '처음 화면은 로그인·가입 단계');
    check(await all(D, ['#gLogin', '#gSignup', '#gGuest']), '로그인, 가입하기 버튼과 게스트 둘러보기가 보임');
    check(await none(D, ['#nameIn', '#enter', '#inboxBtn', '#makeWrap', '#gDm', '#gRoom']), '닉네임·프로필·입장·쪽지/그룹방 선택은 아직 안 보임');
    await D.shot('1-auth-desktop');
    await D.tap('#gLogin'); check(await D.js(`document.querySelector('#authDlg').open && authMode === 'login'`), '로그인 버튼을 누르면 로그인 창이 열림');
    await D.js(`document.querySelector('#authClose').click()`); await wait(200);
    await D.tap('#gSignup'); check(await D.js(`document.querySelector('#authDlg').open && authMode === 'signup'`), '가입하기 버튼을 누르면 가입 창이 열림');
    await D.js(`document.querySelector('#authClose').click()`); await wait(200);

    console.log('2단계: 쪽지 / 그룹방 (로그인한 사람)');
    const A = await signup(PORT, '흐름가나');
    await D.js(loginJs(A)); await wait(500);
    check((await D.step()) === 'pick', '로그인하면 쪽지 / 그룹방 선택 단계로 넘어감');
    check(await all(D, ['#gDm', '#gRoom', '#gProfile', '#gLogout']) && await none(D, ['#gLogin', '#nameIn', '#enter']), '쪽지, 그룹방 두 선택과 프로필 바꾸기·로그아웃이 보임');
    check(await D.js(`document.querySelector('#pickWho').textContent === '흐름가나'`), '내 닉네임으로 인사함');
    await D.shot('2-pick-desktop');

    console.log('3단계: 프로필 설정 (아직 안 정했을 때)');
    await D.tap('#gRoom');
    check((await D.step()) === 'profile' && !(await D.js(`joined`)), '그룹방을 누르면 프로필을 안 정했으니 입장하지 않고 프로필 설정이 나옴');
    check(await all(D, ['#nameIn', '#enter', '#makeWrap', '#preview', '#joinBack']) && await none(D, ['#inboxBtn', '#profileOk', '#gRoom']), '닉네임·프로필 꾸미기와 "입장하기"만 보임 (쪽지함 버튼은 숨김)');
    check(await D.js(`document.querySelector('#nameIn').readOnly && document.querySelector('#nameIn').value === '흐름가나'`), '닉네임은 내 계정 이름으로 고정됨');
    await D.shot('3-profile-desktop');
    await D.tap('#joinBack'); check((await D.step()) === 'pick', '뒤로를 누르면 선택 단계로 돌아감');
    await D.tap('#gRoom'); await D.js(`document.querySelector('#emojis button')?.click()`);
    await D.tap('#enter'); check(await D.until(`joined && !dmOnly`), '입장하기를 누르면 그룹방에 들어감');
    check(await D.js(`get('profDone') === '흐름가나'`), '프로필 단계를 거치면 이 기기에 기록됨');

    console.log('프로필을 정한 뒤에는 바로 입장');
    await D.js(`sessionStorage.removeItem('autoJoin'); location.reload()`); await wait(1800);
    check((await D.step()) === 'pick', '다시 열면 바로 쪽지 / 그룹방 선택');
    await D.tap('#gRoom'); check(await D.until(`joined && !dmOnly`, 6000), '그룹방을 누르면 프로필 단계 없이 바로 들어감');

    console.log('쪽지: 프로필을 안 정한 계정은 쪽지에서도 프로필 설정을 거침');
    const B = await signup(PORT, '흐름다라'); const E = await page(1280, 860, false); await E.open(); await E.js(loginJs(B)); await wait(500);
    await E.tap('#gDm');
    check((await E.step()) === 'profile' && await all(E, ['#inboxBtn']) && await none(E, ['#enter', '#profileOk']), '쪽지를 누르면 프로필 설정이 나오고 버튼은 "쪽지함"만 보임');
    await E.tap('#inboxBtn'); check(await E.until(`joined && dmOnly`), '쪽지함으로 들어가면 방에는 안 들어가고 쪽지함 화면이 열림');

    console.log('프로필 바꾸기 / 로그아웃');
    const F = await page(1280, 860, false); await F.open(); await F.js(loginJs(B)); await wait(500);
    await F.tap('#gProfile');
    check((await F.step()) === 'profile' && await all(F, ['#profileOk', '#makeWrap']) && await none(F, ['#enter', '#inboxBtn']), '프로필 바꾸기: 프로필 화면과 "확인" 버튼만 보임');
    await F.tap('#profileOk'); check((await F.step()) === 'pick', '확인을 누르면 선택 단계로 돌아감');
    await F.tap('#gLogout'); await wait(2000);
    check((await F.step()) === 'auth' && await all(F, ['#gLogin']) && !(await F.js(`loggedIn()`)), '로그아웃하면 처음 단계로 돌아옴');

    console.log('실제 로그인 창으로 로그인 (서버에 프로필이 있는 계정은 프로필 설정을 건너뜀)');
    await F.tap('#gLogin'); await F.type('#authName', '흐름다라'); await F.type('#authPw', B.password); await F.tap('#authGo');
    check(await F.until(`document.querySelector('#joinForm').dataset.step === 'pick'`, 8000), '로그인 창에서 로그인하면 선택 단계로');
    check(await F.js(`get('profDone') === '흐름다라'`), '서버에 이미 프로필이 있어 프로필 설정을 건너뜀');
    await F.tap('#gRoom'); check(await F.until(`joined && !dmOnly`, 6000), '그래서 그룹방을 누르면 바로 들어감');

    console.log('게스트');
    const G = await page(1280, 860, false); await G.open(); await G.tap('#gGuest');
    check((await G.step()) === 'profile' && await all(G, ['#nameIn', '#enter', '#joinBack']) && await none(G, ['#inboxBtn', '#profileOk']), '게스트로 둘러보기: 닉네임·프로필과 "입장하기"만 보임');
    check(await G.js(`!document.querySelector('#nameIn').readOnly`), '닉네임을 직접 적을 수 있음');
    await G.tap('#joinBack'); check((await G.step()) === 'auth', '뒤로를 누르면 처음 단계');
    await G.tap('#gGuest'); await G.type('#nameIn', '흐름손님'); await G.tap('#enter');
    check(await G.until(`joined && !dmOnly && !document.querySelector('#join').offsetParent`), '게스트로 그룹방에 들어감');

    console.log('폰 화면 (390px)');
    const P = await page(390, 844, true); await P.open();
    check(await P.js(noOverflow), '로그인·가입 단계가 가로로 넘치지 않음');
    check(await P.js(`['#gLogin', '#gSignup', '#gGuest'].every((s) => { const b = document.querySelector(s).getBoundingClientRect(); return b.height >= 44 && b.left >= 0 && b.right <= innerWidth; })`), '버튼이 터치 크기(44px) 이상이고 화면 안에 있음');
    await P.shot('4-auth-phone');
    const C = await signup(PORT, '흐름폰'); await P.js(loginJs(C)); await wait(500);
    check(await P.js(noOverflow) && await P.js(`['#gDm', '#gRoom', '#gProfile', '#gLogout'].every((s) => { const b = document.querySelector(s).getBoundingClientRect(); return b.height >= 44 && b.left >= 0 && b.right <= innerWidth; })`), '쪽지 / 그룹방 선택 단계도 넘치지 않고 터치 크기');
    await P.shot('5-pick-phone');
    await P.tap('#gRoom');
    check((await P.step()) === 'profile' && await P.js(noOverflow), '프로필 설정 단계도 넘치지 않음');
    await P.shot('6-profile-phone');
    browser.close();
  } catch (e) { console.log('  실패 예외:', e.stack || e); failed++; }
  finally {
    srv.kill(); try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} await wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(state, { force: true }); } catch {}
  }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})();
