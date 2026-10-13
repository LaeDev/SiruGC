// 로그인·가입·닉네임 바꾸기·로그아웃·계정 삭제와 호스트의 계정 관리를 실제 브라우저로 확인한다 (화면에서 직접 눌러서).
// 실행: node tools/account-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능, SHOTS=폴더 로 화면 사진 저장)
const { AUTH_ENV, signup, loginJs, adminLogin } = require('./_auth');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5900 + Math.floor(Math.random() * 90), CDP_PORT = 9900 + Math.floor(Math.random() * 90);
const SHOTS = process.env.SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
};

(async () => {
  const state = path.join(os.tmpdir(), `dmonly-${Date.now()}.json`);
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
    async function page(w, h, mobile, ua) {
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      if (ua) await call('Emulation.setUserAgentOverride', { userAgent: ua });
      await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      const p = { js, call };
      p.rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; })()`);
      p.tap = async (sel) => { // 실제로 그 자리를 누른다 (요소를 코드로 clic() 하지 않는다)
        await js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`); await wait(100);
        const r = await p.rect(sel); if (!r) throw new Error('없음: ' + sel);
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await wait(150);
      };
      p.login = async (name) => { await js(loginJs(await signup(PORT, name))); }; // 이 화면을 그 닉네임으로 로그인한 상태로 만든다
      p.type = async (sel, text) => { await p.tap(sel); await call('Input.insertText', { text }); await wait(100); };
      p.shot = async (name) => { if (!SHOTS) return; const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
      p.until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await wait(200); } return false; };
      await call('Page.navigate', { url: `http://127.0.0.1:${PORT}` }); await wait(1200);
      return p;
    }
    const noOverflow = `document.documentElement.scrollWidth <= innerWidth`;

    console.log('입장 화면: 게스트 (폰 390px)');
    const G = await page(390, 844, true);
    check(await G.until("authInfo && authInfo.allowed"), '로그인이 허용된 주소로 알려짐');
    check(await G.js("[...document.querySelectorAll('#acctBox button')].map((b) => b.textContent).join() === '로그인,가입하기'"), '입장 화면에 "로그인"과 "가입하기"가 보임');
    check(await G.js("document.documentElement.scrollWidth <= innerWidth"), '폰 화면에서 가로로 넘치지 않음');
    check(await G.js("(() => { const e = document.querySelector('#enter').getBoundingClientRect(), n = document.querySelector('#nameIn').getBoundingClientRect(); return e.top > n.top && e.bottom < innerHeight; })()"), '"입장하기"가 닉네임 아래, 첫 화면 안에 보임');
    check(await G.js("!document.querySelector('#makeWrap').open"), '폰에서는 "프로필 꾸미기"가 접혀 있음');
    await G.shot('1-join-phone-guest');
    await G.tap('#makeWrap > summary'); await wait(200);
    check(await G.js("document.querySelector('#makeWrap').open && document.querySelectorAll('#emojis button').length > 20"), '눌러서 펼치면 이모티콘과 색 고르기가 보임');
    await G.tap('#makeWrap > summary');

    console.log('가입 (화면에서 직접)');
    await G.tap('#acctBox .row button:nth-of-type(2)');
    check(await G.js("document.querySelector('#authDlg').open && document.querySelector('#authTabSignup').getAttribute('aria-selected') === 'true' && !document.querySelector('#authCodeRow').hidden"), '가입하기를 누르면 가입 창이 열리고 가입 코드 칸이 있음');
    check(await G.js("(() => { const d = document.querySelector('#authDlg').getBoundingClientRect(); return d.left >= 0 && d.right <= innerWidth && d.bottom <= innerHeight + 1; })()"), '가입 창이 폰 화면 안에 들어옴');
    await G.shot('2-signup-dialog-phone');
    await G.type('#authName', '화면가입자'); await G.type('#authPw', 'short'); await G.type('#authPw2', 'short'); await G.type('#authCode', 'tool-code');
    await G.tap('#authGo'); await wait(700);
    check(await G.js("document.querySelector('#authMsg').textContent.includes('8자')"), '너무 짧은 비밀번호는 이유와 함께 안내됨');
    await G.js("document.querySelector('#authPw').value = ''; document.querySelector('#authPw2').value = ''");
    await G.type('#authPw', 'screen-pass-12'); await G.type('#authPw2', 'screen-pass-99'); await G.tap('#authGo'); await wait(300);
    check(await G.js("document.querySelector('#authMsg').textContent.includes('서로 달라요')"), '비밀번호 두 칸이 다르면 안내됨');
    await G.js("document.querySelector('#authPw2').value = ''"); await G.type('#authPw2', 'screen-pass-12');
    await G.js("document.querySelector('#authCode').value = 'wrong'"); await G.tap('#authGo'); await wait(700);
    check(await G.js("document.querySelector('#authMsg').textContent.includes('가입 코드')"), '가입 코드가 틀리면 안내됨');
    await G.js("document.querySelector('#authCode').value = 'tool-code'"); await G.tap('#authGo'); await wait(1500);
    check(await G.js("!document.querySelector('#authDlg').open && loggedIn() && get('acctName') === '화면가입자'"), '가입하면 창이 닫히고 로그인된 상태가 됨');
    check(await G.js("document.querySelector('#nameIn').readOnly && document.querySelector('#nameIn').value === '화면가입자' && document.querySelector('#acctBox').textContent.includes('로그인했어요')"), '입장 화면의 닉네임이 계정 이름으로 고정됨');
    await G.shot('3-join-phone-loggedin');

    console.log('계정으로 입장, 게스트 화면과 비교');
    await G.tap('#enter'); await wait(1800);
    check(await G.js("joined && !!meUid && document.querySelector('#dmGuest').hidden && users.find((u) => u.id === me).acct === true"), '로그인한 사람은 계정으로 입장하고 쪽지함이 열려 있음');
    await G.js("window.confirm = () => true");
    await G.tap('#tab-chat'); await G.type('#chatIn', '이름이 바뀌어도 맞춰져야 하는 말'); await G.js("document.querySelector('#chatForm').requestSubmit()"); await wait(500);
    const H = await page(1280, 860, false); await H.type('#nameIn', '게스트손님'); await H.tap('#enter'); await wait(1800);
    check(await H.js("[...document.querySelectorAll('#users .urow')].some((r) => r.textContent.includes('화면가입자') && r.textContent.includes('계정'))"), '게스트 화면의 참가자 목록에서 로그인한 사람에게 "계정" 표시가 보임');
    await H.tap('#tab-dm');
    check(await H.js("!document.querySelector('#dmGuest').hidden && document.querySelector('#dmListWrap').hidden"), '게스트의 쪽지 탭에는 "로그인한 사람끼리만" 안내가 있음');
    await H.tap('#dmLogin');
    check(await H.js("document.querySelector('#authDlg').open && document.querySelector('#authNote').textContent.includes('쪽지는 로그인')"), '안내의 버튼으로 로그인 창이 열림');
    await H.js("document.querySelector('#authClose').click()"); await wait(200);
    await H.tap('#tab-users'); await H.tap('.urow[data-uid]'); await wait(300);
    check(await H.js("![...document.querySelectorAll('.acts .btn')].some((b) => b.textContent === '쪽지 보내기') && [...document.querySelectorAll('.acts small')].some((s) => s.textContent.includes('로그인하면'))"), '게스트에게는 "쪽지 보내기" 대신 로그인하면 보낼 수 있다는 안내가 보임');

    console.log('닉네임 바꾸기 (설정 → 계정)');
    await G.tap('#settingsBtn'); await wait(400);
    check(await G.js("!document.querySelector('#acctIn').hidden && document.querySelector('#acctInfo').textContent.includes('화면가입자')"), '설정에 계정 정보가 보임');
    await G.type('#renIn', '화면새이름'); await G.tap('#renGo'); await wait(900);
    check(await G.js("document.querySelector('#renMsg').textContent.includes('화면새이름') && get('acctName') === '화면새이름'"), '닉네임이 바뀌고 안내가 뜸');
    check(await G.js("[...document.querySelectorAll('#chat .m[data-sid] .bubble header b')].every((b) => b.textContent === '화면새이름')"), '화면에 남은 내 말풍선의 이름도 새 닉네임으로 바뀜');
    check(await H.until("users.some((u) => u.name === '화면새이름' && u.prev === '화면가입자')"), '다른 사람 화면에서도 새 이름과 이전 닉네임이 맞춰짐');
    check(await H.js("[...document.querySelectorAll('#users .urow')].some((r) => r.textContent.includes('화면새이름') && r.textContent.includes('이전: 화면가입자'))"), '참가자 목록에 "이전: 화면가입자"가 보임');
    await H.shot('4-users-prev-desktop');
    await G.type('#renIn', '또바꿈'); await G.tap('#renGo'); await wait(700);
    check(await G.js("document.querySelector('#renMsg').textContent.includes('7일')"), '7일 안에 다시 바꾸면 안내됨');
    await G.js("[...document.querySelectorAll('details.sub > summary')].find((s) => s.textContent.includes('비밀번호')).click()"); await wait(200);
    await G.type('#pwOld', 'not-the-password-1'); await G.type('#pwNew', 'screen-pass-new-1'); await G.type('#pwNew2', 'screen-pass-new-1'); await G.tap('#pwGo'); await wait(700);
    check(await G.js("document.querySelector('#pwMsg').textContent.includes('맞지 않아요')"), '현재 비밀번호가 틀리면 비밀번호를 바꿀 수 없고 안내됨');
    check(await G.js("document.querySelector('#acctIn').scrollWidth <= document.querySelector('#acctIn').clientWidth && document.querySelector('.dlg-b').scrollWidth <= document.querySelector('.dlg-b').clientWidth"), '폰 설정 창의 계정 칸이 가로로 넘치지 않음');
    await G.js("document.querySelector('#acctIn').scrollIntoView()"); await G.shot('5-settings-account-phone');

    console.log('계정 관리 (관리자만)');
    check(await G.js("document.querySelector('#adminSec').hidden"), '호스트의 설정 창에는 "계정 관리"가 보이지 않음 (호스트는 게스트일 수도 있어서 계정 관리는 관리자만)');
    await G.js("document.querySelector('#setClose').click()"); await wait(200);
    const extra = await signup(PORT, '관리대상계정');
    const AD = await page(1280, 860, false); await AD.js(loginJs(await adminLogin(PORT))); await AD.tap('#enter'); await wait(1800);
    check(await AD.js("joined && isAdmin && !isHost === false && !users.find((u) => u.id === me).host"), '관리자로 입장함 (호스트는 아님)');
    await AD.js("window.confirm = () => true");
    await AD.tap('#settingsBtn'); await wait(400);
    check(await AD.until("!document.querySelector('#adminSec').hidden && document.querySelectorAll('#acctList li').length >= 3"), '관리자의 설정 창에는 계정 목록(관리자와 가입한 사람들)이 보임');
    check(await AD.js("[...document.querySelectorAll('#acctList li')].find((l) => l.textContent.includes('관리자')).querySelectorAll('button').length === 0"), '관리자 계정에는 초기화·밴·삭제 버튼이 없음');
    await AD.js("[...document.querySelectorAll('#acctList li')].find((l) => l.textContent.includes('관리대상계정')).querySelector('button').click()"); await wait(900);
    check(await AD.js("/임시 비밀번호: [A-Za-z0-9]{10}/.test(document.querySelector('#acctMsg').textContent)"), '임시 비밀번호가 관리자 화면에 한 번 보임');
    await AD.js("document.querySelector('#adminSec').scrollIntoView()"); await AD.shot('6-admin-list-desktop');

    console.log('로그아웃과 다시 로그인');
    await G.tap('#settingsBtn'); await G.tap('#logoutBtn');
    check(await G.until("document.readyState === 'complete' && !loggedIn()", 10000), '로그아웃하면 화면이 새로 열리고 로그인 상태가 풀림');
    await wait(1500);
    check(await G.js("!loggedIn() && !document.querySelector('#nameIn').readOnly && !document.querySelector('#join').hidden"), '입장 화면이 게스트 상태로 돌아감');
    check(await H.until("!users.some((u) => u.name === '화면새이름')"), '다른 사람 화면에서는 그 사람이 나간 것으로 보임');
    await G.tap('#acctBox .row button:nth-of-type(1)');
    await G.type('#authName', '화면새이름'); await G.type('#authPw', 'wrong-wrong-1'); await G.tap('#authGo'); await wait(800);
    check(await G.js("document.querySelector('#authMsg').textContent.includes('맞지 않아요') && !loggedIn()"), '비밀번호가 틀리면 안내되고 로그인되지 않음');
    await G.js("document.querySelector('#authPw').value = ''"); await G.type('#authPw', 'screen-pass-12'); await G.tap('#authGo'); await wait(1500);
    check(await G.js("loggedIn() && get('acctName') === '화면새이름' && document.querySelector('#nameIn').value === '화면새이름'"), '맞는 비밀번호로 다시 로그인됨 (바꾼 닉네임으로)');

    console.log('계정 삭제');
    await G.tap('#joinSettings'); await wait(300);
    await G.js("[...document.querySelectorAll('details.sub > summary')].find((s) => s.textContent.includes('계정 삭제')).click(); window.confirm = () => true"); await wait(200);
    await G.type('#delPw', 'screen-pass-12'); await G.tap('#delGo');
    check(await G.until("document.readyState === 'complete' && !loggedIn()", 10000), '계정을 삭제하면 로그인이 풀리고 화면이 새로 열림');
    await wait(1200);
    check((await (await fetch(`http://localhost:${PORT}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '화면새이름', password: 'screen-pass-12' }) })).json()).error === 'bad', '삭제한 계정으로는 로그인되지 않음');
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
