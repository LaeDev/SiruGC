// 쪽지 완성 기능을 실제 브라우저 세 창으로 확인한다.
//  새 쪽지(접속 안 한 사람도 고르기·검색), 읽음/전송됨 표시, 내 쪽지 삭제(상대 화면에서도 사라짐), 대화 정리(내 화면만), 차단/해제, 날짜 구분선, 폰 화면 맞춤
// 실행: node tools/dm-full-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { AUTH_ENV, signup, loginJs } = require('./_auth');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5400 + Math.floor(Math.random() * 90), CDP_PORT = 9500 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `dmfull-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...AUTH_ENV, PORT, STATE_FILE: state, RESUME_GRACE_MS: '1500', CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  try {
    await wait(2500);
    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
    async function page(name, size = { w: 1000, h: 760 }) {
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: size.mobile ? 2 : 1, mobile: !!size.mobile });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log(`[${name}] JS 오류:`, r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      await call('Page.navigate', { url: `http://localhost:${PORT}/?step=profile` }); await wait(1200);
      await js(loginJs(await signup(PORT, name))); await js(`(() => { document.querySelector('#nameIn').value = '${name}'; document.querySelector('#joinForm').requestSubmit(); window.confirm = () => true; })()`); await wait(1000);
      return { js, call, name, targetId };
    }
    const until = async (p, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await p.js(expr)) return true; await wait(200); } return false; };
    const sendDm = (p, text) => p.js(`(() => { document.querySelector('#dmIn').value = ${JSON.stringify(text)}; document.querySelector('#dmForm').requestSubmit(); })()`);
    const bubbles = (p) => p.js(`document.querySelectorAll('#dmMsgs .bubble').length`);

    const A = await page('에이'), B = await page('비이');
    const C = await page('씨이'); await raw('Target.closeTarget', { targetId: C.targetId }); await wait(3500); // 씨이는 들어왔다가 탭을 닫음 (접속 안 한 사람)

    console.log('새 쪽지: 상대 고르기');
    await A.js(`document.querySelector('#tab-dm').click()`); await wait(300);
    check(await A.js(`!document.querySelector('#dmEmpty').hidden`), '쪽지가 없으면 안내가 보임');
    await A.js(`document.querySelector('#dmNew').click()`); await wait(600);
    check(await A.js(`!document.querySelector('#dmPicker').hidden && document.querySelector('#dmListWrap').hidden`), '"새 쪽지"를 누르면 상대 고르기 화면이 열림');
    check(await until(A, `[...document.querySelectorAll('#pkList .conv')].length === 2`), '나를 뺀 모든 회원이 보임 (접속 중 + 접속 안 함)');
    console.log('   방 참가자:', await A.js(`users.map((u) => u.name).join(',')`));
    console.log('   표시 내용:', await A.js(`[...document.querySelectorAll('#pkList .conv')].map((b) => b.textContent).join(' | ')`));
    check(await A.js(`(() => { const t = [...document.querySelectorAll('#pkList .conv')].map((b) => b.textContent); return t.some((x) => x.includes('비이') && x.includes('접속 중')) && t.some((x) => x.includes('씨이') && x.includes('접속 안 함')); })()`), '접속 상태가 글자로 구분됨');
    await A.js(`(() => { const i = document.querySelector('#pkSearch'); i.value = '씨'; i.dispatchEvent(new Event('input')); })()`);
    check(await A.js(`document.querySelectorAll('#pkList .conv').length === 1 && document.querySelector('#pkList .conv b').textContent === '씨이'`), '이름으로 찾으면 걸러짐');
    await A.js(`(() => { const i = document.querySelector('#pkSearch'); i.value = '없는이름'; i.dispatchEvent(new Event('input')); })()`);
    check(await A.js(`!document.querySelector('#pkEmpty').hidden`), '찾는 사람이 없으면 안내가 보임');
    await A.js(`(() => { const i = document.querySelector('#pkSearch'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
    await A.js(`document.querySelector('#pkBack').click()`); await wait(200);
    check(await A.js(`!document.querySelector('#dmListWrap').hidden && document.querySelector('#dmPicker').hidden`), '뒤로 가면 목록으로 돌아옴');

    console.log('접속 안 한 사람에게도 보내기');
    await A.js(`document.querySelector('#dmNew').click()`); await wait(400);
    await A.js(`[...document.querySelectorAll('#pkList .conv')].find((b) => b.textContent.includes('씨이')).click()`); await wait(400);
    check(await A.js(`!document.querySelector('#dmThread').hidden && document.querySelector('#dmWho').textContent.includes('씨이')`), '접속 안 한 사람도 골라서 대화창이 열림');
    await sendDm(A, '자리에 없을 때 남겨요');
    check(await until(A, `document.querySelectorAll('#dmMsgs .bubble').length === 1`), '접속 안 한 사람에게 보낸 쪽지가 대화창에 보임');
    await A.js(`document.querySelector('#dmBack').click()`);

    console.log('읽음 표시');
    await A.js(`document.querySelector('#dmNew').click()`); await wait(300);
    await A.js(`[...document.querySelectorAll('#pkList .conv')].find((b) => b.textContent.includes('비이')).click()`); await wait(400);
    await sendDm(A, '첫 번째');
    await sendDm(A, '두 번째');
    check(await until(A, `document.querySelectorAll('#dmMsgs .bubble').length === 2`), '쪽지 두 개가 보임');
    check(await until(A, `document.querySelector('#dmMsgs .rcpt')?.textContent === '전송됨'`), '상대가 아직 안 읽었으면 "전송됨"');
    check(await A.js(`document.querySelectorAll('#dmMsgs .rcpt').length === 1`), '표시는 내 마지막 쪽지 아래에 하나만');
    await B.js(`document.querySelector('#tab-dm').click()`); await wait(300);
    check(await until(B, `document.querySelector('#dot-dm').textContent === '2'`), '받는 사람에게 안 읽음 2');
    await B.js(`document.querySelector('#dmList .conv').click()`); await wait(500);
    check(await until(A, `document.querySelector('#dmMsgs .rcpt')?.textContent === '읽음'`), '상대가 열어 보면 내 화면이 "읽음"으로 바뀜');

    console.log('내 쪽지 삭제');
    check(await B.js(`!document.querySelector('#dmMsgs .m:not(.mine) .mact')`), '남이 보낸 쪽지에는 삭제 메뉴가 없음');
    await A.js(`document.querySelectorAll('#dmMsgs .m.mine .bubble')[1].querySelector('p').click()`); await wait(200);
    check(await A.js(`!document.querySelectorAll('#dmMsgs .m.mine .mact')[1].hidden`), '내 쪽지를 누르면 삭제 버튼이 나타남');
    await A.js(`document.querySelectorAll('#dmMsgs .m.mine .mact button')[1].click()`);
    check(await until(A, `document.querySelectorAll('#dmMsgs .bubble').length === 1`), '삭제하면 내 화면에서 사라짐');
    check(await until(B, `document.querySelectorAll('#dmMsgs .bubble').length === 1`), '상대 화면에서도 사라짐');
    check(await until(B, `document.querySelector('#dmMsgs .bubble p').textContent === '첫 번째'`), '남은 쪽지는 그대로');

    console.log('날짜 구분선');
    check(await A.js(`document.querySelector('#dmMsgs .sys.day')?.textContent === '오늘'`), '대화창에 "오늘" 구분선이 보임');

    console.log('차단 / 해제');
    await B.js(`document.querySelector('#dmBlock').click()`);
    check(await until(B, `!document.querySelector('#dmBlockedNote').hidden && document.querySelector('#dmIn').disabled`), '차단하면 안내가 뜨고 입력창이 잠김');
    await sendDm(A, '차단당한 뒤의 쪽지');
    await wait(700);
    check(await B.js(`document.querySelectorAll('#dmMsgs .bubble').length === 1 && document.querySelector('#dot-dm').hidden`), '차단한 사람의 쪽지는 오지 않음 (알림도 없음)');
    check(await A.js(`!document.querySelector('#dmMsgs .sys.err')`), '차단당한 사람에게는 티가 나지 않음 (오류 없음)');
    await B.js(`document.querySelector('#dmBlock').click()`);
    check(await until(B, `document.querySelector('#dmBlockedNote').hidden && !document.querySelector('#dmIn').disabled`), '다시 누르면 풀림');
    await sendDm(A, '풀린 뒤의 쪽지');
    check(await until(B, `[...document.querySelectorAll('#dmMsgs .bubble p')].some((p) => p.textContent === '풀린 뒤의 쪽지')`), '풀린 뒤에는 쪽지가 다시 옴');
    check(await B.js(`![...document.querySelectorAll('#dmMsgs .bubble p')].some((p) => p.textContent === '차단당한 뒤의 쪽지')`), '차단 중에 보낸 쪽지는 풀려도 나타나지 않음');

    console.log('대화 정리 (내 화면만)');
    await B.js(`document.querySelector('#dmClear').click()`);
    check(await until(B, `document.querySelectorAll('#dmMsgs .bubble').length === 0`), '정리하면 내 대화창이 비워짐');
    await B.js(`document.querySelector('#dmBack').click()`); await wait(300);
    check(await B.js(`!document.querySelector('#dmList .conv')`), '목록에서도 그 대화가 사라짐');
    check(await A.js(`document.querySelectorAll('#dmMsgs .bubble').length >= 2`), '상대 화면에는 그대로 남음');
    await sendDm(A, '정리 뒤의 새 쪽지');
    await until(B, `document.querySelectorAll('#dmList .conv').length === 1`);
    await B.js(`document.querySelector('#dmList .conv').click()`); await wait(500);
    check(await B.js(`[...document.querySelectorAll('#dmMsgs .bubble p')].map((p) => p.textContent).join() === '정리 뒤의 새 쪽지'`), '정리한 뒤에는 새 쪽지만 보임 (지운 건 되살아나지 않음)');

    console.log('폰 화면 맞춤 (390px)');
    const M = await page('폰', { w: 390, h: 844, mobile: true });
    await M.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await M.js(`document.querySelector('#tab-dm').click()`); await wait(300);
    const small = (p, sel) => p.js(`[...document.querySelectorAll('${sel}')].filter((b) => b.getBoundingClientRect().width > 0 && (b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 44)).map((b) => b.id || b.textContent).join()`);
    check(await small(M, '#dmNew') === '', '"새 쪽지" 버튼이 터치 크기(44px) 이상');
    await M.js(`document.querySelector('#dmNew').click()`); await wait(500);
    check(await small(M, '#pkBack, #pkList .conv') === '', '고르기 화면의 버튼이 터치 크기 이상');
    await M.js(`document.querySelector('#pkList .conv').click()`); await wait(500);
    check(await small(M, '#dmBack, #dmClear, #dmBlock') === '', '대화창 머리의 버튼(뒤로·정리·차단)이 터치 크기 이상');
    check(await M.js(`document.documentElement.scrollWidth - innerWidth <= 0`), '폰에서 가로로 넘치지 않음');
    check(await M.js(`(() => { const r = document.querySelector('#dmIn').getBoundingClientRect(); return r.bottom <= innerHeight && r.top > 0; })()`), '폰에서 쪽지 입력창이 화면 안에 보임');
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
