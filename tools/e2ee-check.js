// 쪽지 종단 암호화를 실제 브라우저로 확인한다.
//  - 보낸 쪽지가 서버 저장 파일에 평문으로 남지 않고, 받는 쪽 화면에서는 읽힌다
//  - 키가 없는 새 기기(로그인만 된 기기)에서는 쪽지 화면이 잠겨 있고, 틀린 비밀번호로는 안 열리며, 맞는 비밀번호로 열면 옛 쪽지가 읽힌다
//  - 비밀번호를 바꿔도 옛 쪽지가 계속 읽힌다 (새 비밀번호로 새 기기를 열 수 있다)
//  - 로그아웃하면 이 기기의 키가 지워진다
// 실행: node tools/e2ee-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { AUTH_ENV, signup, loginJs } = require('./_auth');
const { safetyNumber } = require('./_e2e');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 6000 + Math.floor(Math.random() * 90), CDP_PORT = 9200 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `e2ee-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...AUTH_ENV, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  try {
    await wait(2500);
    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); if (m.method === 'Runtime.exceptionThrown') console.log('  페이지 예외:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
    async function page() { // 기기 하나 = 따로 저장소를 쓰는 브라우저 문맥 하나
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      const p = { js, call };
      p.rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      p.tap = async (sel) => {
        await js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`); await wait(100);
        const r = await p.rect(sel); if (!r) throw new Error('없음: ' + sel);
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await wait(150);
      };
      p.type = async (sel, text) => { await p.tap(sel); await call('Input.insertText', { text }); await wait(100); };
      p.shot = async (name) => { if (!process.env.SHOTS) return; fs.mkdirSync(process.env.SHOTS, { recursive: true }); const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
      p.until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await wait(200); } return false; };
      p.open = async () => { await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/?step=profile` }); await wait(1200); };
      p.enter = async (name) => { await js(`(() => { document.querySelector('#nameIn').value = ${JSON.stringify(name)}; document.querySelector('#joinForm').requestSubmit(); })()`); await p.until(`joined`); await wait(500); };
      return p;
    }
    const MSG = '비밀 쪽지 내용 가나다 12345';

    console.log('보내고 받기');
    const a = await signup(PORT, '에이이'), b = await signup(PORT, '비이이');
    const A1 = await page(), B1 = await page();
    await A1.open(); await A1.js(loginJs(a)); await A1.enter('에이이');
    await B1.open(); await B1.js(loginJs(b)); await B1.enter('비이이');
    check(await A1.js(`!!e2eeKey && dmKid === e2eeKey.kid && !dmLocked()`), '로그인한 기기에는 쪽지 키가 열려 있음');
    const bUid = await A1.js(`users.find((u) => u.name === '비이이')?.uid`);
    await A1.js(`openDm(${JSON.stringify(bUid)})`); await wait(500);
    await A1.type('#dmIn', MSG); await A1.tap('#dmForm button[type=submit]');
    check(await A1.until(`[...document.querySelectorAll('#dmMsgs .bubble p')].some((p) => p.textContent === ${JSON.stringify(MSG)})`), '보낸 사람 화면에 내용이 보임');
    check(await B1.until(`dmUnread() === 1`), '받는 사람에게 안 읽음 1이 뜸');
    check(await B1.until(`(dmPeers.values().next().value?.last?.text) === ${JSON.stringify(MSG)}`), '받는 사람 쪽지 목록 미리보기가 이 기기에서 풀려 보임');
    await wait(800);
    check(!fs.readFileSync(state, 'utf8').includes('가나다'), '서버 저장 파일에는 내용이 평문으로 없음');

    console.log('새 기기: 잠김과 열기');
    const A2 = await page(); // 같은 로그인, 이 기기에는 쪽지 키가 없다
    await A2.open(); await A2.js(`localStorage.setItem('tok', ${JSON.stringify(a.token)}); localStorage.setItem('acctName', '에이이'); authUi();`);
    await A2.enter('에이이'); await A2.js(`showTab('dm')`); await wait(500);
    check(await A2.js(`dmLocked() && !document.querySelector('#dmLock').hidden && document.querySelector('#dmListWrap').hidden`), '키가 없는 기기의 쪽지 화면은 잠겨 있고 비밀번호를 물음');
    await A2.shot('lock-desktop');
    await A2.type('#dmLockPw', '틀린-비밀번호-1'); await A2.tap('#dmLockGo'); await wait(1500);
    check(await A2.js(`dmLocked() && document.querySelector('#dmLockMsg').textContent.length > 0`), '틀린 비밀번호로는 열리지 않고 이유를 알려 줌');
    await A2.shot('lock-wrong');
    await A2.js(`document.querySelector('#dmLockPw').value = ''`);
    await A2.type('#dmLockPw', a.password); await A2.tap('#dmLockGo');
    check(await A2.until(`!dmLocked() && document.querySelector('#dmLock').hidden && !document.querySelector('#dmListWrap').hidden`), '맞는 비밀번호로 열면 쪽지 목록이 나옴');
    check(await A2.until(`(dmPeers.values().next().value?.last?.text) === ${JSON.stringify(MSG)}`), '새 기기에서도 옛 쪽지 미리보기가 풀림');
    await A2.js(`openDm(${JSON.stringify(bUid)})`);
    check(await A2.until(`[...document.querySelectorAll('#dmMsgs .bubble p')].some((p) => p.textContent === ${JSON.stringify(MSG)})`), '대화를 열면 옛 쪽지 내용이 보임');

    console.log('비밀번호 바꾸기');
    const NEWPW = 'brand-new-pass-77';
    await A1.tap('#settingsBtn'); await A1.js("setPage('acct')"); await wait(300);
    await A1.js(`[...document.querySelectorAll('details.sub > summary')].find((s) => s.textContent.includes('비밀번호')).click()`); await wait(200);
    await A1.type('#pwOld', a.password); await A1.type('#pwNew', NEWPW); await A1.type('#pwNew2', NEWPW); await A1.tap('#pwGo');
    check(await A1.until(`document.querySelector('#pwMsg').classList.contains('ok')`), '설정에서 비밀번호를 바꿈');
    const A3 = await page(); // 새 비밀번호로 처음 로그인하는 기기
    await A3.open();
    const lr = await A3.js(`(async () => { const r = await authPost('/auth/login', { name: '에이이', password: ${JSON.stringify(NEWPW)} }); if (!r.ok) return 'login ' + r.error; set('acctName', r.name); return (await e2eeAfterAuth(${JSON.stringify(NEWPW)}, r.keys)) ? 'ok' : 'keys'; })()`);
    check(lr === 'ok', '새 비밀번호로 로그인하면 감싼 키가 풀림 (' + lr + ')');
    await A3.enter('에이이'); await A3.js(`showTab('dm')`);
    check(await A3.until(`!dmLocked() && (dmPeers.values().next().value?.last?.text) === ${JSON.stringify(MSG)}`), '비밀번호를 바꾼 뒤에도 옛 쪽지가 읽힘');

    console.log('암호화 확인 (안전번호·서버가 보관하는 모습·키 바뀜 경고)');
    const aUid = await B1.js(`users.find((u) => u.name === '에이이')?.uid`);
    await A1.js('closeSettings()'); await wait(200); // (앞에서 비밀번호를 바꾸느라 열어 둔 설정 창)
    await A1.js(`openDm(${JSON.stringify(bUid)})`); await B1.js(`openDm(${JSON.stringify(aUid)})`); await wait(1000);
    check(await A1.js(`document.querySelector('#dmEncTxt').textContent === '암호화됨'`), '대화창 머리에 "암호화됨" 표시가 있음');
    await A1.tap('#dmEnc'); await B1.tap('#dmEnc'); await wait(600);
    const num = (p) => p.js(`[...document.querySelectorAll('#encNum span')].map((s) => s.textContent).join(' ')`);
    const nA = await num(A1), nB = await num(B1);
    check(/^[0-9]{4}( [0-9]{4}){5}$/.test(nA) && nA === nB, '두 사람 화면의 안전번호가 같음 (' + nA + ' / ' + nB + ')');
    const keys = await A1.js(`JSON.stringify([meUid, e2eeCur.get(meUid).pub, ${JSON.stringify(bUid)}, e2eeCur.get(${JSON.stringify(bUid)}).pub])`);
    check(safetyNumber(...JSON.parse(keys)).join(' ') === nA, '안전번호가 두 공개 키로 따로 계산한 값과 같음 (화면이 아무 숫자나 보여 주는 게 아님)');
    const ct = await A1.js(`document.querySelector('#encCt').textContent`), stored = await A1.js(`dmThreads.get(${JSON.stringify(bUid)}).at(-1).enc.ct`);
    check(ct.length > 20 && stored.startsWith(ct.replace('…', '')) && !ct.includes('가나다') && (await A1.js(`document.querySelector('#encPt').textContent`)) === MSG, '"서버에 저장된 것"은 알아볼 수 없는 암호문(서버가 준 값 그대로)이고, "내 기기에서 푼 것"은 쪽지 내용');
    await A1.shot('enc-dialog');
    await A1.tap('#encOk');
    check(await A1.js(`document.querySelector('#encState').textContent.includes('확인했어요') && document.querySelector('#dmEncTxt').textContent === '확인됨'`), '"번호가 같아요"를 누르면 확인됨으로 바뀜');
    await A1.js(`document.querySelector('#encClose').click()`); await wait(200);
    // 상대의 키가 바뀐 경우 (새 기기·비밀번호 초기화): 경고와 확인 해제
    check(await B1.js(`(async () => { const n = await e2eeNewPair('임시-키교체-12345'); const r = await authPost('/auth/keys', { pub: n.pub, wrapped: n.wrapped }); return !!r.ok; })()`), '(준비) 상대가 새 보안 키를 맡김');
    await A1.js(`dmBack?.click?.(); document.querySelector('#dmBack').click()`); await wait(300);
    await A1.js(`openDm(${JSON.stringify(bUid)})`); await wait(1200);
    check(await A1.js(`!document.querySelector('#dmKeyWarn').hidden && document.querySelector('#dmEncTxt').textContent === '암호화됨'`), '상대의 키가 바뀌면 경고가 뜨고 "확인됨"이 풀림');
    await A1.shot('enc-warn');
    await A1.tap('#dmKeyWarnGo'); await wait(500);
    const nA2 = await num(A1);
    check(/^[0-9]{4}( [0-9]{4}){5}$/.test(nA2) && nA2 !== nA, '안전번호가 새 키에 맞게 바뀜 (' + nA + ' → ' + nA2 + ')');
    await A1.js(`document.querySelector('#encClose').click()`); await wait(200);
    await A1.tap('#dmKeyAccept');
    check(await A1.js(`document.querySelector('#dmKeyWarn').hidden`), '"알겠어요"를 누르면 경고가 사라짐');

    console.log('로그아웃');
    await A3.tap('#settingsBtn'); await A3.js("setPage('acct')"); await wait(300); await A3.tap('#logoutBtn'); await wait(2500);
    check(await A3.js(`(async () => { await e2eeReady; return e2eeKey === null && !loggedIn(); })()`), '로그아웃하면 이 기기의 쪽지 키가 지워짐');
  } catch (e) { console.log('  실패 예외:', e.stack || e); failed++; }
  finally {
    srv.kill(); try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} await wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(state, { force: true }); } catch {}
  }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})();
