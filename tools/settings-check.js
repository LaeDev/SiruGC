// 설정 창(분류 목록 + 내용)을 실제 브라우저로 확인한다.
//  - PC: 왼쪽 분류 목록 + 오른쪽 내용, 폰: 분류 목록 → 내용(← 로 돌아오기)
//  - 첫 화면(입장 전)에서는 화면·앱 설치·정보만, 게스트에게는 알림이 빠지고, 관리자에게만 계정 관리가 보임
//  - 테마 17개를 작은 견본으로 고르고, 스위치·슬라이더가 실제로 값을 바꾸고 저장하며, 마지막으로 본 분류를 기억
//  - 폰(390px)과 PC(1280px)에서 넘치지 않고 터치 크기 이상
// 실행: node tools/settings-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능, SHOTS=폴더 로 화면 사진 저장)
const { AUTH_ENV, signup, loginJs, adminLogin } = require('./_auth');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 6300 + Math.floor(Math.random() * 90), CDP_PORT = 9500 + Math.floor(Math.random() * 90);
const SHOTS = process.env.SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `settings-${Date.now()}.json`);
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
    async function page(w, h, mobile, query = '') {
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      if (mobile) await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      const p = { js, call };
      p.rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, l: b.left, r: b.right, t: b.top, b: b.bottom }; })()`);
      p.tap = async (sel) => {
        await js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`); await wait(100);
        const r = await p.rect(sel); if (!r || !r.w) throw new Error('보이지 않음: ' + sel);
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await wait(200);
      };
      p.shot = async (name) => { if (!SHOTS) return; const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
      p.until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await wait(200); } return false; };
      p.open = async () => { await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/${query}` }); await wait(1500); };
      p.enter = async (name) => { await js(`(() => { document.querySelector('#nameIn').value = ${JSON.stringify(name)}; document.querySelector('#joinForm').requestSubmit(); })()`); await p.until(`joined`); await wait(600); };
      p.tabs = () => js(`[...document.querySelectorAll('#setNav .set-tab')].map((b) => b.querySelector('span').textContent)`);
      p.visiblePages = () => js(`[...document.querySelectorAll('.set-page')].filter((s) => s.getBoundingClientRect().height > 0).map((s) => s.id)`);
      return p;
    }
    const overflow = `(() => { const d = document.querySelector('#settings'), pane = document.querySelector('#setPane'); return d.scrollWidth > d.clientWidth + 1 || pane.scrollWidth > pane.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth; })()`;
    const pagesOf = ['look', 'voice', 'notif', 'hide', 'acct', 'app'];
    // 설정 페이지의 배치를 숫자로 잰다: 접는 칸 제목·줄의 위아래 가운데, 이름과 꼬리표 높이, 덩어리 사이 간격, 왼쪽 정렬
    const layoutJs = `(() => {
      const bad = [], page = document.querySelector('.set-page.on'); if (!page) return ['열린 페이지 없음'];
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const mid = (r) => r.top + r.height / 2;
      const textMid = (e) => { const g = document.createRange(); g.selectNodeContents(e); const rs = [...g.getClientRects()].filter((r) => r.width > 0 && r.height > 0); if (!rs.length) return null; const t = Math.min(...rs.map((r) => r.top)), b = Math.max(...rs.map((r) => r.bottom)); return (t + b) / 2; };
      for (const d of page.querySelectorAll('details.sub')) {
        if (!vis(d)) continue; const sm = d.querySelector(':scope > summary'), tm = textMid(sm), r = sm.getBoundingClientRect();
        if (tm !== null && Math.abs(tm - mid(r)) > 2.5) bad.push('접는 칸 제목이 위아래 가운데가 아님: ' + sm.textContent.trim() + ' (' + Math.round(tm - mid(r)) + 'px)');
        if (!d.open && Math.abs(d.getBoundingClientRect().height - r.height) > 4) bad.push('접힌 칸 아래에 빈 공간: ' + sm.textContent.trim());
        if (Math.abs(mid(d.getBoundingClientRect()) - mid(r)) > 4 && !d.open) bad.push('접힌 칸의 제목이 칸 가운데가 아님: ' + sm.textContent.trim());
      }
      for (const row of page.querySelectorAll('.srow:not(.stack):not(.rng)')) {
        if (!vis(row)) continue; const st = row.querySelector('.st'), ctl = row.querySelector('input.swt, button, select'); if (!st || !ctl || !vis(ctl)) continue;
        const a = mid(st.getBoundingClientRect()), b = mid(ctl.getBoundingClientRect()), box = mid(row.getBoundingClientRect());
        if (Math.abs(a - b) > 3 || Math.abs(a - box) > 3) bad.push('줄의 이름과 컨트롤이 위아래 가운데가 아님: ' + st.textContent.trim().slice(0, 14));
        if (ctl.tagName === 'BUTTON' && ctl.getBoundingClientRect().height > 48) bad.push('줄의 버튼 글자가 여러 줄로 꺾임: ' + ctl.textContent.trim());
      }
      for (const li of page.querySelectorAll('.acctlist li')) {
        const first = li.firstElementChild, nm = first?.querySelector('.nm'), tags = [...first.querySelectorAll('.tag')]; if (!nm) continue;
        const nmMid = textMid(nm); for (const t of tags) if (Math.abs(mid(t.getBoundingClientRect()) - nmMid) > 3) bad.push('계정 목록: 이름과 꼬리표 높이가 안 맞음: ' + t.textContent);
      }
      // 덩어리 사이 간격: 같은 부모의 보이는 자식끼리 8~28px, 겹치면 안 됨
      const groups = [page, ...page.querySelectorAll('.setbox')].filter(vis);
      for (const g of groups) {
        const kids = [...g.children].filter(vis);
        for (let i = 1; i < kids.length; i++) {
          const gap = kids[i].getBoundingClientRect().top - kids[i - 1].getBoundingClientRect().bottom;
          const name = (kids[i - 1].id || kids[i - 1].className || kids[i - 1].tagName) + ' → ' + (kids[i].id || kids[i].className || kids[i].tagName);
          if (gap < 7 || gap > 28) bad.push('덩어리 사이 간격 ' + Math.round(gap) + 'px (' + name + ')');
        }
      }
      // 왼쪽 정렬: 묶음·접는 칸·설명·소제목이 같은 왼쪽 줄
      const lefts = [...page.querySelectorAll(':scope > .sgroup, :scope > details, :scope > .note, :scope > .gt, :scope > .setbox')].filter(vis).map((e) => Math.round(e.getBoundingClientRect().left));
      if (lefts.length && Math.max(...lefts) - Math.min(...lefts) > 1) bad.push('왼쪽 줄이 안 맞음: ' + [...new Set(lefts)].join(','));
      return bad;
    })()`;
    const allLayout = async (p, cats, label) => {
      const out = [];
      for (const cat of cats) {
        await p.js(`setPage('${cat}')`); await wait(150);
        for (const d of await p.js(`[...document.querySelectorAll('.set-page.on details.sub')].map((_, i) => i)`)) {
          for (const open of [false, true]) { await p.js(`document.querySelectorAll('.set-page.on details.sub')[${d}].open = ${open}`); await wait(60); const b = await p.js(layoutJs); out.push(...b.map((x) => label + ' ' + cat + (open ? '(펼침)' : '') + ': ' + x)); }
          await p.js(`document.querySelectorAll('.set-page.on details.sub')[${d}].open = false`);
        }
        const b = await p.js(layoutJs); out.push(...b.map((x) => label + ' ' + cat + ': ' + x));
      }
      return out;
    };


    console.log('입장 전 (첫 화면의 테마·설정)');
    const J = await page(1280, 860, false, '?step=profile'); await J.open();
    await J.tap('#joinSettings');
    check(JSON.stringify(await J.tabs()) === JSON.stringify(['화면', '앱 설치·정보']), '입장 전에는 "화면"과 "앱 설치·정보"만 보임');
    check(JSON.stringify(await J.visiblePages()) === '["pgLook"]', '화면 분류의 내용이 열려 있음');
    await J.shot('0-prejoin');
    await J.js(`closeSettings()`);

    const J2 = await page(1280, 860, false, '?step=profile'); await J2.open(); await J2.js(loginJs(await signup(PORT, '설정입장전'))); await wait(400);
    await J2.tap('#joinSettings');
    check(JSON.stringify(await J2.tabs()) === JSON.stringify(['화면', '계정', '앱 설치·정보']), '입장 전이라도 로그인한 사람은 계정 분류가 보임 (닉네임·비밀번호·삭제를 만질 수 있게)');
    await J2.js(`closeSettings()`);

    console.log('PC (1280px): 게스트');
    const D = await page(1280, 860, false, '?step=profile'); await D.open(); await D.enter('설정게스트');
    await D.tap('#settingsBtn');
    check(JSON.stringify(await D.tabs()) === JSON.stringify(['화면', '음성', '숨기기', '계정', '앱 설치·정보']), '게스트에게는 알림 분류가 빠져 있음');
    check(await D.js(`(() => { const n = document.querySelector('#setNav').getBoundingClientRect(), p = document.querySelector('#setPane').getBoundingClientRect(); return n.right <= p.left + 1 && n.width >= 180 && getComputedStyle(document.querySelector('#setBack')).display === 'none'; })()`), '왼쪽에 분류 목록, 오른쪽에 내용 (← 버튼은 없음)');
    check(await D.js(`document.querySelector('#setNav [aria-current=page]').textContent.startsWith('화면') && document.querySelector('#setTitle').textContent === '설정'`), '처음에는 "화면"이 선택돼 있음');
    check(await D.js(`document.querySelectorAll('#themeGrid .tc').length === 18`), '테마가 18개 (기기 설정 따르기·나만의 테마 + 다크 9 + 라이트 7)');
    check(await D.js(`[...document.querySelectorAll('#themeGrid .tc')].every((c) => { const b = c.getBoundingClientRect(); return b.height >= 44 && (c.classList.contains('auto') || b.width >= 44); })`), '테마 견본이 터치 크기(44px) 이상');
    await D.shot('1-look-desktop');
    await D.tap('#themeGrid input[value="nord"]');
    check(await D.js(`document.documentElement.dataset.theme === 'nord' && document.querySelectorAll('#themeGrid .tc.sel').length === 1 && document.querySelector('#themeCap').textContent === 'Nord' && get('theme') === 'nord'`), '테마를 누르면 바로 적용·저장되고 이름이 표시됨');
    await D.js(`applyTheme('auto'); markThemeCard()`);
    check(await D.js(`document.querySelector('#themeCap').textContent.startsWith('기기 설정 따르기 · 지금은')`), '"기기 설정 따르기"는 지금 어느 쪽인지 알려 줌');
    for (const [cat, pg] of [['voice', 'pgVoice'], ['hide', 'pgHide'], ['acct', 'pgAcct'], ['app', 'pgApp']]) {
      await D.tap(`#setNav [data-cat=${cat}]`);
      check(JSON.stringify(await D.visiblePages()) === JSON.stringify([pg]) && !(await D.js(overflow)), `"${cat}" 분류를 누르면 그 내용만 보이고 넘치지 않음`);
      await D.shot('2-' + cat + '-desktop');
    }
    check(await D.js(`!document.querySelector('#acctGuest').hidden && document.querySelector('#acctIn').hidden && document.querySelector('#adminSec').hidden`), '게스트의 계정 분류: 로그인 안내만, 관리자 메뉴는 없음');

    { const iss = await allLayout(D, ['look', 'voice', 'hide', 'acct', 'app'], '게스트 PC'); check(!iss.length, '게스트 PC: 모든 분류의 간격과 가운데 맞춤이 규칙 안' + (iss.length ? ' → ' + iss.slice(0, 6).join(' | ') : '')); }
    console.log('스위치·슬라이더·마지막 분류 기억');
    await D.tap('#setNav [data-cat=voice]');
    const ns0 = await D.js(`voicePrefs.ns`);
    await D.tap('#nsOn');
    check(await D.js(`voicePrefs.ns === ${!ns0} && JSON.parse(localStorage.getItem('voicePrefs')).ns === ${!ns0} && document.querySelector('#nsOn').checked === ${!ns0}`), 'AI 잡음 억제 스위치를 누르면 값이 바뀌고 저장됨');
    check(await D.js(`(() => { const b = document.querySelector('#nsOn').getBoundingClientRect(); return b.width >= 44 && b.height >= 26; })()`), '스위치 크기가 충분함');
    await D.js(`(() => { const s = document.querySelector('#nsAmt'); s.value = 40; s.dispatchEvent(new Event('input')); })()`);
    check(await D.js(`voicePrefs.nsAmt === 40 && document.querySelector('#nsAmtOut').textContent === '40%'`), '억제 강도 슬라이더가 값과 표시에 반영됨');
    await D.js(`closeSettings()`); await D.tap('#settingsBtn');
    check(await D.js(`document.querySelector('#setNav [aria-current=page]').textContent.startsWith('음성') && get('setPage') === 'voice'`), '다시 열면 마지막으로 보던 분류가 열림');
    await D.js(`closeSettings()`);

    console.log('PC: 로그인한 사람, 관리자');
    const A = await signup(PORT, '설정회원');
    const U = await page(1280, 860, false, '?step=profile'); await U.open(); await U.js(loginJs(A)); await wait(400); await U.js(`document.querySelector('#joinForm').requestSubmit()`); await U.until(`joined`); await wait(600);
    await U.tap('#settingsBtn');
    check(JSON.stringify(await U.tabs()) === JSON.stringify(['화면', '음성', '알림', '숨기기', '계정', '앱 설치·정보']), '로그인한 사람에게는 알림 분류도 보임');
    await U.tap('#setNav [data-cat=notif]'); await U.shot('3-notif-desktop');
    check(JSON.stringify(await U.visiblePages()) === '["notifSec"]', '알림 분류의 내용이 보임');
    await U.tap('#setNav [data-cat=acct]'); await U.shot('4-acct-desktop');
    check(await U.js(`!document.querySelector('#acctIn').hidden && document.querySelector('#acctGuest').hidden && document.querySelector('#adminSec').hidden && !document.querySelector('.danger-zone').open`), '계정 분류: 내 정보가 보이고 관리자 메뉴는 없고, 위험 구역은 접혀 있음');
    await U.js(`document.querySelector('.danger-zone > summary').click()`); await wait(200);
    check(await U.js(`['#logoutAllBtn', '#delPw'].every((s) => !!document.querySelector(s))`) , '위험 구역 안에 모든 기기 로그아웃과 계정 삭제가 있음');
    { await U.js(`closeSettings()`); await U.tap('#settingsBtn'); const iss = await allLayout(U, ['look', 'voice', 'notif', 'hide', 'acct', 'app'], '회원 PC'); check(!iss.length, '회원 PC: 모든 분류의 간격과 가운데 맞춤이 규칙 안' + (iss.length ? ' → ' + iss.slice(0, 6).join(' | ') : '')); }
    const adm = await adminLogin(PORT);
    const M = await page(1280, 860, false, '?step=profile'); await M.open(); await M.js(loginJs({ ...adm, password: AUTH_ENV.ADMIN_PASSWORD })); await wait(400); await M.js(`document.querySelector('#joinForm').requestSubmit()`); await M.until(`joined`); await wait(800);
    await M.tap('#settingsBtn'); await M.tap('#setNav [data-cat=acct]'); await M.shot('5-admin-desktop');
    check(await M.js(`!document.querySelector('#adminSec').hidden`), '관리자에게는 계정 관리가 계정 분류 안에 보임');
    await M.js(`document.querySelector('#acctList').scrollIntoView({ block: 'end' })`); await wait(200); await M.shot('5b-admin-list-desktop');
    { const iss = await allLayout(M, ['acct'], '관리자 PC'); check(!iss.length, '관리자 PC: 계정(계정 관리 포함)의 간격과 가운데 맞춤이 규칙 안' + (iss.length ? ' → ' + iss.slice(0, 6).join(' | ') : '')); }

    console.log('폰 (390px): 목록 → 내용');
    const P = await page(390, 844, true, '?step=profile'); await P.open(); await P.js(loginJs(await signup(PORT, '설정폰'))); await wait(400); await P.js(`document.querySelector('#joinForm').requestSubmit()`); await P.until(`joined`); await wait(800);
    await P.tap('#settingsBtn');
    check(await P.js(`document.querySelector('#settings').dataset.view === 'list' && getComputedStyle(document.querySelector('#setPane')).display === 'none' && getComputedStyle(document.querySelector('#setBack')).display === 'none'`), '폰에서는 분류 목록이 먼저 보임');
    check(await P.js(`[...document.querySelectorAll('#setNav .set-tab')].every((b) => { const r = b.getBoundingClientRect(); return r.height >= 44 && r.left >= 0 && r.right <= innerWidth && b.querySelector('.set-sum').getBoundingClientRect().width > 0 || b.querySelector('.set-sum').textContent === ''; })`), '분류 줄이 터치 크기 이상이고 화면 안에 있으며 지금 상태(요약)가 같이 보임');
    check(await P.js(`document.querySelector('#setNav [data-cat=acct] .set-sum').textContent === '설정폰' && ['켜짐', '꺼짐'].includes(document.querySelector('#setNav [data-cat=notif] .set-sum').textContent)`), '요약: 계정은 내 닉네임, 알림은 켜짐/꺼짐');
    await P.shot('6-list-phone');
    await P.tap('#setNav [data-cat=voice]');
    check(await P.js(`document.querySelector('#settings').dataset.view === 'page' && document.querySelector('#setTitle').textContent === '음성' && getComputedStyle(document.querySelector('#setBack')).display !== 'none' && getComputedStyle(document.querySelector('#setNav')).display === 'none'`), '분류를 누르면 내용으로 들어가고 제목이 바뀌고 ← 버튼이 생김');
    check(!(await P.js(overflow)), '폰 내용이 가로로 넘치지 않음');
    await P.shot('7-voice-phone');
    check(await P.js(`['#nsOn', '#ecOn', '#agcOn', '#monOn', '#setBack', '#setClose'].every((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.width >= 44 && r.height >= 26 && r.left >= 0 && r.right <= innerWidth; })`), '폰에서 스위치와 버튼이 화면 안에 있고 누를 수 있는 크기');
    await P.tap('#setBack');
    check(await P.js(`document.querySelector('#settings').dataset.view === 'list' && document.querySelector('#setTitle').textContent === '설정'`), '← 를 누르면 분류 목록으로 돌아옴');
    for (const cat of ['look', 'notif', 'hide', 'acct', 'app']) {
      await P.tap(`#setNav [data-cat=${cat}]`);
      const bad = await P.js(overflow);
      if (SHOTS) await P.shot('8-' + cat + '-phone');
      check(!bad, `폰 "${cat}" 분류가 넘치지 않음`);
      await P.tap('#setBack');
    }
    { const iss = await allLayout(P, ['look', 'voice', 'notif', 'hide', 'acct', 'app'], '폰'); check(!iss.length, '폰: 모든 분류의 간격과 가운데 맞춤이 규칙 안' + (iss.length ? ' → ' + iss.slice(0, 6).join(' | ') : '')); }
    await P.js(`closeSettings()`);
    browser.close();
  } catch (e) { console.log('  실패 예외:', e.stack || e); failed++; }
  finally {
    srv.kill(); try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} await wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(state, { force: true }); } catch {}
  }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})();
