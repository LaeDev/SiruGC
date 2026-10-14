/* ================= 앱 로고 위장 (이 기기에서만) ================= */
// 헤더의 로고와 탭의 아이콘·제목을 평범한 모양(계산기, 메모장, 책, 시계 또는 내가 고른 이미지)으로 바꾼다. 패닉·알림 위장과 같은 "가리는" 용도다.
// 기본은 패닉을 누른 동안만 바뀌고(해제하면 원래대로), "항상"으로 바꾸면 늘 이 모양이다. 특정 서비스의 로고를 흉내 내지 않는 일반적인 그림만 쓴다.
// 홈 화면에 설치한 앱의 아이콘은 웹 앱 규칙상 기기마다 따로 바꿀 수 없어서 대상이 아니다.
const LOGO_PRESETS = {
  calc: { label: '계산기', title: '계산기', d: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 3v4h10V5H7zm1 6.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM8 15.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z' },
  memo: { label: '메모장', title: '메모', d: 'M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5L14 3.5zM7 12h10v1.5H7V12zm0 3.5h10V17H7v-1.5z' },
  book: { label: '책', title: '독서 노트', d: 'M5 2h14a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V3a1 1 0 0 1 1-1zm1.5 2v14.5H18V4H6.5zM8 6h7v1.5H8V6zm0 3h7v1.5H8V9z' },
  cal: { label: '달력', title: '일정', d: 'M7 2h2v2h6V2h2v2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2V2zM5 10v10h14V10H5zm2 2h3v3H7v-3z' },
  clock: { label: '시계', title: '시계', d: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm.75 4.5v5.19l3.6 2.08-.75 1.3-4.35-2.5V6.5h1.5z' },
};
let logoPrefs = { mode: 'off', title: '', img: '', panicOnly: true };
try { Object.assign(logoPrefs, JSON.parse(get('logoPrefs') || '{}')); } catch {}
if (logoPrefs.mode !== 'off' && logoPrefs.mode !== 'custom' && !LOGO_PRESETS[logoPrefs.mode]) logoPrefs.mode = 'off';
const saveLogo = () => set('logoPrefs', JSON.stringify(logoPrefs));
const logoSvgUrl = (d) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#fff"/><path fill-rule="evenodd" fill="#4a5568" d="${d}" transform="translate(3 3) scale(.75)"/></svg>`);
// 지금 위장이 켜져 있으면 { title, icon, d?, img? }, 아니면 null. now: 패닉이 막 시작되는 중(saverOn 이 아직 false)일 때 true
function logoNow(panicNow) {
  if (logoPrefs.mode === 'off') return null;
  if (logoPrefs.panicOnly && !(panicNow || (typeof saverOn !== 'undefined' && saverOn))) return null;
  if (logoPrefs.mode === 'custom') return logoPrefs.img ? { title: logoPrefs.title || '새 탭', icon: logoPrefs.img, img: logoPrefs.img } : null;
  const p = LOGO_PRESETS[logoPrefs.mode];
  return { title: logoPrefs.title || p.title, icon: logoSvgUrl(p.d), d: p.d };
}
// 헤더의 로고를 그린다 (null 이면 원래대로)
const logoEl = document.querySelector('.logo'), logoSvg = logoEl?.querySelector('svg'), logoText = logoEl?.querySelector('.t'), logoBaseHtml = logoSvg?.innerHTML;
function paintLogo(d) {
  if (!logoEl) return;
  logoEl.querySelector('img.logo-img')?.remove();
  logoSvg.hidden = !!d?.img;
  if (d?.img) logoSvg.after(Object.assign(document.createElement('img'), { className: 'logo-img', src: d.img, alt: '', width: 28, height: 28 }));
  else logoSvg.innerHTML = d ? `<path fill-rule="evenodd" d="${d.d}"/>` : logoBaseHtml;
  logoText.textContent = d ? d.title : (typeof dmOnly !== 'undefined' && dmOnly ? '쪽지함' : '시루 그룹챗');
}

/* ---------- 설정 (숨기기 → 앱 로고 위장) ---------- */
function logoUi() {
  const sel = $('#logoSel');
  if (!sel.options.length) {
    sel.append(el('option', { value: 'off', textContent: '끔 (원래 로고)' }), ...Object.entries(LOGO_PRESETS).map(([k, v]) => el('option', { value: k, textContent: v.label })), el('option', { value: 'custom', textContent: '내 이미지' }));
  }
  sel.value = logoPrefs.mode; $('#logoTitle').value = logoPrefs.title; $('#logoPanicOnly').checked = logoPrefs.panicOnly;
  $('#logoTitleRow').hidden = logoPrefs.mode === 'off'; $('#logoImgRow').hidden = logoPrefs.mode !== 'custom'; $('#logoPanicRow').hidden = logoPrefs.mode === 'off';
  $('#logoPick').textContent = logoPrefs.img ? '이미지 바꾸기' : '이미지 고르기';
  const prev = $('#logoPrev'), cur = logoPrefs.mode === 'off' ? null : logoPrefs.mode === 'custom' ? { title: logoPrefs.title || '새 탭', img: logoPrefs.img } : { title: logoPrefs.title || LOGO_PRESETS[logoPrefs.mode].title, d: LOGO_PRESETS[logoPrefs.mode].d };
  prev.replaceChildren();
  if (!cur) return void prev.append(el('span', { textContent: '원래 로고를 그대로 써요.' }));
  const ico = cur.img ? el('img', { src: cur.img, alt: '', width: 28, height: 28 }) : (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = `<path fill-rule="evenodd" fill="currentColor" stroke="none" d="${cur.d}"/>`; return s; })();
  prev.append(ico, el('div', {}, el('b', { textContent: cur.title }), el('span', { textContent: logoPrefs.panicOnly ? '패닉을 누른 동안 이렇게 보여요.' : '이 기기에서는 늘 이렇게 보여요.' })));
}
function logoApply() { applyTabIdentity(); logoUi(); }
$('#logoSel').onchange = (e) => { logoPrefs.mode = e.target.value; saveLogo(); logoApply(); };
$('#logoTitle').oninput = (e) => { logoPrefs.title = e.target.value.slice(0, 30); saveLogo(); logoApply(); };
$('#logoPanicOnly').onchange = (e) => { logoPrefs.panicOnly = e.target.checked; saveLogo(); logoApply(); };
$('#logoPick').onclick = () => $('#logoFile').click();
$('#logoFile').onchange = (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const img = new Image(), url = URL.createObjectURL(f);
  img.onload = () => { // 가운데를 정사각형으로 잘라 64px 로 줄인다 (기기에 작게만 저장)
    const s = Math.min(img.width, img.height), c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
    c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 64, 64);
    URL.revokeObjectURL(url); logoPrefs.img = c.toDataURL('image/png'); saveLogo(); logoApply();
  };
  img.onerror = () => { URL.revokeObjectURL(url); setMsg('logoMsg', '이미지를 읽을 수 없어요. 다른 파일을 골라 주세요.'); };
  img.src = url;
};
logoUi();
if (logoNow()) applyTabIdentity(); // 처음 화면(입장 전)에서도 "항상"이면 바로 적용
