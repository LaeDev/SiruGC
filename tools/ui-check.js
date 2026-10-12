// 헤드리스 Chrome(CDP)으로 화면 배치를 수치로 확인하고 스크린샷을 남긴다.
// 소리는 --mute-audio로 꺼 둔다 (끄지 않으면 가짜 마이크 삑 소리와 유튜브 영상이 PC 스피커로 나온다).
// 실행: node tools/ui-check.js [출력폴더]   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
// 임시 서버(임시 상태 파일)를 따로 띄우므로 실제 state.json은 건드리지 않는다. 소프트웨어 렌더링이라 GPU 검증은 아님.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const WebSocket = require('ws');

const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'ui-check'));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 3600 + Math.floor(Math.random() * 300), CDP_PORT = 9300 + Math.floor(Math.random() * 300);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const state = path.join(os.tmpdir(), `uic-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, CONFIG_FILE: require('path').join(require('os').tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--hide-scrollbars',
    '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  try {
    await wait(2500);
    const tabs = await getJson(`http://localhost:${CDP_PORT}/json`);
    const cdp = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => cdp.on('open', r));
    let id = 0; const pending = new Map(); const errors = [];
    cdp.on('message', (d) => {
      const m = JSON.parse(d); pending.get(m.id)?.(m);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    const call = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); cdp.send(JSON.stringify({ id: i, method, params })); });
    const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
    const shot = async (name, full) => { const r = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); };
    const view = (w, h, mobile) => call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile, screenOrientation: w > h ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 } });
    await call('Page.enable'); await call('Runtime.enable');

    // 입장 (모바일 세로)
    await view(390, 844, true);
    await call('Page.navigate', { url: `http://localhost:${PORT}` }); await wait(1500);
    await js(`document.querySelector('#joinForm').requestSubmit()`); await wait(200);
    check((await js(`document.querySelector('#joinMsg').textContent`)) === '닉네임을 입력해 주세요.', '닉네임이 비어 있으면 입장하지 않고 안내 문구가 나옴');
    await js(`(() => { const n = document.querySelector('#nameIn'); n.value = '하늘'; n.dispatchEvent(new Event('input')); document.querySelector('#emojis button[data-e="🦊"]').click(); document.querySelector('#swatches .sw[data-c="#a98bff"]').click(); document.querySelector('#joinForm').requestSubmit(); })()`);
    await wait(1200);

    // 다른 참가자가 영상 2개를 올리고 채팅
    const guest = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise((r) => guest.on('open', r));
    guest.send(JSON.stringify({ t: 'join', name: '지나가던 코끼리', cid: 'guest-cid-000001', color: '#6ee7a8' }));
    await wait(400);
    for (const v of ['jNQXAC9IVRw', 'dQw4w9WgXcQ']) { guest.send(JSON.stringify({ t: 'queue-add', videoId: v })); await wait(900); }
    for (const t of ['안녕하세요! 오늘 같이 볼 영상 올릴게요', '조회수 1,234,567,890회짜리 영상인데 제목이 아주아주아주아주아주아주 길어서 줄바꿈이 잘 되는지도 같이 봐야 해요']) { guest.send(JSON.stringify({ t: 'chat', text: t })); await wait(400); }
    await wait(3500);

    console.log('모바일 세로 390x844 (영상 재생 중)');
    const m1 = await js(`(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height, w: b.width }; };
      return { vh: innerHeight, pageScroll: document.documentElement.scrollHeight - innerHeight, hscroll: document.documentElement.scrollWidth - innerWidth,
        top: r('.top'), frame: r('#ytWrap'), tabs: r('.stabs'), chat: r('#chat'), input: r('#chatIn'), iframe: !!document.querySelector('#ytWrap iframe') }; })()`);
    check(m1.pageScroll <= 0, `페이지 스크롤 없음 (넘침 ${m1.pageScroll}px)`);
    check(m1.hscroll <= 0, `가로 넘침 없음 (${m1.hscroll}px)`);
    check(m1.iframe && m1.frame.h > 150, `영상 보임 (높이 ${Math.round(m1.frame.h)}px)`);
    check(m1.input && m1.input.bottom <= m1.vh + 1, `채팅 입력창이 화면 안 (bottom ${Math.round(m1.input.bottom)} / ${m1.vh})`);
    check(m1.chat.h >= 150, `채팅 목록이 읽을 만큼 보임 (${Math.round(m1.chat.h)}px)`);
    check(m1.frame.bottom <= m1.tabs.top + 1 && m1.tabs.bottom <= m1.chat.top + 1, '영상 → 탭 → 채팅 순서로 겹치지 않음');
    await shot('m-chat.png');
    await js(`document.querySelector('#tab-queue').click()`); await wait(300);
    await shot('m-queue.png');
    await js(`document.querySelector('#tab-users').click()`); await wait(300);
    await shot('m-users.png');
    await js(`document.querySelector('#tab-chat').click()`);

    // 음성 참가 중(헤더 버튼이 가장 많은 상태): 큰 폰과 작은 폰에서 헤더가 낮고 채팅이 읽을 만큼 남아야 한다
    await js(`document.querySelector('#voiceBtn').click()`); await wait(900);
    for (const [w, h, minChat] of [[390, 844, 300], [360, 640, 140]]) {
      await view(w, h, true); await wait(500);
      const v = await js(`(() => ({ top: document.querySelector('.top').getBoundingClientRect().height, chat: document.querySelector('#chat').getBoundingClientRect().height, input: document.querySelector('#chatIn').getBoundingClientRect().bottom, vh: innerHeight, scroll: document.documentElement.scrollHeight - innerHeight, mic: !document.querySelector('#micBtn').hidden }))()`);
      console.log(`음성 참가 중 ${w}x${h}`);
      check(v.mic && v.top <= 130, `헤더가 ${Math.round(v.top)}px (두 줄 이하)`);
      check(v.chat >= minChat && v.input <= v.vh + 1 && v.scroll <= 0, `채팅 ${Math.round(v.chat)}px(>=${minChat}), 입력창이 화면 안, 페이지 스크롤 없음`);
      await shot(`m-voice-${w}.png`);
    }
    await js(`document.querySelector('#voiceBtn').click()`);
    await view(390, 844, true); await wait(300);

    // 가로 모드 폰
    await view(844, 390, true); await wait(600);
    const m2 = await js(`(() => ({ pageScroll: document.documentElement.scrollHeight - innerHeight, input: document.querySelector('#chatIn').getBoundingClientRect().bottom, vh: innerHeight, frameW: document.querySelector('#ytWrap').getBoundingClientRect().width }))()`);
    console.log('모바일 가로 844x390');
    check(m2.pageScroll <= 0 && m2.input <= m2.vh + 1, `영상 옆에 채팅 (입력창 bottom ${Math.round(m2.input)} / ${m2.vh})`);
    await shot('m-landscape.png');

    // 데스크톱
    await view(1280, 860, false); await wait(600);
    await shot('d-chat.png');
    await js(`document.querySelector('#tab-queue').click()`); await wait(300);
    await shot('d-queue.png');
    // ---- 테마 / 설정 창 / 의미색 버튼 ----
    console.log('테마와 설정 창');
    await js(`document.querySelector('#settingsBtn').click()`); await wait(400);
    await shot('d-settings.png');
    const dlg = await js(`(() => { const d = document.querySelector('#settings'); const b = d.getBoundingClientRect(); return { open: d.open, w: b.width, h: b.height, vh: innerHeight, cards: d.querySelectorAll('.tc').length }; })()`);
    check(dlg.open && dlg.cards === 15, `설정 창이 열리고 테마 카드 15개 (${dlg.cards}개)`);
    check(dlg.h <= dlg.vh, `설정 창이 화면 안에 들어옴 (${Math.round(dlg.h)} / ${dlg.vh})`);
    await js(`document.querySelector('#settings').close()`);
    const tone = (sel) => js(`(() => { const b = document.querySelector('${sel}'); const c = getComputedStyle(b); return { bg: c.backgroundColor, fg: c.color, cls: b.className }; })()`);
    for (const id of ['catppuccin-latte', 'dracula', 'solarized-light']) {
      await js(`applyTheme('${id}')`); await wait(300);
      const got = await js(`document.documentElement.dataset.theme + '|' + getComputedStyle(document.body).backgroundColor`);
      await shot('d-' + id + '.png');
      check(got.startsWith(id + '|'), `테마 적용: ${got}`);
    }
    await js(`applyTheme('auto')`);
    const share = await tone('#shareBtn'), voice = await tone('#voiceBtn');
    check(share.cls.includes('blue') && voice.cls.includes('go') && share.bg !== voice.bg, `공유=파랑(${share.bg}) / 음성=초록(${voice.bg})`);
    // 모바일 헤더: 음성 중일 때 버튼이 가장 많다 → 가로로 넘치지 않아야 한다
    await view(390, 844, true); await wait(400);
    await js(`document.querySelector('#micBtn').hidden = false`);
    const hdr = await js(`(() => { const t = document.querySelector('.top'); return { sw: t.scrollWidth, cw: t.clientWidth }; })()`);
    check(hdr.sw <= hdr.cw, `모바일 헤더가 넘치지 않음 (${hdr.sw} / ${hdr.cw})`);
    await js(`applyTheme('catppuccin-latte')`); await wait(300);
    await shot('m-latte.png');
    await js(`applyTheme('auto')`);
    console.log('페이지 예외:', errors.length ? errors : '없음'); if (errors.length) failed++;
    guest.close(); cdp.close();
  } finally { chrome.kill(); srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
