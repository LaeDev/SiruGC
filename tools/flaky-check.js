// 연결이 불안정할 때(소리 없이 죽은 연결, 백그라운드 타이머 지연, 열어 둔 옛 화면)의 복구를 실제 브라우저로 확인한다.
//  - 서버→화면 방향이 막힌 연결(소리 없이 죽음): 깨어날 때 6초 안에, 보낸 신호에 답이 45초 넘게 없을 때 스스로 끊고 같은 세션으로 돌아와야 함
//  - 타이머가 늦게 돈 경우(백그라운드·절전): 멀쩡한 연결을 끊지 않아야 함
//  - 끊긴 사유가 서버 로그에 남아야 함, 잠깐 끊김은 '연결이 끊겼어요' 안내를 띄우지 않아야 함, 서버가 켜져 있으면 '서버가 꺼졌습니다'를 띄우지 않아야 함
// 실행: node tools/flaky-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5700 + Math.floor(Math.random() * 90), CDP_PORT = 9700 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `flaky-${Date.now()}.json`), logf = path.join(os.tmpdir(), `flaky-${Date.now()}.log`);
  const out = fs.openSync(logf, 'w');
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: ['ignore', out, out] });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  const log = () => fs.readFileSync(logf, 'utf8');
  try {
    await wait(2500);
    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
    const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => raw(m, p, sessionId);
    await call('Page.enable'); await call('Runtime.enable');
    const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
    const until = async (fn, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(200); } return false; };
    await call('Page.navigate', { url: `http://localhost:${PORT}` }); await wait(1200);
    await js(`(() => { document.querySelector('#nameIn').value = '불안'; document.querySelector('#joinForm').requestSubmit(); })()`);
    check(await until(() => js(`joined && ws.readyState === 1`)), '입장함');

    console.log('버전 안내');
    check(await js(`BUILD.length >= 6 && !document.querySelector('#upd')`), '정상 접속에서는 "새 버전" 안내가 뜨지 않음 (화면 버전 = 서버 버전)');
    check(await js(`document.querySelector('#verNote').textContent.includes(BUILD)`), '설정에 화면 버전이 보임');
    await js(`offerUpdate()`);
    check(await js(`(() => { const u = document.querySelector('#upd'); const b = u?.querySelector('button'); return !!b && b.textContent === '새로고침' && b.getBoundingClientRect().height >= 44; })()`), '서버가 새 버전을 알리면 새로고침 버튼(44px 이상)이 뜸');
    await js(`document.querySelector('#upd').remove()`);

    console.log('소리 없이 죽은 연결: 깨어날 때');
    const sock1 = await js(`(window.__s1 = ws, 1)`);
    await js(`(() => { const o = ws.onmessage; ws.onmessage = (e) => { if (!window.__hole) o(e); }; window.__hole = true; })()`); // 서버 답이 화면에 안 들어옴 (소켓은 열려 있음)
    await js(`document.dispatchEvent(new Event('visibilitychange'))`);
    check(await until(() => js(`ws !== window.__s1 && joined && ws.readyState === 1 && !reconnecting`), 20000), '6초 안에 죽은 연결을 알아채고 새 연결로 돌아옴');
    check(/code=4001 사유=wake-noreply/.test(log()), '서버 로그에 끊긴 사유가 남음 (code=4001 사유=wake-noreply)');
    check(await js(`users.length === 1 && !document.querySelector('#net:not([hidden])')`), '참가자는 그대로 하나, 짧은 끊김이라 "연결이 끊겼어요" 안내도 남지 않음');
    check(await js(`![...document.querySelectorAll('.sys')].some((x) => x.textContent.includes('나갔어요') || x.textContent.includes('들어왔어요') || x.textContent.includes('오래 끊겨'))`), '채팅에 "나갔어요/들어왔어요/오래 끊겨"가 찍히지 않음 (세션을 이어받음)');
    check(await js(`document.body.textContent.includes('서버가 꺼졌습니다') === false`), '서버가 켜져 있으니 "서버가 꺼졌습니다"는 뜨지 않음');

    console.log('타이머가 늦게 돈 경우(백그라운드·절전)');
    const s2 = await js(`(window.__s2 = ws, 1)`);
    await js(`(() => { const o = ws.onmessage; ws.onmessage = (e) => { if (!window.__hole2) o(e); }; window.__hole2 = true; })()`);
    await js(`hbCheck()`); // 신호를 보냈는데 답이 오지 않음
    await js(`(() => { window.__real = Date.now; const off = 120000; Date.now = () => window.__real() + off; })()`); // 시계가 2분 건너뜀 = 타이머가 한참 멈췄다 돌았음
    await js(`hbCheck()`);
    check(await js(`ws === window.__s2 && !reconnecting`), '타이머가 2분 늦게 돌았을 때는 멀쩡한 연결을 끊지 않음 (예전엔 여기서 끊었음)');
    await js(`Date.now = window.__real; window.__hole2 = false`);

    console.log('보낸 신호에 답이 45초 넘게 없음');
    await js(`window.__hole2 = true; pingAt = Date.now(); lastHeard = pingAt - 1; tickAt = Date.now()`);
    await js(`(() => { const off = 50000; Date.now = () => window.__real() + off; tickAt = Date.now() - 15000; })()`); // 타이머는 제때 돌았고 신호만 50초째 답이 없음
    await js(`hbCheck()`);
    await js(`Date.now = window.__real`);
    check(await until(() => js(`ws !== window.__s2 && joined && ws.readyState === 1 && !reconnecting`), 20000), '답이 45초 넘게 없으면 끊고 같은 세션으로 돌아옴');
    check(/사유=hb-silent 50s/.test(log()), '서버 로그에 사유가 남음 (hb-silent 50s)');

    console.log('서버가 정말 꺼졌을 때');
    srv.kill();
    const t0 = Date.now();
    const down = await until(() => js(`document.body.textContent.includes('서버가 꺼졌습니다')`), 40000);
    const took = (Date.now() - t0) / 1000;
    check(down, `서버가 꺼지면 "서버가 꺼졌습니다" 안내가 뜸 (${took.toFixed(1)}초)`);
    check(took >= 11, '단, 잠깐 끊긴 것(12초 미만)에는 뜨지 않음');
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
