// 채팅·쪽지 사진/동영상 첨부를 실제 브라우저 두 창으로 확인한다.
//  버튼으로 실제 이미지 파일 올리기, 큰 사진 줄이기, 동영상(브라우저가 직접 녹화한 진짜 WebM), 붙여넣기, 사진 크게 보기,
//  쪽지 첨부, 오류 안내, 만료된 파일 표시, 모든 소리 끄기와 동영상, 모바일에서 가로로 넘치지 않는지
// 실행: node tools/attach-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5300 + Math.floor(Math.random() * 90), CDP_PORT = 9000 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `att-${Date.now()}.json`), upDir = path.join(os.tmpdir(), `att-up-${Date.now()}`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, UPLOAD_DIR: upDir, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
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
      await call('Page.enable'); await call('Runtime.enable'); await call('DOM.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log(`[${name}] JS 오류:`, r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      await call('Page.navigate', { url: `http://localhost:${PORT}` }); await wait(1200);
      await js(`(() => { document.querySelector('#nameIn').value = '${name}'; document.querySelector('#joinForm').requestSubmit(); })()`); await wait(1000);
      const setFiles = async (selector, files) => { const { result: { root } } = await call('DOM.getDocument'); const { result: { nodeId } } = await call('DOM.querySelector', { nodeId: root.nodeId, selector }); await call('DOM.setFileInputFiles', { files, nodeId }); };
      return { js, call, setFiles };
    }
    const until = async (p, expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await p.js(expr)) return true; await wait(200); } return false; };
    const A = await page('에이'), B = await page('비이');
    const icon = path.join(__dirname, '..', 'public', 'icons', 'icon-192.png').replace(/\//g, '\\');

    console.log('사진 올리기 (첨부 버튼으로 실제 파일)');
    await A.js(`document.querySelector('#chatIn').value = '이건 설명이야'`);
    await A.setFiles('#attachFile', [icon]);
    check(await until(B, `!!document.querySelector('#chat .bubble .media img')`), 'B 채팅에 사진이 나타남');
    check(await until(B, `document.querySelector('#chat .bubble .media img').complete && document.querySelector('#chat .bubble .media img').naturalWidth === 192`), '작은 사진은 화질 그대로(192px) 올라감');
    check(await B.js(`document.querySelector('#chat .bubble p').textContent === '이건 설명이야'`), '입력창에 써 둔 글이 설명으로 같이 감');
    check(await A.js(`document.querySelector('#chatIn').value === '' && !document.querySelector('#chat .upl')`), '보낸 뒤 입력창과 진행 표시가 정리됨');
    check(await B.js(`document.querySelector('#chat .bubble .media').style.aspectRatio.replace(/\\s/g, '') === '192/192'`), '불러오기 전에 칸 크기를 잡아 둠(화면이 흔들리지 않게)');

    console.log('큰 사진은 줄여서 올리기');
    await A.js(`(async () => { const c = document.createElement('canvas'); c.width = 3200; c.height = 2400; const g = c.getContext('2d');
      for (let i = 0; i < 400; i++) { g.fillStyle = 'hsl(' + (i * 37 % 360) + ' 70% 50%)'; g.fillRect((i * 97) % 3200, (i * 53) % 2400, 300, 200); }
      const blob = await new Promise((r) => c.toBlob(r, 'image/png')); window.__bigSize = blob.size;
      attach(new File([blob], 'big.png', { type: 'image/png' }), { kind: 'chat' }); })()`);
    check(await until(B, `document.querySelectorAll('#chat .bubble .media img').length === 2`), '큰 사진도 도착함');
    const big = await B.js(`(() => { const i = document.querySelectorAll('#chat .bubble .media img')[1]; return { w: i.naturalWidth, h: i.naturalHeight, ratio: i.closest('.media').style.aspectRatio.replace(/\\s/g, '') }; })()`);
    check(big.w === 1600 && big.h === 1200 && big.ratio === '1600/1200', `3200x2400 사진이 1600x1200으로 줄어 올라감 (${big.w}x${big.h})`);

    console.log('동영상 올리기 (브라우저가 직접 녹화한 진짜 WebM)');
    await B.js(`setSoundOff(true)`); // 받는 쪽은 소리를 끈 상태
    await A.js(`(async () => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d');
      const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' }); const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
      let n = 0; const t = setInterval(() => { g.fillStyle = 'hsl(' + (n++ * 20 % 360) + ' 70% 50%)'; g.fillRect(0, 0, 320, 180); }, 50);
      rec.start(); await new Promise((r) => setTimeout(r, 1200)); const done = new Promise((r) => (rec.onstop = r)); rec.stop(); await done; clearInterval(t);
      const blob = new Blob(chunks, { type: 'video/webm' }); window.__vidSize = blob.size;
      attach(new File([blob], 'clip.webm', { type: 'video/webm' }), { kind: 'chat' }); })()`);
    check(await until(B, `!!document.querySelector('#chat .bubble .media video')`), 'B 채팅에 동영상이 나타남');
    check(await until(B, `document.querySelector('#chat .bubble .media video').readyState >= 1 && document.querySelector('#chat .bubble .media video').videoWidth === 320`), '동영상 정보를 읽어 재생할 수 있음 (320x180)');
    check(await B.js(`document.querySelector('#chat .bubble .media video').muted === true`), '모든 소리 끄기가 켜져 있으면 새 동영상도 소리 없이');
    await B.js(`setSoundOff(false)`);
    check(await B.js(`document.querySelector('#chat .bubble .media video').muted === false`), '소리를 다시 켜면 동영상 소리도 돌아옴');
    check(await B.js(`(async () => { const r = await fetch(document.querySelector('#chat .bubble .media video').src, { headers: { Range: 'bytes=0-99' } }); return r.status === 206; })()`), '동영상은 Range 요청(건너뛰기)이 됨');

    console.log('붙여넣기 / 사진 크게 보기');
    await A.js(`(async () => { const c = document.createElement('canvas'); c.width = 40; c.height = 40; c.getContext('2d').fillRect(0, 0, 40, 40);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([blob], 'paste.png', { type: 'image/png' }));
      document.querySelector('#chatIn').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    check(await until(B, `document.querySelectorAll('#chat .bubble .media img').length === 3`), '이미지를 붙여넣으면 바로 올라감');
    await B.js(`document.querySelector('#chat .bubble .media .mbtn').click()`); await wait(400);
    check(await B.js(`document.querySelector('#lightbox').open && document.querySelector('#lbImg').naturalWidth > 0`), '사진을 누르면 크게 열림');
    await B.js(`document.querySelector('#lightbox').click()`); await wait(200);
    check(await B.js(`!document.querySelector('#lightbox').open`), '아무 데나 누르면 닫힘');

    console.log('쪽지에 첨부');
    const buid = await A.js(`users.find((u) => u.name === '비이').uid`), auid = await B.js(`users.find((u) => u.name === '에이').uid`);
    await A.js(`openDm('${buid}', users.find((u) => u.name === '비이'))`); await wait(500);
    await A.setFiles('#dmAttachFile', [icon]);
    check(await until(A, `!!document.querySelector('#dmMsgs .bubble .media img')`), 'A의 쪽지 대화에 사진이 보임');
    await B.js(`openDm('${auid}')`);
    check(await until(B, `!!document.querySelector('#dmMsgs .bubble .media img') && document.querySelector('#dmList') !== null`), 'B가 대화를 열면 쪽지 사진이 보임');
    check(await B.js(`document.querySelector('#dmMsgs .bubble p') === null`), '글 없이 사진만 보낸 쪽지는 글줄 없이 사진만');

    console.log('오류와 만료');
    await A.js(`uploadToken = 'bad-token-00000'`);
    await A.js(`attach(new File([new Uint8Array(500)], 'x.png', { type: 'image/png' }), { kind: 'chat' })`);
    check(await until(A, `document.querySelector('#chat .upl.err')?.textContent.includes('열 수 없어요') || document.querySelector('#chat .upl.err')?.textContent.includes('로그인')`), '올리지 못하면 이유를 알려 줌');
    await A.js(`attach(new File(['hello'], 'a.txt', { type: 'text/plain' }), { kind: 'chat' })`);
    check(await A.js(`[...document.querySelectorAll('#chat .sys')].some((e) => e.textContent.includes('사진(JPG, PNG, GIF, WebP)이나 동영상'))`), '사진·동영상이 아닌 파일은 안내하고 올리지 않음');
    await B.js(`(() => { const n = mediaNode({ url: '/f/' + '0'.repeat(32) + '.jpg', kind: 'image', w: 10, h: 10 }); n.id = 'gone'; document.body.append(n); })()`);
    check(await until(B, `!!document.querySelector('#gone .expired')`, 4000), '지워진 파일은 "파일이 없어요"로 보임');

    console.log('연달아 보내는 글이 사라지지 않는가 (서버의 도배 방지에 걸리지 않게 간격을 두고 보냄)');
    await B.js(`showTab('chat')`);
    await A.js(`for (let i = 1; i <= 4; i++) sendPaced('chat', { t: 'chat', text: '연속' + i })`);
    check(await until(B, `['연속1', '연속2', '연속3', '연속4'].every((t) => [...document.querySelectorAll('#chat .bubble p')].some((p) => p.textContent === t))`, 6000), '거의 동시에 보낸 글 4개가 모두 도착함');
    check(await B.js(`(() => { const t = [...document.querySelectorAll('#chat .bubble p')].map((p) => p.textContent).filter((x) => x.startsWith('연속')); return t.join() === '연속1,연속2,연속3,연속4'; })()`), '보낸 순서 그대로');

    console.log('모바일에서 가로로 넘치지 않는가');
    await B.js(`showTab('chat')`); // 채팅 패널이 숨겨져 있으면 폭이 0으로 나오므로 채팅 탭으로 돌아온다
    await B.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await wait(500);
    const m = await B.js(`(() => ({ hs: document.documentElement.scrollWidth - innerWidth, c: document.querySelector('#chat').scrollWidth - document.querySelector('#chat').clientWidth, mw: Math.max(...[...document.querySelectorAll('#chat .media')].map((x) => x.getBoundingClientRect().width)), vw: innerWidth }))()`);
    check(m.hs <= 0 && m.c <= 0 && m.mw > 50 && m.mw <= m.vw, `사진·동영상이 화면을 넘지 않음 (가장 넓은 미디어 ${Math.round(m.mw)}px / 화면 ${m.vw}px)`);
    browser.close();
  } finally { chrome.kill(); srv.kill(); fs.rmSync(state, { force: true }); fs.rmSync(upDir, { recursive: true, force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
