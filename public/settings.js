/* ================= 설정 창: 테마 ================= */
const THEME_GROUPS = [
  ['다크', [['flat-dark', '플랫 다크'], ['lamp-dark', '램프'], ['dracula', 'Dracula'], ['nord', 'Nord'], ['solarized-dark', 'Solarized Dark'], ['gruvbox-dark', 'Gruvbox Dark'],
    ['catppuccin-mocha', 'Catppuccin Mocha'], ['tokyo-night', 'Tokyo Night'], ['rose-pine', 'Rosé Pine']]],
  ['라이트', [['flat-light', '플랫 라이트'], ['lamp-light', '램프'], ['nord-light', 'Nord Light'], ['solarized-light', 'Solarized Light'], ['gruvbox-light', 'Gruvbox Light'],
    ['catppuccin-latte', 'Catppuccin Latte'], ['rose-pine-dawn', 'Rosé Pine Dawn']]],
];
const settingsDlg = $('#settings');

function syncThemeColor() { // 휴대폰 주소창 색
  $('meta[name=theme-color]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
}
function applyTheme(id) {
  if (id === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = id;
  set('theme', id);
  if (id === 'custom') applyCustomVars(); else clearCustomVars();
  syncThemeColor();
}
const THEME_NAME = Object.fromEntries([['auto', '기기 설정 따르기'], ['custom', '나만의 테마'], ...THEME_GROUPS.flatMap(([, list]) => list)]);
function themeCap() {
  const cur = get('theme') || 'auto', c = $('#themeCap');
  if (c) c.textContent = cur === 'auto' ? `기기 설정 따르기 · 지금은 ${matchMedia('(prefers-color-scheme: light)').matches ? '라이트(플랫 라이트)' : '다크(플랫 다크)'}` : THEME_NAME[cur] || cur;
}
/* ---------- 나만의 테마: 배경색·강조색 두 가지로 나머지 색을 계산 ---------- */
const CUSTOM_DEFAULT = { bg: '#1e1f22', accent: '#4f5bd5' };
let custom = { ...CUSTOM_DEFAULT };
try { Object.assign(custom, JSON.parse(get('themeCustom') || '{}')); } catch {}
const cRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
const cHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const cLum = (c) => { const l = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * l(c[0]) + 0.7152 * l(c[1]) + 0.0722 * l(c[2]); };
const cContrast = (a, b) => { const [x, y] = [cLum(a), cLum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const cMix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t)); // (화면에 쓰는 정수 색 그대로 대비를 재도록 바로 반올림한다)
function customTokens(c) { // 글자·보조 글자·강조 글자는 배경과 패널(--surface-2) 모두에서 4.5:1 이상 대비가 나오도록 맞춘다 (WCAG AA)
  const B = cRgb(c.bg) || cRgb(CUSTOM_DEFAULT.bg), A = cRgb(c.accent) || cRgb(CUSTOM_DEFAULT.accent), dark = cLum(B) < 0.4;
  const light = [242, 243, 245], ink = [27, 28, 32], white = [255, 255, 255], black = [0, 0, 0];
  let text = cContrast(B, light) >= cContrast(B, ink) ? light : ink; // 부드러운 색을 먼저
  if (cContrast(B, text) < 7) { const alt = cContrast(B, white) >= cContrast(B, black) ? white : black; if (cContrast(B, alt) > cContrast(B, text)) text = alt; } // 중간 밝기 배경은 순수 흰색/검정이라야 대비가 나온다
  // 패널·테두리는 보통 어두운 배경이면 더 밝게, 밝은 배경이면 더 어둡게. 그래서 글자 대비가 모자라면 반대쪽으로, 그래도 모자라면 배경과 같은 색으로 둔다
  let surface = B, s2 = B, line = cMix(B, text, 0.25);
  for (const hi of dark ? [white, black] : [black, white]) {
    const su = cMix(B, hi, dark ? 0.06 : 0.04), sb = cMix(B, hi, dark ? 0.13 : 0.09);
    if (cContrast(text, su) >= 4.5 && cContrast(text, sb) >= 4.5) { surface = su; s2 = sb; line = cMix(B, hi, dark ? 0.24 : 0.2); break; }
  }
  const both = (x) => Math.min(cContrast(x, B), cContrast(x, s2));
  let muted = cMix(text, B, 0.35); for (let t = 0.3; both(muted) < 4.5 && t > 0; t -= 0.05) muted = cMix(text, B, t);
  let at = A; for (let t = 0; both(at) < 4.5 && t <= 1.001; t += 0.1) at = cMix(A, text, t);
  const onAcc = cContrast(A, white) >= cContrast(A, black) ? white : black;
  return {
    '--bg': cHex(B), '--surface': cHex(surface), '--surface-2': cHex(s2), '--line': cHex(line),
    '--text': cHex(text), '--muted': cHex(muted), '--accent': cHex(A), '--on-accent': cHex(onAcc), '--accent-text': cHex(at), '--focus': cHex(at),
    '--danger': dark ? '#fa777c' : '#c62d37', '--on-danger': dark ? '#2a0509' : '#ffffff', '--ok': dark ? '#4ade80' : '#15803d', '--on-ok': dark ? '#06220f' : '#ffffff',
    '--info': dark ? '#6ea8ff' : '#1d4ed8', '--on-info': dark ? '#061a3a' : '#ffffff', 'color-scheme': dark ? 'dark' : 'light', '--r-ctl': '8px', '--r-box': '12px',
  };
}
function clearCustomVars() { try { for (const k of Object.keys(JSON.parse(get('themeVars') || '{}'))) document.documentElement.style.removeProperty(k); } catch {} set('themeVars', ''); }
function applyCustomVars() {
  clearCustomVars();
  const v = customTokens(custom), r = document.documentElement.style;
  for (const [k, x] of Object.entries(v)) r.setProperty(k, x);
  set('themeVars', JSON.stringify(v)); set('themeCustom', JSON.stringify(custom));
}
function customUi() { $('#cuBg').value = cHex(cRgb(custom.bg) || cRgb(CUSTOM_DEFAULT.bg)); $('#cuAcc').value = cHex(cRgb(custom.accent) || cRgb(CUSTOM_DEFAULT.accent)); }

function markThemeCard() { document.querySelectorAll('#themeGrid .tc').forEach((c) => c.classList.toggle('sel', c.querySelector('input').checked)); themeCap(); }
function themeCard(id, name) {
  const pill = id === 'auto' || id === 'custom';
  const card = el('label', { className: 'tc' + (pill ? ' auto pill' : '') + (id === 'custom' ? ' custom' : ''), title: name },
    el('input', { type: 'radio', name: 'theme', value: id, checked: (get('theme') || 'auto') === id, onchange: () => { applyTheme(id); markThemeCard(); } }),
    el('span', { className: 'tc-n', textContent: name }));
  if (!pill) card.dataset.theme = id; // 견본 자체를 그 테마의 색으로 그린다
  return card;
}
{
  const grid = $('#themeGrid');
  grid.append(el('div', { className: 'tgroup' }, themeCard('auto', '기기 설정 따르기'), themeCard('custom', '나만의 테마')));
  for (const [group, list] of THEME_GROUPS) grid.append(el('p', { className: 'tgl', textContent: group }), el('div', { className: 'tgroup' }, ...list.map(([id, name]) => themeCard(id, name))));
  grid.append(el('p', { className: 'theme-cap', id: 'themeCap', role: 'status' }));
}
markThemeCard();
customUi();
function useCustom() { // 색을 만지면 나만의 테마로 바로 바꾼다
  const radio = $('#themeGrid input[value="custom"]'); radio.checked = true; applyTheme('custom'); markThemeCard();
}
$('#cuBg').oninput = (e) => { custom.bg = e.target.value; useCustom(); };
$('#cuAcc').oninput = (e) => { custom.accent = e.target.value; useCustom(); };
$('#cuReset').onclick = () => { custom = { ...CUSTOM_DEFAULT }; customUi(); useCustom(); };

/* ---------- 배경 이미지: 내 사진을 기기 안(IndexedDB)에만 저장해서 맨 뒤에 깐다 ---------- */
const bgIdb = async (mode, fn) => {
  const db = await new Promise((ok, no) => { const r = indexedDB.open('siru-theme', 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  return new Promise((ok, no) => { const tx = db.transaction('k', mode), req = fn(tx.objectStore('k')); tx.oncomplete = () => { db.close(); ok(req.result); }; tx.onerror = tx.onabort = () => no(tx.error); });
};
let bgUrl = '';
const bgOpts = () => { let o = {}; try { o = JSON.parse(get('bgOpts') || '{}'); } catch {} return { on: false, dim: 55, blur: 0, surf: 85, ...o }; };
const bgSave = (o) => set('bgOpts', JSON.stringify(o));
function bgApply(blob) {
  const root = document.documentElement, o = bgOpts();
  if (bgUrl) URL.revokeObjectURL(bgUrl);
  bgUrl = blob ? URL.createObjectURL(blob) : '';
  root.classList.toggle('has-bg', !!blob);
  root.style.setProperty('--bg-img', blob ? 'url("' + bgUrl + '")' : 'none');
  root.style.setProperty('--bg-dim', o.dim + '%'); root.style.setProperty('--bg-blur', o.blur + 'px'); root.style.setProperty('--bg-surf', o.surf + '%');
  bgUi(!!blob);
}
function bgUi(has) {
  const o = bgOpts();
  $('#bgClear').hidden = !has; document.querySelectorAll('#bgBox .bgopt').forEach((r) => (r.hidden = !has));
  $('#bgDim').value = o.dim; $('#bgDimOut').textContent = o.dim + '%'; $('#bgBlur').value = o.blur; $('#bgBlurOut').textContent = o.blur + 'px'; $('#bgSurf').value = o.surf; $('#bgSurfOut').textContent = o.surf + '%';
  $('#bgPick').textContent = has ? '사진 바꾸기' : '사진 고르기';
}
async function bgLoad() {
  try { const blob = await bgIdb('readonly', (s) => s.get('bg')); if (blob) bgApply(blob); else { const o = bgOpts(); if (o.on) { o.on = false; bgSave(o); document.documentElement.classList.remove('has-bg'); } bgUi(false); } }
  catch { bgUi(false); }
}
async function bgFromFile(file) { // 너무 큰 사진은 가장 긴 변 1920px, JPEG 로 줄여서 저장한다
  const msg = $('#bgPick'); msg.disabled = true;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }), s = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * s), height: Math.round(bmp.height * s) });
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82)); if (!blob) throw new Error('못 줄임');
    await bgIdb('readwrite', (st) => st.put(blob, 'bg'));
    const o = bgOpts(); o.on = true; bgSave(o); bgApply(blob);
  } catch (e) { console.warn(e); alert('이 사진은 쓸 수 없어요. 다른 사진(JPG, PNG, WebP)을 골라 주세요.'); }
  msg.disabled = false;
}
$('#bgPick').onclick = () => $('#bgFile').click();
$('#bgFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) bgFromFile(f); };
$('#bgClear').onclick = async () => { try { await bgIdb('readwrite', (st) => st.delete('bg')); } catch {} const o = bgOpts(); o.on = false; bgSave(o); bgApply(null); };
for (const [id, key, unit] of [['#bgDim', 'dim', '%'], ['#bgBlur', 'blur', 'px'], ['#bgSurf', 'surf', '%']]) {
  $(id).oninput = (e) => { const o = bgOpts(); o[key] = +e.target.value; bgSave(o); $(id + 'Out').textContent = o[key] + unit; document.documentElement.style.setProperty('--bg-' + key, o[key] + unit); };
}
bgLoad();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { syncThemeColor(); themeCap(); });
syncThemeColor();

