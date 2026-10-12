// 대기열 순서 바꾸기(위로/아래로 버튼, 끌어서 옮기기)를 실제 브라우저 두 창으로 확인한다.
//  호스트는 모두의 항목을, 일반 참가자는 자기 항목만 옮길 수 있고, 바뀐 순서는 모두에게 바로 보인다. 마우스와 폰 터치로 끌기 모두.
// 실행: node tools/queue-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능. 유튜브 제목을 가져오려고 인터넷이 필요)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5500 + Math.floor(Math.random() * 90), CDP_PORT = 9050 + Math.floor(Math.random() * 40);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));
const VIDS = ['dQw4w9WgXcQ', 'jNQXAC9IVRw', 'aqz-KE-bpKQ', '9bZkp7q19f0', 'kJQP7kiw5Fk'];

(async () => {
  const state = path.join(os.tmpdir(), `q-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
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
    async function page(name) {
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log(`[${name}] JS 오류:`, r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      await call('Page.navigate', { url: `http://localhost:${PORT}` }); await wait(1200);
      await js(`(() => { document.querySelector('#nameIn').value = '${name}'; document.querySelector('#joinForm').requestSubmit(); })()`); await wait(1000);
      await js(`document.querySelector('#tab-queue').click()`);
      return { js, call };
    }
    const until = async (p, expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await p.js(expr)) return true; await wait(200); } return false; };
    const A = await page('호스트'), B = await page('손님');
    const order = (p) => p.js(`[...document.querySelectorAll('#qList li')].map((li) => li.dataset.qid).join(',')`);
    const titles = (p) => p.js(`[...document.querySelectorAll('#qList li b')].map((b) => b.textContent).join('|')`);

    // 영상 5개를 올린다: 첫 번째는 바로 재생되고 나머지 4개가 줄을 선다 (호스트 3개 + 손님 1개)
    for (const v of VIDS.slice(0, 4)) { await A.js(`send({ t: 'queue-add', videoId: '${v}' })`); await wait(1300); }
    await B.js(`send({ t: 'queue-add', videoId: '${VIDS[4]}' })`);
    check(await until(A, `document.querySelectorAll('#qList li').length === 4`) && await until(B, `document.querySelectorAll('#qList li').length === 4`), '호스트가 3개, 손님이 1개 올려서 대기열이 4개 (양쪽 화면)');
    const q0 = await order(A);
    check(q0 === await order(B), '두 화면의 순서가 같음');

    console.log('버튼으로 옮기기');
    const ids = q0.split(',');
    check(await A.js(`document.querySelector('#qList li:first-child [aria-label="위로 옮기기"]').disabled && document.querySelector('#qList li:last-child [aria-label="아래로 옮기기"]').disabled`), '맨 위는 "위로", 맨 아래는 "아래로"가 비활성');
    await A.js(`document.querySelector('#qList li:nth-child(3) [aria-label="위로 옮기기"]').click()`);
    check(await until(A, `[...document.querySelectorAll('#qList li')].map((l) => l.dataset.qid).join() === '${[ids[0], ids[2], ids[1], ids[3]].join()}'`) , '3번째에서 "위로"를 누르면 2번째로 올라감');
    check(await until(B, `[...document.querySelectorAll('#qList li')].map((l) => l.dataset.qid).join() === '${[ids[0], ids[2], ids[1], ids[3]].join()}'`), '손님 화면에도 바로 같은 순서로 바뀜 (새로고침 없이)');
    await A.js(`document.querySelector('#qList li:first-child [aria-label="아래로 옮기기"]').click()`);
    check(await until(A, `[...document.querySelectorAll('#qList li')].map((l) => l.dataset.qid).join() === '${[ids[2], ids[0], ids[1], ids[3]].join()}'`), '맨 위에서 "아래로"를 누르면 2번째로 내려감');

    console.log('권한: 손님은 자기가 올린 항목만');
    const g = await B.js(`(() => { const lis = [...document.querySelectorAll('#qList li')]; return { total: lis.length, withBtns: lis.filter((l) => l.querySelector('.qbtns')).length, mineIsLast: !!lis[lis.length - 1].querySelector('.qbtns') }; })()`);
    check(g.total === 4 && g.withBtns === 1, `손님 화면에는 자기 항목에만 조작 버튼이 있음 (${g.withBtns}개 / ${g.total}개)`);
    check(await B.js(`!document.querySelector('#qList .grip') || document.querySelectorAll('#qList .grip').length === 1`), '손님에게 끌기 손잡이도 자기 항목 하나뿐');
    const mine = await B.js(`document.querySelector('#qList .qbtns').closest('li').dataset.qid`); // 손님 화면에서 조작 버튼이 있는 항목 = 자기 것
    await B.js(`document.querySelector('#qList .qbtns [aria-label="위로 옮기기"]').click()`);
    check(await until(A, `[...document.querySelectorAll('#qList li')].map((l) => l.dataset.qid).join().includes('${mine}') && document.querySelectorAll('#qList li')[2].dataset.qid === '${mine}'`), '손님이 자기 항목을 올리면 호스트 화면에도 반영됨');

    console.log('끌어서 옮기기 (마우스)');
    const before = await order(A);
    const pts = await A.js(`(() => { const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }; const lis = [...document.querySelectorAll('#qList li')]; return { grip: r(lis[0].querySelector('.grip')), last: r(lis[3]) }; })()`);
    const mouse = (type, x, y) => A.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' });
    await mouse('mousePressed', pts.grip.x, pts.grip.y);
    for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', pts.grip.x, pts.grip.y + ((pts.last.y - pts.grip.y + 20) * i) / 8); await wait(30); }
    check(await A.js(`!!document.querySelector('#qList li.dragging')`), '끄는 동안 항목이 따라 움직이는 표시(dragging)가 있음');
    await mouse('mouseReleased', pts.grip.x, pts.last.y + 20);
    const ids2 = before.split(',');
    check(await until(A, `[...document.querySelectorAll('#qList li')].map((l) => l.dataset.qid).join() === '${[ids2[1], ids2[2], ids2[3], ids2[0]].join()}'`, 5000), '맨 위 항목을 맨 아래로 끌어다 놓으면 그 자리로 감');
    check(await until(B, `[...document.querySelectorAll('#qList li')].map((l) => l.dataset.qid).join() === '${[ids2[1], ids2[2], ids2[3], ids2[0]].join()}'`, 5000), '끌어서 옮긴 순서가 손님 화면에도 바로 반영됨');
    check(await A.js(`[...document.querySelectorAll('#qList li')].every((l) => !l.style.transform && !l.classList.contains('dragging'))`), '놓은 뒤 항목들이 제자리로 정리됨');

    console.log('끌어서 옮기기 (폰 터치)');
    await A.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await A.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); await wait(500);
    const t0 = await order(A);
    const tp = await A.js(`(() => { const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }; const lis = [...document.querySelectorAll('#qList li')]; lis[3].scrollIntoView({ block: 'nearest' }); return { grip: r(lis[3].querySelector('.grip')), first: r(lis[0]) }; })()`);
    const touch = (type, x, y) => A.call('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await touch('touchStart', tp.grip.x, tp.grip.y);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', tp.grip.x, tp.grip.y + ((tp.first.y - tp.grip.y - 20) * i) / 8); await wait(30); }
    await touch('touchEnd');
    const ids3 = t0.split(',');
    check(await until(A, `[...document.querySelectorAll('#qList li')].map((l) => l.dataset.qid).join() === '${[ids3[3], ids3[0], ids3[1], ids3[2]].join()}'`, 5000), '폰에서 손가락으로 맨 아래 항목을 맨 위로 끌어올림');
    const ov = await A.js(`document.documentElement.scrollWidth - innerWidth`);
    check(ov <= 0, `폰에서 대기열이 가로로 넘치지 않음 (${ov}px)`);
    const small = await A.js(`[...document.querySelectorAll('#qList .qbtns .btn')].filter((b) => b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 44).length`);
    check(small === 0, '폰에서 모든 조작 버튼이 터치 크기(44px) 이상');
    browser.close();
  } finally { chrome.kill(); srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
