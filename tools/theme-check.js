// 나만의 테마(배경색·강조색), 내 사진 배경 이미지, 채팅 글자 크기 미리보기를 실제 브라우저로 확인한다.
//  - 색을 고르면 바로 적용·저장되고, 글자·보조 글자·강조 글자·버튼 글자가 배경과 4.5:1 이상 대비를 가짐 (여러 색 조합으로)
//  - 다시 열어도 처음 그릴 때부터 그 색이 적용돼 있음 (깜빡임 없음)
//  - 사진을 고르면 배경으로 깔리고(어둡게·흐리게·패널 불투명도 조절), 다시 열어도 남아 있고, 지우면 사라짐 (사진은 이 기기 안에만 저장)
//  - 채팅 글자 크기 슬라이더를 움직이면 미리보기의 글자도 같이 바뀜
// 실행: node tools/theme-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능, SHOTS=폴더 로 화면 사진 저장)
const { AUTH_ENV } = require('./_auth');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 6700 + Math.floor(Math.random() * 90), CDP_PORT = 9900 + Math.floor(Math.random() * 90);
const SHOTS = process.env.SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

// 시험용 사진(그라데이션 PNG)을 직접 만든다
function makePng(w, h, file) {
  const crc = (buf) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const b of buf) r = t[(r ^ b) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = Math.round((x / w) * 255); raw[o + 1] = Math.round((y / h) * 255); raw[o + 2] = 160; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

(async () => {
  const state = path.join(os.tmpdir(), `theme-${Date.now()}.json`), png = path.join(os.tmpdir(), `bg-${Date.now()}.png`);
  makePng(2400, 1500, png);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...AUTH_ENV, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
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
    await call('Page.enable'); await call('Runtime.enable'); await call('DOM.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
    const shot = async (name) => { if (!SHOTS) return; const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
    const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await wait(150); } return false; };
    const open = async () => { await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/?step=profile` }); await wait(1500); };
    const guest = async (name) => { await js(`(() => { document.querySelector('#nameIn').value = ${JSON.stringify(name)}; document.querySelector('#joinForm').requestSubmit(); })()`); await until('joined'); await wait(500); };
    const setColor = (id, hex) => js(`(() => { const i = document.querySelector('${id}'); i.value = '${hex}'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const tok = (k) => js(`getComputedStyle(document.documentElement).getPropertyValue('${k}').trim()`);

    await open(); await guest('테마점검');
    await js(`openSettings(); setPage('look')`); await wait(300);

    console.log('나만의 테마');
    check(await js(`document.querySelectorAll('#themeGrid .tc').length === 18 && !!document.querySelector('#themeGrid input[value="custom"]')`), '테마 견본이 18개 (나만의 테마 포함)');
    await setColor('#cuBg', '#102a43'); await setColor('#cuAcc', '#ff7a45'); await wait(200);
    check(await js(`document.documentElement.dataset.theme === 'custom' && get('theme') === 'custom' && document.querySelector('#themeGrid input[value="custom"]').checked`), '색을 고르면 바로 나만의 테마로 바뀜');
    check((await tok('--bg')) === '#102a43' && (await tok('--accent')) === '#ff7a45', '고른 배경색과 강조색이 적용됨');
    check(await js(`getComputedStyle(document.body).backgroundColor === 'rgb(16, 42, 67)'`), '화면 바탕이 실제로 그 색');
    await shot('1-custom-dark');
    // 여러 색 조합에서 글자 대비 (설정 화면의 함수로 계산한 값을, 여기서 따로 다시 계산해 본다)
    const combos = []; const hex = (n) => '#' + n.toString(16).padStart(6, '0');
    for (const bg of [0x000000, 0xffffff, 0x777777, 0x102a43, 0xfff3e0, 0x2d1b3d, 0x808080, 0xf4f4f4, 0x3b3b00, 0xc0c0ff]) for (const ac of [0xff0000, 0x00ff00, 0x0000ff, 0x777777, 0xffee00, 0x222222, 0xffffff, 0x4f5bd5]) combos.push([hex(bg), hex(ac)]);
    const bad = await js(`(() => { const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
      const ct = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const out = []; for (const [bg, ac] of ${JSON.stringify(combos)}) { const t = customTokens({ bg, accent: ac });
        const pairs = [['글자', t['--text'], t['--bg']], ['글자(패널)', t['--text'], t['--surface']], ['글자(진한 패널)', t['--text'], t['--surface-2']], ['보조 글자', t['--muted'], t['--bg']], ['보조 글자(진한 패널)', t['--muted'], t['--surface-2']], ['강조 글자', t['--accent-text'], t['--bg']], ['강조 글자(진한 패널)', t['--accent-text'], t['--surface-2']], ['버튼 글자', t['--on-accent'], t['--accent']]];
        for (const [n, a, b] of pairs) if (ct(a, b) < 4.5) out.push(n + ' ' + bg + '/' + ac + ' ' + ct(a, b).toFixed(2)); } return out; })()`);
    check(bad.length === 0, '여러 색 조합(' + combos.length + '가지)에서 글자·보조 글자·강조 글자·버튼 글자가 모두 4.5:1 이상 대비' + (bad.length ? ' → ' + bad.slice(0, 4).join(' | ') : ''));
    await setColor('#cuBg', '#fff3e0'); await setColor('#cuAcc', '#0b6bcb'); await wait(200);
    check(await js(`getComputedStyle(document.documentElement).colorScheme === 'light' && getComputedStyle(document.body).color !== getComputedStyle(document.body).backgroundColor`), '밝은 배경을 고르면 글자가 어두워지고 밝은 모드로 바뀜');
    await shot('2-custom-light');
    // 다시 열면 처음부터 적용 (깜빡임 없음): 문서가 만들어지자마자 html 에 색이 들어 있어야 한다
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded', () => { window.__early = document.documentElement.style.getPropertyValue('--bg') + '|' + document.documentElement.dataset.theme; });` });
    await open();
    check((await js(`window.__early`)) === '#fff3e0|custom', '다시 열면 스크립트가 도는 첫 순간부터 나만의 테마 색이 적용돼 있음 (' + (await js(`window.__early`)) + ')');
    check((await tok('--accent')) === '#0b6bcb', '강조색도 그대로');
    await js(`openSettings(); setPage('look')`); await wait(200);
    check(await js(`document.querySelector('#cuBg').value === '#fff3e0' && document.querySelector('#cuAcc').value === '#0b6bcb' && !!document.querySelector('#themeGrid .tc.sel')?.textContent.includes('나만의 테마')`), '색 고르는 칸과 선택 표시도 저장된 값으로 열림');
    await js(`document.querySelector('#themeGrid input[value="nord"]').click()`); await wait(200);
    check(!(await js(`document.documentElement.style.getPropertyValue('--bg')`)) && (await tok('--bg')) !== '#fff3e0', '다른 테마를 고르면 나만의 색이 깨끗이 빠짐 (남는 색 없음)');
    await js(`document.querySelector('#cuReset').click()`); await wait(200);
    check((await tok('--bg')) === '#1e1f22' && (await tok('--accent')) === '#4f5bd5', '"되돌리기"는 기본 색으로');

    console.log('배경 이미지');
    const root = (await call('DOM.getDocument')).result.root.nodeId, node = (await call('DOM.querySelector', { nodeId: root, selector: '#bgFile' })).result.nodeId;
    check(await js(`document.querySelector('#bgClear').hidden && [...document.querySelectorAll('#bgBox .bgopt')].every((r) => r.hidden)`), '사진이 없을 때는 지우기와 조절 칸이 숨겨져 있음');
    await call('DOM.setFileInputFiles', { nodeId: node, files: [png] });
    check(await until(`document.documentElement.classList.contains('has-bg') && getComputedStyle(document.documentElement).getPropertyValue('--bg-img').includes('blob:')`, 10000), '사진을 고르면 배경으로 깔림');
    check(await js(`!document.querySelector('#bgClear').hidden && [...document.querySelectorAll('#bgBox .bgopt')].every((r) => !r.hidden) && document.querySelector('#bgPick').textContent === '사진 바꾸기'`), '지우기와 어둡게·흐리게·패널 불투명도 조절이 나타남');
    const size = await js(`bgIdb('readonly', (s) => s.get('bg')).then((b) => b ? createImageBitmap(b).then((x) => [x.width, x.height, b.size]) : null)`);
    check(size && Math.max(size[0], size[1]) <= 1920 && size[2] < 2e6, '저장된 사진은 가장 긴 변 1920px 이하로 줄어 있음 (' + (size && size.join('x')) + ')');
    check(await js(`getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)'`) && await js(`(() => { const c = getComputedStyle(document.querySelector('.side')).backgroundColor, m = /\\/\\s*([0-9.]+)\\)|rgba\\([^)]*,\\s*([0-9.]+)\\)/.exec(c); return !!m && +(m[1] || m[2]) < 1; })()`), '바탕은 투명해져 사진이 보이고, 오른쪽 패널은 살짝 비치는 반투명');
    await shot('3-bg');
    await js(`(() => { const r = document.querySelector('#bgDim'); r.value = 80; r.dispatchEvent(new Event('input')); const b = document.querySelector('#bgBlur'); b.value = 10; b.dispatchEvent(new Event('input')); const s = document.querySelector('#bgSurf'); s.value = 60; s.dispatchEvent(new Event('input')); })()`);
    check((await tok('--bg-dim')) === '80%' && (await tok('--bg-blur')) === '10px' && (await tok('--bg-surf')) === '60%' && await js(`JSON.parse(get('bgOpts')).dim === 80`), '어둡게·흐리게·패널 불투명도가 바로 적용되고 저장됨');
    await js(`closeSettings()`); await shot('3b-bg-tuned');
    await open();
    check(await until(`document.documentElement.classList.contains('has-bg') && getComputedStyle(document.documentElement).getPropertyValue('--bg-img').includes('blob:')`, 8000), '다시 열어도 사진이 그대로 깔려 있음 (이 기기에 저장됨)');
    check(await js(`document.documentElement.classList.contains('has-bg')`), '(첫 화면에서도 사진이 보임)');
    await shot('3c-join-bg');
    await js(`openSettings(); setPage('look')`); await wait(200);
    await js(`document.querySelector('#bgClear').click()`); await wait(400);
    check(await js(`!document.documentElement.classList.contains('has-bg') && document.querySelector('#bgClear').hidden`) && !(await js(`bgIdb('readonly', (s) => s.get('bg'))`)), '"지우기"를 누르면 사진이 사라지고 기기에서도 지워짐');

    console.log('채팅 글자 크기 미리보기');
    const fs0 = await js(`parseFloat(getComputedStyle(document.querySelector('#lookPrev .bubble p')).fontSize)`);
    await js(`(() => { const r = document.querySelector('#chatSize'); r.value = 3; r.dispatchEvent(new Event('input')); })()`);
    const fs3 = await js(`parseFloat(getComputedStyle(document.querySelector('#lookPrev .bubble p')).fontSize)`);
    await js(`(() => { const r = document.querySelector('#chatSize'); r.value = 0; r.dispatchEvent(new Event('input')); })()`);
    const fs1 = await js(`parseFloat(getComputedStyle(document.querySelector('#lookPrev .bubble p')).fontSize)`);
    check(fs1 === 14 && fs0 === 16 && fs3 === 21, `슬라이더를 움직이면 미리보기 글자가 작게 ${fs1}px → 보통 ${fs0}px → 아주 크게 ${fs3}px 로 바뀜`);
    check(await js(`(() => { const p = document.querySelector('#lookPrev').getBoundingClientRect(), d = document.querySelector('#setPane').getBoundingClientRect(); return p.width > 200 && p.right <= d.right + 1; })()`), '미리보기가 설정 창 안에 들어옴');
    await js(`document.querySelector('#lookPrev').scrollIntoView({ block: 'center' })`); await shot('4-chat-preview');
    browser.close();
  } catch (e) { console.log('  실패 예외:', e.stack || e); failed++; }
  finally {
    srv.kill(); try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} await wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(state, { force: true }); fs.rmSync(png, { force: true }); } catch {}
  }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})();
