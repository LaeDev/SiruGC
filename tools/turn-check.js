// 설정한 TURN(중계) 서버가 실제로 동작하는지 확인한다. 프로젝트의 config.env 를 그대로 읽는다(점검용 서버는 임시 포트·임시 상태 파일).
//  1단계: 서버가 내려주는 ICE 목록이 브라우저에서 유효한지, 각 TURN 서버에서 중계(relay) 주소를 받아 오는지(인증·도달 여부)
//  2단계: 두 브라우저를 '중계 전용'으로 강제해 음성과 화면 공유가 TURN을 거쳐 실제로 흐르는지
// 실행: node tools/turn-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
// 계정 값(아이디/비밀번호)은 출력하지 않는다. 같은 PC 안의 두 창이라 '집 밖 시청자'와 같은 조건은 아니고, TURN이 쓸 수 있는지만 증명한다.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 4500 + Math.floor(Math.random() * 90), CDP_PORT = 9500 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));
const mask = (s) => (s ? s.slice(0, 3) + '***(' + s.length + '자)' : '(없음)');

(async () => {
  const state = path.join(os.tmpdir(), `turn-${Date.now()}.json`);
  // CONFIG_FILE을 지정하지 않으므로 프로젝트의 진짜 config.env 를 읽는다
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  try {
    await wait(2500);
    // ---- 서버가 내려주는 ICE 목록 ----
    const ice = await new Promise((ok, no) => {
      const ws = new WebSocket(`ws://localhost:${PORT}`); const t = setTimeout(() => no(new Error('서버 응답 없음')), 5000);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: '점검', cid: 'turn-check-cid-0001' })));
      ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'joined') { clearTimeout(t); ws.close(); ok(m.ice); } });
    });
    const turns = ice.filter((s) => [].concat(s.urls).some((u) => /^turns?:/i.test(u)));
    console.log('서버가 내려주는 연결 서버 목록');
    for (const s of ice) console.log('  -', [].concat(s.urls).join(', '), s.username ? `(계정 ${mask(s.username)} / 비밀번호 ${mask(s.credential)})` : '(계정 없음)');
    check(turns.length > 0, 'TURN 서버가 설정되어 있음 (config.env의 ICE_SERVERS 또는 TURN_URL)');
    check(ice.every((s) => [].concat(s.urls).every((u) => /^(stuns?|turns?):/i.test(u))), '모든 주소에 stun:/turn:/turns: 접두어가 있음 (없으면 브라우저가 WebRTC를 통째로 거부)');
    if (!turns.length) throw new Error('TURN 설정이 없어서 더 진행할 수 없어요');

    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
    async function page(name, join) {
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank' });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Page.addScriptToEvaluateOnNewDocument', { source: `navigator.mediaDevices.getDisplayMedia = async () => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d'); let n = 0; setInterval(() => { g.fillStyle = 'hsl(' + (n++ * 9 % 360) + ' 70% 50%)'; g.fillRect(0, 0, 640, 360); }, 50); return c.captureStream(20); };` });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log(`[${name}] JS 오류:`, r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      await call('Page.navigate', { url: `http://localhost:${PORT}/?step=profile` }); await wait(1200);
      if (join) { await js(`(() => { document.querySelector('#nameIn').value = '${name}'; document.querySelector('#joinForm').requestSubmit(); })()`); await wait(1000); }
      return { js };
    }
    const until = async (p, expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await p.js(expr)) return true; await wait(250); } return false; };

    // ---- 1단계: 각 TURN 서버에서 중계 주소를 받아 오는가 ----
    console.log('\n1단계: TURN 서버 인증과 중계 주소 받기 (이 PC → TURN 서버)');
    const G = await page('probe', false);
    const variants = [];
    for (const s of turns) for (const u of [].concat(s.urls)) {
      variants.push({ label: u, server: { ...s, urls: [u] } });
      if (!/transport=/.test(u) && /^turn:/i.test(u)) variants.push({ label: u + '?transport=tcp', server: { ...s, urls: [u + '?transport=tcp'] } });
    }
    let anyRelay = false;
    for (const v of variants) {
      const r = await G.js(`(async () => {
        const pc = new RTCPeerConnection({ iceServers: [${JSON.stringify(v.server)}], iceTransportPolicy: 'relay' });
        const c = [], errs = [];
        pc.onicecandidate = (e) => e.candidate && c.push(e.candidate.candidate);
        pc.onicecandidateerror = (e) => errs.push(e.errorCode + ' ' + e.errorText);
        pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer());
        await new Promise((res) => { pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && res(); setTimeout(res, 10000); });
        pc.close(); return { relay: c.filter((x) => / typ relay /.test(x)).length, total: c.length, errs };
      })()`);
      // 중계 주소를 받았다면 701(IPv6 조회 실패 등)은 부수적인 오류라 힌트를 붙이지 않는다
      const hint = r.relay > 0 ? '' : r.errs.some((e) => /^401/.test(e)) ? ' → 401: 아이디/비밀번호가 틀렸거나 만료됐어요'
        : r.errs.some((e) => /^70[0-9]/.test(e)) ? ' → 70x: TURN 서버에 닿지 못했어요(방화벽/UDP 차단/주소 오류)' : '';
      const ok = r.relay > 0; anyRelay ||= ok;
      console.log(`  ${ok ? '통과' : '실패'} ${v.label} → 중계 주소 ${r.relay}개${r.errs.length ? ' / 오류: ' + [...new Set(r.errs)].join(', ') : ''}${hint}`);
      if (!ok && !/transport=tcp/.test(v.label)) failed++; // 설정한 주소 자체가 안 되면 실패, tcp 변형은 참고용
    }
    check(anyRelay, '적어도 한 가지 방법으로 TURN에서 중계 주소를 받음');

    // ---- 2단계: 중계 전용으로 강제한 두 창이 실제로 음성/화면 공유를 주고받는가 ----
    if (anyRelay) {
      console.log('\n2단계: 중계 전용으로 강제한 두 브라우저 사이의 음성과 화면 공유');
      const A = await page('에이', true), B = await page('비이', true);
      for (const p of [A, B]) await p.js(`rtcConfig.iceTransportPolicy = 'relay'`); // 직접 연결을 막고 TURN만 쓰게 한다
      await A.js(`document.querySelector('#voiceBtn').click()`); await wait(600);
      await B.js(`document.querySelector('#voiceBtn').click()`);
      check(await until(A, `[...vpcs.values()].some(v => v.pc.connectionState === 'connected')`), '중계 전용 음성 연결이 connected');
      await wait(2000);
      const pair = (p) => p.js(`(async () => { const v = [...vpcs.values()][0]; if (!v) return null; const s = await v.pc.getStats(); let r = null, bytes = 0; s.forEach((x) => { if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') r = s.get(x.localCandidateId)?.candidateType + '/' + s.get(x.remoteCandidateId)?.candidateType; if (x.type === 'inbound-rtp' && x.kind === 'audio') bytes += x.bytesReceived; }); return { pair: r, bytes }; })()`);
      const pa = await pair(A);
      check(pa?.pair?.startsWith('relay'), `음성이 중계 서버를 거침 (내 쪽 후보: ${pa?.pair})`);
      check(pa?.bytes > 1000, `중계를 거쳐 상대 소리가 도착함 (${pa?.bytes} bytes)`);
      await A.js(`document.querySelector('#shareBtn').click()`);
      check(await until(B, `document.querySelector('#screen').videoWidth > 0`), '중계를 거쳐 공유 화면 영상이 도착함');
      const share = await B.js(`document.querySelector('#screenBadge').textContent`);
      check(/중계 서버 경유/.test(share), `화면에 "중계 서버 경유" 표시가 뜸 ("${share}")`);
    }
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
