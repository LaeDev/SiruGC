// AI 잡음 억제(GTCRN)를 실제 브라우저에서 숫자로 확인한다.
//  - 모델 파일과 AudioWorklet 이 서버에서 내려오고 실제로 켜진다
//  - 흰 잡음이 강도 100%에서는 크게 줄고, 0%에서는 그대로 지나가고, 50%에서는 그 사이가 된다
//  - 마이크 처리 그래프에 억제 단계가 들어가고, 설정(체크박스·강도 슬라이더)이 바로 반영되며, 켜면 브라우저 기본 잡음 억제는 꺼진다
// 사람 목소리가 얼마나 자연스럽게 남는지는 귀로 들어 봐야 해서 이 도구로는 확인하지 못한다.
// 실행: node tools/noise-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { AUTH_ENV } = require('./_auth');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 6100 + Math.floor(Math.random() * 90), CDP_PORT = 9300 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `noise-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...AUTH_ENV, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  try {
    await wait(2500);
    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); if (m.method === 'Runtime.exceptionThrown') console.log('  페이지 예외:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
    const { result: { browserContextId } } = await raw('Target.createBrowserContext');
    const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
    const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => raw(m, p, sessionId);
    await call('Page.enable'); await call('Runtime.enable');
    const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}` }); await wait(1500);

    console.log('모델과 AudioWorklet');
    check(await js(`(async () => { const r = await fetch('/vendor/gtcrn/gtcrn.wasm'); return r.ok && r.headers.get('content-type') === 'application/wasm' && (await r.arrayBuffer()).byteLength > 100000; })()`), '모델 파일(.wasm)이 서버에서 내려옴');
    check(await js(`nsLoad()`), 'AI 잡음 억제를 불러옴 (샘플레이트 ' + (await js('actx.sampleRate')) + 'Hz)');

    console.log('잡음 줄이기 (흰 잡음 4초, 뒤쪽 2초의 세기를 잼)');
    const run = (amt) => js(`(async () => { // 실시간 컨텍스트에서 4초 동안 재생하며 뒤쪽 2초의 세기를 잰다 (모델은 비동기로 켜지므로 오프라인 렌더링으로는 잴 수 없다)
      const ctx = actx, sr = ctx.sampleRate, N = sr * 4, buf = ctx.createBuffer(1, N, sr), d = buf.getChannelData(0); for (let i = 0; i < N; i++) d[i] = (Math.random() * 2 - 1) * 0.1;
      const src = ctx.createBufferSource(); src.buffer = buf; const ns = makeNs(ctx, ${amt});
      const tapIn = ctx.createScriptProcessor(4096, 1, 1), tapOut = ctx.createScriptProcessor(4096, 1, 1), mute = ctx.createGain(); mute.gain.value = 0;
      let t0 = ctx.currentTime, si = 0, so = 0, n = 0, m = 0;
      tapIn.onaudioprocess = (e) => { if (ctx.currentTime - t0 > 2) for (const x of e.inputBuffer.getChannelData(0)) { si += x * x; n++; } };
      tapOut.onaudioprocess = (e) => { if (ctx.currentTime - t0 > 2) for (const x of e.inputBuffer.getChannelData(0)) { so += x * x; m++; } };
      src.connect(ns.input); src.connect(tapIn).connect(mute); ns.output.connect(tapOut).connect(mute); mute.connect(ctx.destination);
      t0 = ctx.currentTime; src.start();
      await new Promise((r) => setTimeout(r, 4300)); ns.stop(); tapIn.disconnect(); tapOut.disconnect();
      return { inn: Math.sqrt(si / n), out: Math.sqrt(so / m) };
    })()`);
    const db = (r) => 20 * Math.log10(r.out / r.inn);
    const full = await run(100), none = await run(0), half = await run(50);
    console.log(`    강도 100%: ${db(full).toFixed(1)} dB / 50%: ${db(half).toFixed(1)} dB / 0%: ${db(none).toFixed(1)} dB`);
    check(db(full) < -15, '강도 100%: 흰 잡음이 15 dB 넘게 줄어듦');
    check(Math.abs(db(none)) < 1, '강도 0%: 원래 소리가 그대로 지나감');
    check(db(half) < db(none) - 2 && db(half) > db(full) + 2, '강도 50%: 그 사이');

    console.log('마이크 처리 그래프와 설정');
    check(await js(`(async () => {
      const dest = actx.createMediaStreamDestination(); const osc = actx.createOscillator(); osc.connect(dest); osc.start();
      voicePrefs.ns = true; voicePrefs.nsAmt = 70; const s = buildMicGraph(dest.stream);
      return !!mg.ns && s instanceof MediaStream;
    })()`), '억제를 켜 두면 마이크 처리 그래프에 억제 단계가 들어감');
    check(await js(`browserNs() === false`), 'AI 억제가 켜져 있으면 브라우저 기본 잡음 억제는 꺼서 겹쳐 쓰지 않음');
    await js(`(() => { const s = document.querySelector('#nsAmt'); s.value = 20; s.dispatchEvent(new Event('input')); })()`);
    check(await js(`voicePrefs.nsAmt === 20 && document.querySelector('#nsAmtOut').textContent === '20%'`), '강도 슬라이더가 값과 표시에 반영됨');
    await js(`(() => { const c = document.querySelector('#nsOn'); c.checked = false; c.dispatchEvent(new Event('change')); })()`); await wait(300);
    check(await js(`!mg.ns && voicePrefs.ns === false && browserNs() === false`), '체크를 끄면 억제 단계가 빠짐');
    await js(`(() => { const c = document.querySelector('#nsOn'); c.checked = true; c.dispatchEvent(new Event('change')); })()`); await wait(800);
    check(await js(`!!mg.ns && document.querySelector('#nsNote').textContent.includes('AI 잡음 억제를 쓰고 있어요')`), '다시 켜면 바로 적용되고 안내 문구가 나옴');
    check(await js(`localStorage.getItem('voicePrefs').includes('"nsAmt":20')`), '강도가 이 기기에 저장됨');

    console.log('울림 줄이기');
    check(await js(`drLoad()`), '울림 줄이기 워커(dereverb.js)를 불러옴');
    check(await js(`!mg.dr`), '기본값 0% 에서는 그래프에 들어가지 않음');
    await js(`(() => { const s = document.querySelector('#drAmt'); s.value = 60; s.dispatchEvent(new Event('input')); })()`); await wait(500);
    check(await js(`!!mg.dr && voicePrefs.dr === 60 && document.querySelector('#drAmtOut').textContent === '60%'`), '슬라이더를 올리면 그래프에 들어가고 표시에 반영됨');
    check(await js(`Math.abs(mg.dr.output.parameters.get('amount').value - 60 / 100 * DR_MAX) < 1e-4`), '슬라이더 값이 워커의 amount 로 전달됨');
    await js(`(() => { const s = document.querySelector('#drAmt'); s.value = 30; s.dispatchEvent(new Event('input')); })()`); await wait(300);
    check(await js(`Math.abs(mg.dr.output.parameters.get('amount').value - 30 / 100 * DR_MAX) < 1e-4`), '켜진 채로 값을 바꿔도 amount 만 바뀜');
    check(await js(`localStorage.getItem('voicePrefs').includes('"dr":30')`), '울림 줄이기 값이 이 기기에 저장됨');
    await js(`(() => { const s = document.querySelector('#drAmt'); s.value = 0; s.dispatchEvent(new Event('input')); })()`); await wait(300);
    check(await js(`!mg.dr && !!mg.ns`), '0%로 내리면 그래프에서 빠지고 잡음 억제는 그대로');
    browser.close();
  } finally {
    srv.kill(); try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} await wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(state, { force: true }); } catch {}
  }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
