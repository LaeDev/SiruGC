// 음성에서 여러 명이 계속 나갔다 들어와도 끝에는 모두가 서로의 소리를 듣는지 확인한다. (빠르게 나갔다 들어오면 다들 갑자기 안 들리던 버그)
//  브라우저 3개가 무작위 간격으로 "음성 나가기/참가"를 반복(연타 포함)한 뒤, 가만히 두면
//  1) 음성에 있는 모든 쌍이 연결되고  2) 서로의 소리가 스피커 직전(gain 뒤)까지 실제로 오고  3) 안 쓰는 연결·마이크가 남지 않아야 한다.
//  + AudioContext가 멈추면(suspended) 소리가 사라지지 않고 복구되는지
// 실행: node tools/voice-churn-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5200 + Math.floor(Math.random() * 90), CDP_PORT = 9300 + Math.floor(Math.random() * 90);
const ROUNDS = +process.env.ROUNDS || 10;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `churn-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
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
    async function page(name) {
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log(`[${name}] JS 오류:`, r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      await call('Page.navigate', { url: `http://localhost:${PORT}/?step=profile` }); await wait(1200);
      await js(`(() => { document.querySelector('#nameIn').value = '${name}'; document.querySelector('#joinForm').requestSubmit(); })()`); await wait(1000);
      return { js, call, name };
    }
    const until = async (fn, ms = 25000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(300); } return false; };

    const P = [await page('에이'), await page('비이'), await page('씨이')];
    const inVoiceNow = (p) => p.js(`inVoice()`);
    // 한 사람의 "음성" 버튼을 무작위 간격으로 누른다. 가끔은 같은 순간에 두 번(연타)
    const churn = async (p) => {
      for (let i = 0; i < ROUNDS; i++) {
        await p.js(`(voicePrefs.ns = false, document.querySelector('#voiceBtn').click()); ${Math.random() < 0.25 ? "(voicePrefs.ns = false, document.querySelector('#voiceBtn').click());" : ''} 0`);
        await wait(Math.random() * 450);
      }
    };

    console.log(`세 명이 음성에서 ${ROUNDS}번씩 무작위로 나갔다 들어오기 (연타 포함)`);
    await Promise.all(P.map(churn));
    // 마지막 상태를 정한다: 모두 음성에 들어가 있게
    for (const p of P) if (!(await inVoiceNow(p))) await p.js(`(voicePrefs.ns = false, document.querySelector('#voiceBtn').click())`);
    await wait(500);
    check((await Promise.all(P.map(inVoiceNow))).every(Boolean), '마지막에 세 명 모두 음성에 있음');

    const connected = async (p) => p.js(`(() => { const want = voiceList.filter((v) => v.id !== me).map((v) => v.id); return want.length === 2 && want.every((id) => vpcs.get(id)?.pc.connectionState === 'connected'); })()`);
    const settled = await until(async () => (await Promise.all(P.map(connected))).every(Boolean));
    check(settled, '가만히 두면 세 명이 서로 모두 연결됨 (25초 안)');
    if (!settled) for (const p of P) console.log('   진단', p.name, JSON.stringify(await p.js(`({ me, inVoice: inVoice(), list: voiceList.map((v) => v.id), vpcs: [...vpcs].map(([k, v]) => [k, v.pc.connectionState, v.pc.signalingState, v.pc.iceConnectionState, !!v.gain]), act: actx?.state })`)), '신호 처리 줄 막힘:', await p.js(`new Promise((res) => { let ok = false; chain = chain.then(() => { ok = true; }); setTimeout(() => res(!ok), 1500); })`));

    // 각 사람 쪽에서 상대 둘의 소리가 스피커 직전까지 실제로 오는지 잰다
    const peaks = (p, ms = 3000) => p.js(`new Promise((res) => {
      const out = {}, buf = new Uint8Array(512), an = [];
      for (const [pid, v] of vpcs) { const a = actx.createAnalyser(); a.fftSize = 512; v.gain.connect(a); an.push([pid, a]); out[pid] = 0; }
      const t = setInterval(() => { for (const [pid, a] of an) { a.getByteTimeDomainData(buf); for (const x of buf) out[pid] = Math.max(out[pid], Math.abs(x - 128)); } }, 30);
      setTimeout(() => { clearInterval(t); res(out); }, ${ms}); })`);
    const hear = async () => (await Promise.all(P.map((p) => peaks(p)))).map((o) => Object.values(o));
    let h = await hear();
    check(h.every((v) => v.length === 2 && v.every((x) => x > 3)), `모두가 상대 둘의 소리를 들음 (세기 ${h.map((v) => v.map((x) => x.toFixed(0)).join('/')).join(' | ')})`);

    const stats = await Promise.all(P.map((p) => p.js(`({ vpcs: vpcs.size, tracks: [...document.querySelectorAll('audio')].length, live: (navigator.mediaDevices && mic ? mic.getAudioTracks().filter((t) => t.readyState === 'live').length : 0) })`)));
    check(stats.every((s) => s.vpcs === 2), `남는 연결 없이 정확히 둘씩 (${stats.map((s) => s.vpcs).join(',')})`);
    check(await P[0].js(`micRaw.getAudioTracks().filter((t) => t.readyState === 'live').length === 1`), '마이크 트랙이 하나만 켜져 있음 (연타해도 겹쳐 열지 않음)');

    console.log('나간 사람은 조용히 정리됨');
    await P[2].js(`(voicePrefs.ns = false, document.querySelector('#voiceBtn').click())`); await wait(1500);
    check(await P[2].js(`!inVoice() && vpcs.size === 0 && !micRaw`), '나가면 마이크와 연결이 모두 정리됨');
    check((await Promise.all([P[0], P[1]].map((p) => p.js(`vpcs.size === 1 && !vpcs.has('${'x'}')`)))).every(Boolean), '남은 두 사람은 연결 하나씩만 유지');

    console.log('AudioContext가 멈춰도(suspended) 소리가 복구됨');
    await P[2].js(`(voicePrefs.ns = false, document.querySelector('#voiceBtn').click())`);
    await until(async () => (await Promise.all(P.map(connected))).every(Boolean));
    // 브라우저가 자동 재개를 막는 상황(제스처가 필요한 iOS 등)을 흉내: resume을 잠시 무력화하고 멈춘다
    await P[1].js(`(() => { window.__resume = actx.resume.bind(actx); actx.resume = () => Promise.resolve(); return actx.suspend(); })()`); await wait(800);
    check(await P[1].js(`actx.state !== 'running'`), '(준비) B의 오디오가 멈춘 상태');
    check(await P[1].js(`[...vpcs.values()].length === 2 && [...vpcs.values()].every((v) => !v.audio.muted && v.audio.srcObject)`), '멈춰 있는 동안에는 요소로 직접 재생해서 완전히 무음이 되지는 않음');
    await P[1].js(`actx.resume = window.__resume`);
    await P[1].js(`document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))`); // 사용자가 화면을 한 번 건드림
    const back = await until(() => P[1].js(`actx.state === 'running'`), 6000);
    check(back, '화면을 한 번 건드리면 오디오가 다시 켜짐');
    check(await P[1].js(`[...vpcs.values()].every((v) => v.audio.muted)`), '다시 켜지면 WebAudio 경로로 돌아가 사람별 음량이 적용됨');
    h = await hear();
    check(h.every((v) => v.every((x) => x > 3)), `복구 뒤 모두가 서로의 소리를 들음 (세기 ${h.map((v) => v.map((x) => x.toFixed(0)).join('/')).join(' | ')})`);
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
