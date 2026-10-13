// 음성 필터와 사람별 음량이 실제로 동작하는지 확인한다.
//  1) 목소리 높낮이: 440Hz 사인파를 필터에 넣고 나온 소리의 주파수를 잰다 (높게는 올라가고 낮게는 내려가야 함)
//  2) 다른 효과(로봇/라디오/동굴)가 소리를 내는지
//  3) 브라우저 두 개: 필터를 바꿔도 연결이 유지되고 소리가 계속 가는지, 마이크 입력 크기 0이면 조용해지는지
//  4) 사람별 음량 슬라이더(0~200%)가 gain에 반영되고, 모든 소리 끄기가 이기고, 저장되는지
// 실행: node tools/voice-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5100 + Math.floor(Math.random() * 90), CDP_PORT = 9200 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `voice-${Date.now()}.json`);
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
      await call('Page.navigate', { url: `http://localhost:${PORT}` }); await wait(1200);
      await js(`(() => { document.querySelector('#nameIn').value = '${name}'; document.querySelector('#joinForm').requestSubmit(); })()`); await wait(1000);
      return { js, call };
    }
    const until = async (p, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await p.js(expr)) return true; await wait(200); } return false; };

    const A = await page('에이'), B = await page('비이');

    console.log('목소리 높낮이 (440Hz 사인파를 넣고 나온 소리의 주파수를 잼)');
    const measure = (ratio) => A.js(`(async () => {
      const sr = 44100, ctx = new OfflineAudioContext(1, sr * 2, sr), osc = ctx.createOscillator();
      osc.frequency.value = 440; osc.start();
      const p = makePitchShifter(ctx, ${ratio}); osc.connect(p.input); p.output.connect(ctx.destination);
      const d = (await ctx.startRendering()).getChannelData(0);
      let z = 0, prev = d[sr]; for (let i = sr + 1; i < sr * 2; i++) { if ((prev < 0) !== (d[i] < 0)) z++; prev = d[i]; }
      return z / 2; })()`);
    const high = await measure(1.35), low = await measure(0.75), same = await measure(1);
    check(Math.abs(high - 594) / 594 < 0.12, `높은 목소리: 440Hz → ${Math.round(high)}Hz (목표 594Hz ±12%)`);
    check(Math.abs(low - 330) / 330 < 0.12, `낮은 목소리: 440Hz → ${Math.round(low)}Hz (목표 330Hz ±12%)`);
    check(high > same * 1.2 && low < same * 0.85, `높게는 올라가고 낮게는 내려감 (${Math.round(low)} < ${Math.round(same)} < ${Math.round(high)})`);
    for (const kind of ['robot', 'radio', 'cave']) {
      const rms = await A.js(`(async () => {
        const sr = 44100, ctx = new OfflineAudioContext(1, sr, sr), osc = ctx.createOscillator(); osc.frequency.value = 300; osc.start();
        const f = makeFilter(ctx, '${kind}'); osc.connect(f.input); f.output.connect(ctx.destination);
        const d = (await ctx.startRendering()).getChannelData(0); let s = 0, bad = 0; for (let i = sr / 2; i < sr; i++) { s += d[i] * d[i]; if (!Number.isFinite(d[i])) bad++; }
        return bad ? -1 : Math.sqrt(s / (sr / 2)); })()`);
      check(rms > 0.02 && rms < 2, `${kind} 필터가 소리를 냄 (세기 ${rms.toFixed(3)})`);
    }

    console.log('필터를 바꿔도 연결과 소리가 유지되는가 (브라우저 2개)');
    await A.js(`document.querySelector('#voiceBtn').click()`); await wait(700);
    await B.js(`document.querySelector('#voiceBtn').click()`);
    check(await until(A, `[...vpcs.values()].some((v) => v.pc.connectionState === 'connected')`), '두 사람이 음성으로 연결됨');
    // 스피커로 가기 직전(gain 바로 뒤)의 신호 크기를 직접 잰다: 필터·마이크 크기·사람별 음량이 실제로 소리에 반영되는지 보여 준다 (0~128)
    const peak = (p, ms = 3000) => p.js(`new Promise((res) => {
      const v = [...vpcs.values()][0];
      if (!window.__an) { window.__an = actx.createAnalyser(); window.__an.fftSize = 512; v.gain.connect(window.__an); window.__buf = new Uint8Array(512); }
      let m = 0; const t = setInterval(() => { window.__an.getByteTimeDomainData(window.__buf); for (const x of window.__buf) m = Math.max(m, Math.abs(x - 128)); }, 30);
      setTimeout(() => { clearInterval(t); res(m); }, ${ms}); })`);
    const base = await peak(B);
    check(base > 3, `원래 목소리가 B의 스피커 쪽으로 나옴 (신호 크기 ${base.toFixed(1)})`);
    await A.js(`window.__pc0 = vpcs.values().next().value.pc`);
    for (const kind of ['high', 'robot', 'cave', 'off']) {
      await A.js(`(() => { const s = document.querySelector('#vfSel'); s.value = '${kind}'; s.dispatchEvent(new Event('change')); })()`);
      const d = await peak(B, 2600);
      check(d > 2, `필터 "${kind}"로 바꿔도 소리가 계속 나옴 (신호 크기 ${d.toFixed(1)})`);
    }
    check(await A.js(`vpcs.values().next().value.pc === window.__pc0 && vpcs.size === 1`), '필터를 바꿔도 연결을 다시 맺지 않음 (같은 연결 유지)');
    await A.js(`(() => { const r = document.querySelector('#micGain'); r.value = 0; r.dispatchEvent(new Event('input')); })()`);
    const quiet = await peak(B, 2600);
    check(quiet < 1.5, `마이크 입력 크기 0%면 조용해짐 (신호 크기 ${quiet.toFixed(1)})`);
    await A.js(`(() => { const r = document.querySelector('#micGain'); r.value = 100; r.dispatchEvent(new Event('input')); })()`);
    check(await A.js(`JSON.parse(localStorage.voicePrefs).filter === 'off' && JSON.parse(localStorage.voicePrefs).mic === 100`), '필터와 입력 크기 설정이 이 기기에 저장됨');
    await A.js(`(() => { const c = document.querySelector('#ecOn'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
    check(await A.js(`JSON.parse(localStorage.voicePrefs).ec === false`), '에코 제거 같은 마이크 처리 옵션도 저장됨');

    console.log('사람별 목소리 크기');
    await B.js(`document.querySelector('#tab-users').click()`); await wait(300);
    const aid = await B.js(`users.find((u) => u.name === '에이').id`), auid = await B.js(`users.find((u) => u.name === '에이').uid`);
    await B.js(`document.querySelector('[data-uid="${aid}"]').click()`); await wait(300);
    check(await B.js(`!!document.querySelector('.acts input.vol') && document.querySelector('.acts input.vol').min === '0' && document.querySelector('.acts input.vol').max === '200'`), '참가자 메뉴에 목소리 크기 슬라이더(0~200%)가 있음');
    const setVol = (v) => B.js(`(() => { const r = document.querySelector('.acts input.vol'); r.focus(); r.value = ${v}; r.dispatchEvent(new Event('input')); })()`);
    const gainOf = () => B.js(`[...vpcs.values()][0].gain.gain.value`);
    await setVol(50); check(Math.abs((await gainOf()) - 0.5) < 0.01, '50% → gain 0.5'); const p50 = await peak(B, 2600);
    await setVol(200); check(Math.abs((await gainOf()) - 2) < 0.01, '200% → gain 2 (100%를 넘겨 키울 수 있음)'); const p200 = await peak(B, 2600);
    check(p200 > p50 * 1.5, `실제 소리도 커짐 (50%일 때 ${p50.toFixed(1)} → 200%일 때 ${p200.toFixed(1)})`);
    await setVol(0); check((await gainOf()) === 0, '0% → 그 사람만 완전히 꺼짐');
    check((await peak(B, 2000)) < 1.5, '0%일 때 실제로 조용함');
    check(await B.js(`JSON.parse(localStorage.voiceVol)['${auid}'] === 0`), '사람별 크기가 이 기기에 저장됨 (그 사람의 공개 번호 기준)');
    await setVol(70);
    const keep = await B.js(`(() => { const before = document.querySelector('.acts input.vol'); renderUsers(); return before === document.querySelector('.acts input.vol') && usersPending; })()`);
    check(keep, '슬라이더를 끄는 중에는 목록이 다시 그려지지 않음 (끌고 있는 슬라이더를 놓치지 않음)');
    await B.js(`document.querySelector('.acts input.vol').blur()`); await wait(200);
    check(await B.js(`!usersPending && Math.round(document.querySelector('.acts input.vol').value) === 70`), '손을 떼면 목록이 갱신되고 값은 유지됨');
    await B.js(`document.querySelector('#soundBtn').click()`);
    check((await gainOf()) === 0, '모든 소리 끄기가 사람별 크기보다 우선');
    await B.js(`document.querySelector('#soundBtn').click()`);
    check(Math.abs((await gainOf()) - 0.7) < 0.01, '소리를 다시 켜면 사람별 크기(70%)로 돌아옴');
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