// ---- 분류 (화면 / 음성 / 알림 / 숨기기 / 계정 / 앱 설치·정보) ----
// 데스크톱은 왼쪽 목록 + 오른쪽 내용. 폰은 목록 화면에서 하나를 누르면 그 내용으로 들어가고 ← 로 돌아온다.
// 방에 들어오기 전(첫 화면)에는 화면과 앱 설치·정보(로그인했다면 계정도)만 쓸 수 있다. 숨겨진 페이지(예: 게스트의 알림)는 목록에서도 빠진다.
const SET_CATS = [['look', '화면', 'pgLook'], ['profile', '프로필', 'pgProfile'], ['voice', '음성', 'pgVoice'], ['notif', '알림', 'notifSec'], ['hide', '숨기기', 'pgHide'], ['acct', '계정', 'pgAcct'], ['app', '앱 설치·정보', 'pgApp']];
const SET_PRE = ['look', 'app']; // (프로필은 방에 들어온 뒤에만: 입장 전에는 입장 화면에서 꾸민다)
let setCur = get('setPage') || 'look';
const setPhone = () => matchMedia('(max-width:700px)').matches;
const setAvail = (cat) => { const c = SET_CATS.find((x) => x[0] === cat); return !!c && !$('#' + c[2]).hidden && (joined || SET_PRE.includes(cat) || (cat === 'acct' && loggedIn())); }; // 입장 전에도 로그인한 사람은 계정(닉네임·비밀번호·삭제)을 만질 수 있어야 한다
const setLabel = (cat) => SET_CATS.find((x) => x[0] === cat)?.[1] || '설정';
const SET_SUM = {
  look: () => THEME_NAME[get('theme') || 'auto'] || '',
  profile: () => users.find((u) => u.id === me)?.name || '',
  voice: () => (voicePrefs.ns ? '잡음 억제 켜짐' : '잡음 억제 꺼짐'),
  notif: () => ($('#pushOn').checked ? '켜짐' : '꺼짐'),
  hide: () => ($('#spoofSel').selectedOptions[0]?.textContent || '').split(' (')[0],
  acct: () => (loggedIn() ? get('acctName') : '게스트'),
  app: () => (typeof isStandalone === 'function' && isStandalone() ? '앱으로 열림' : ''),
};
function buildSetNav() {
  const nav = $('#setNav'); nav.replaceChildren();
  for (const [cat, label] of SET_CATS) {
    if (!setAvail(cat)) continue;
    const b = el('button', { type: 'button', className: 'set-tab', onclick: () => setPage(cat) },
      el('span', { textContent: label }), el('span', { className: 'set-sum', textContent: SET_SUM[cat]() }));
    b.insertAdjacentHTML('beforeend', '<svg class="i" aria-hidden="true"><use href="#i-back"/></svg>');
    b.dataset.cat = cat; nav.append(b);
  }
}
function setPage(cat) { // 이 분류의 내용을 보여 준다 (자동 점검 도구도 이걸 쓴다)
  if (!setAvail(cat)) cat = 'look';
  setCur = cat; set('setPage', cat);
  for (const [k, , pg] of SET_CATS) $('#' + pg).classList.toggle('on', k === cat);
  $('#setNav').querySelectorAll('.set-tab').forEach((b) => (b.dataset.cat === cat ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  settingsDlg.dataset.view = 'page';
  $('#setTitle').textContent = setPhone() ? setLabel(cat) : '설정';
  $('#setPane').scrollTop = 0;
}
function setList() { // 폰: 분류 목록으로
  settingsDlg.dataset.view = 'list'; $('#setTitle').textContent = '설정';
  $('#setNav').querySelector('[aria-current=page]')?.focus() || $('#setNav .set-tab')?.focus();
}
$('#setBack').onclick = setList;
matchMedia('(max-width:700px)').addEventListener('change', () => { if (settingsDlg.open || settingsDlg.hasAttribute('open')) { buildSetNav(); setPhone() ? setList() : setPage(setCur); } });

// ---- 창 열고 닫기 ----
// <dialog>를 지원하지 않는 구형 브라우저(iOS 15.4 미만, 일부 앱 안 브라우저)에서도 열리고 닫히게 한다
function openSettings() {
  if (joined && !$('#profMake .make')) $('#profMake').append($('#makeWrap .make')); // 입장 화면의 프로필 꾸미기 도구를 설정의 프로필 페이지로 옮겨 쓴다 (같은 도구라서 입장 화면과 똑같이 동작)
  profUi();
  $('#leaveRow').hidden = !joined || !!dmOnly; // 방에서 나가기는 방에 들어온 뒤에만
  $('#helpRows').hidden = $('#helpHead').hidden = !joined; // 도움말 다시 보기는 방에 들어온 뒤에만 (화면의 버튼을 가리켜야 해서)
  $('#helpRoom').closest('.srow').hidden = !!dmOnly; $('#helpDm').closest('.srow').hidden = !meUid;
  buildSetNav();
  if (typeof settingsDlg.showModal === 'function') settingsDlg.showModal();
  else { settingsDlg.setAttribute('open', ''); settingsDlg.classList.add('fallback'); }
  if (setPhone()) { settingsDlg.dataset.view = 'list'; $('#setTitle').textContent = '설정'; for (const [, , pg] of SET_CATS) $('#' + pg).classList.remove('on'); }
  else setPage(setCur);
}
function closeSettings() {
  if (typeof settingsDlg.close === 'function') settingsDlg.close(); else settingsDlg.removeAttribute('open');
}
$('#settingsBtn').onclick = $('#joinSettings').onclick = openSettings;
$('#setClose').onclick = (e) => { e.preventDefault(); closeSettings(); }; // form method=dialog를 모르는 브라우저에서 페이지가 이동하지 않게
settingsDlg.addEventListener('click', (e) => { if (e.target === settingsDlg) closeSettings(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && settingsDlg.classList.contains('fallback') && settingsDlg.hasAttribute('open')) closeSettings(); }); // 바깥을 누르면 닫힘

/* ---------- 프로필 페이지: 방 안에서 아바타(사진·이모티콘·색)와 닉네임을 바꾼다 ---------- */
function profUi() {
  const acct = loggedIn();
  $('#profGuestName').hidden = acct; $('#profAcctName').hidden = !acct;
  $('#profAcctNm').textContent = acct ? get('acctName') : '';
  $('#profWho').textContent = acct ? '로그인한 계정의 프로필이에요. 저장하면 내 모든 기기에 바로 바뀌어요.' : '게스트 프로필이에요. 방을 나가면 사라져요.';
  refresh(); // 미리보기를 지금 프로필로
}
$('#profToAcct').onclick = () => setPage('acct');
$('#profSave').onclick = () => {
  if (!send({ t: 'profile', avatar: currentAvatar(), color: profile.color })) return setMsg('profMsg', '연결이 끊겨 있어요. 다시 연결되면 눌러 주세요.');
  profileEdited = true; set('profile', JSON.stringify(profile));
  setMsg('profMsg', '프로필을 저장했어요. 다른 사람 화면에도 바뀌어요.', true);
};
$('#gRenGo').onclick = () => {
  const name = $('#gRenIn').value.replace(/\s+/g, ' ').trim();
  if (!name) return setMsg('gRenMsg', '새 닉네임을 입력해 주세요.');
  if (!NICK_RE.test(name) || !NICK_LETTER.test(name)) return setMsg('gRenMsg', NAME_HELP);
  if (!send({ t: 'guest-rename', name })) setMsg('gRenMsg', '연결이 끊겨 있어요. 다시 연결되면 눌러 주세요.');
};
Object.assign(handlers, {
  'rename-result'(m) {
    if (!m.ok) return setMsg('gRenMsg', m.msg || '바꾸지 못했어요.');
    joinName = m.name; set('name', m.name); $('#nameIn').value = m.name; $('#gRenIn').value = '';
    setMsg('gRenMsg', `닉네임을 "${m.name}"으로 바꿨어요.`, true);
  },
  'guest-renamed'(m) { // 게스트가 닉네임을 바꿨다: 이미 올라온 말풍선의 이름도 바꾼다
    document.querySelectorAll('#chat .m[data-sid]').forEach((row) => { if (row.dataset.sid === m.id) row.querySelector('.bubble header b').textContent = m.name; });
  },
});

/* ---------- 약관·정보: 개인정보처리방침과 이용약관을 앱 안에서 읽는다 ---------- */
const docDlg = $('#docDlg');
async function openDoc(which, title) {
  $('#docTitle').textContent = title;
  $('#docBody').replaceChildren(el('p', { className: 'note', textContent: '불러오는 중…' }));
  if (typeof docDlg.showModal === 'function') { if (!docDlg.open) docDlg.showModal(); } else { docDlg.setAttribute('open', ''); docDlg.classList.add('fallback'); }
  try {
    const r = await fetch('/docs/' + which, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    $('#docBody').replaceChildren(...mdDoc(await r.text()));
  } catch { $('#docBody').replaceChildren(el('p', { className: 'note', textContent: '문서를 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.' })); }
  $('#docBody').scrollTop = 0; $('#docBody').focus();
}
$('#docPrivacy').onclick = () => openDoc('privacy', '개인정보처리방침');
$('#docTerms').onclick = () => openDoc('terms', '이용약관');
$('#docClose').onclick = (e) => { e.preventDefault(); if (typeof docDlg.close === 'function') docDlg.close(); else docDlg.removeAttribute('open'); };
docDlg.addEventListener('click', (e) => { if (e.target === docDlg) $('#docClose').click(); });

// 방 나가기: 직접 나가는 것이라 호스트도 바로 넘어간다 (manual). 나간 뒤 첫 화면으로
$('#leaveBtn').onclick = () => {
  if (!confirm('방에서 나갈까요?')) return;
  ended = true; send({ t: 'bye', manual: true });
  try { stopEverything(); } catch {}
  location.reload();
};
