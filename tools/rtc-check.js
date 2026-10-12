// 실제 Chrome 창 2개로 음성 대화와 화면 공유(WebRTC)가 연결되는지 확인한다.
// 가짜 마이크(--use-fake-device-for-media-stream)와 캔버스 영상으로 getDisplayMedia를 대신한다.
// 실행: node tools/rtc-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
// 같은 PC 안의 연결이라 STUN/TURN 중계 경로(집 밖 네트워크)는 검증하지 못한다.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 3900 + Math.floor(Math.random() * 90), CDP_PORT = 9600 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `rtc-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, CONFIG_FILE: require('path').join(require('os').tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run',
    '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
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
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank' });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
      // 가짜 화면 공유: 움직이는 캔버스를 영상으로 쓴다
      await call('Page.addScriptToEvaluateOnNewDocument', { source: `navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d'); let n = 0;
        setInterval(() => { g.fillStyle = 'hsl(' + (n++ * 7 % 360) + ' 70% 50%)'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText('SHARE ' + n, 40, 200); }, 50);
        return c.captureStream(20); };` });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log(`[${name}] JS 오류:`, r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      await call('Page.navigate', { url: `http://localhost:${PORT}` }); await wait(1200);
      await js(`(() => { const n = document.querySelector('#nameIn'); n.value = '${name}'; document.querySelector('#joinForm').requestSubmit(); })()`);
      await wait(1000);
      return { js, call };
    }
    const A = await page('에이'), B = await page('비이');
    const until = async (p, expr, label, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await p.js(expr)) return true; await wait(200); } console.log('  (시간 초과) ' + label); return false; };

    console.log('음성 대화');
    await A.js(`document.querySelector('#voiceBtn').click()`); await wait(600);
    await B.js(`document.querySelector('#voiceBtn').click()`);
    check(await until(A, `[...vpcs.values()].some(v => v.pc.connectionState === 'connected')`, 'A 연결'), 'A의 음성 연결이 connected');
    check(await until(B, `[...vpcs.values()].some(v => v.pc.connectionState === 'connected')`, 'B 연결'), 'B의 음성 연결이 connected');
    const inbound = (p) => p.js(`(async () => { const v = [...vpcs.values()][0]; if (!v) return 0; const s = await v.pc.getStats(); let n = 0; s.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'audio') n += r.bytesReceived; }); return n; })()`);
    await wait(1500);
    check((await inbound(A)) > 1000, `A가 B의 소리를 받음 (${await inbound(A)} bytes)`);
    check((await inbound(B)) > 1000, `B가 A의 소리를 받음 (${await inbound(B)} bytes)`);
    check(await until(B, `document.querySelectorAll('#users .vi').length === 2`, '음성 표시'), '참가자 목록에 음성 참가 표시 2개');

    await A.js(`document.querySelector('#micBtn').click()`); await wait(500);
    check(await B.js(`[...document.querySelectorAll('#users .vi')].some(i => i.getAttribute('aria-label').includes('마이크 꺼짐'))`), 'A가 마이크를 끄면 B 화면에 꺼짐 표시');
    check(await A.js(`mic.getAudioTracks()[0].enabled === false`), '마이크 트랙이 실제로 꺼짐');
    await A.js(`document.querySelector('#micBtn').click()`);

    console.log('화면 공유');
    await A.js(`document.querySelector('#shareBtn').click()`);
    check(await until(B, `!document.querySelector('#screenWrap').hidden`, '공유 화면 표시'), 'B 화면에 공유 화면이 나타남');
    check(await until(B, `document.querySelector('#screen').videoWidth > 0`, '영상 수신'), `B가 영상을 받음 (${await B.js(`document.querySelector('#screen').videoWidth`)}px)`);
    const cap = await A.js(`(() => { const pc = [...pcs.values()][0]; const s = pc?.getSenders().find(x => x.track?.kind === 'video'); return s?.getParameters().encodings?.[0]?.maxBitrate; })()`);
    check(cap === 2500000, `공유자의 전송량 제한 적용 (maxBitrate ${cap})`);
    check(await B.js(`document.querySelector('#screenBadge').textContent.includes('에이')`), `배지에 공유자 이름 표시 ("${await B.js(`document.querySelector('#screenBadge').textContent`)}")`);
    await A.js(`document.querySelector('#shareBtn').click()`);
    check(await until(B, `document.querySelector('#screenWrap').hidden`, '공유 종료'), '공유를 끝내면 B 화면에서 사라짐');

    await A.js(`document.querySelector('#voiceBtn').click()`);
    check(await until(B, `vpcs.size === 0 && document.querySelectorAll('#users .vi').length === 1`, '음성 나가기'), 'A가 음성에서 나가면 연결 정리됨');
    browser.close();
  } finally { chrome.kill(); srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
