/* ================= 모든 소리 끄기 · 패닉 ================= */
// 소리 끄기: 영상, 공유 화면, 음성 대화(상대 목소리), 쪽지 알림음을 모두 끈다. 내 마이크는 건드리지 않는다.
// 패닉: 소리 끄기 + 내 마이크 끄기 + 탭 제목을 평범하게 + "공부하는 화면". 돌아와도 소리는 꺼진 채로 남는다(실수로 크게 울리지 않게).
function renderSound() {
  const b = $('#soundBtn');
  b.setAttribute('aria-pressed', soundOff);
  b.setAttribute('aria-label', soundOff ? '모든 소리 켜기' : '모든 소리 끄기');
  b.title = b.getAttribute('aria-label');
  $('#soundLbl').textContent = soundOff ? '소리 켜기' : '소리 끄기';
  $('#soundIcon').innerHTML = `<use href="#${soundOff ? 'i-volume-x' : 'i-volume'}"/>`;
  b.classList.toggle('stop', soundOff); // 꺼져 있으면 빨강
}
function setSoundOff(off) { soundOff = off; applySound(); renderSound(); }
$('#soundBtn').onclick = () => setSoundOff(!soundOff);

/* ---------- 패닉 화면: 강의 영상 + 강의 플레이어 모양 컨트롤 + 10초 누르기 + 비밀번호 ---------- */
// 패닉을 누르면 채팅 위로 고1 수학 강의가 전체 화면으로 뜬다. 마우스를 움직이면 유튜브 자신의 컨트롤 대신 일반적인 강의 플레이어 모양의
// 컨트롤(재생·정지·볼륨)이 나온다(영상 위의 투명한 막이 유튜브 컨트롤을 가린다). 해제하려면 화면을 한 번 누른 채 10초를 버텨야 하고(떼면 처음부터,
// 3초가 남으면 남은 초가 슬며시 뜬다), 끝나면 비밀번호(로그인한 사람) 또는 4자리 PIN(게스트)을 묻는다. 새로고침해도 잠금은 유지된다.
// 강의는 방에 들어올 때부터 소리 없이 낮은 화질로 미리 재생해 둔다(설정에서 끌 수 있음). 그래야 패닉을 누르는 순간 이미 재생 중이다.
// 유튜브가 안 뜨면 예전의 별 화면으로 대신한다. 이 화면은 남의 눈을 피하는 용도이지 보안 장치는 아니다.
const HOLD_MS = 10000, HINT_MS = 3000;
const LECTURE_DEFAULT = { id: 'Xpw_ac9Y2Dg', start: 0, end: 1800 }; // EBSi 공식 채널의 고1 수학 강의 앞 30분 (끝나면 처음부터)
let saverOn = false, saverRaf = 0, saverClockTimer = 0, lastEsc = 0;
const saverEl = $('#saver'), SAVER_UI = ['#app', '#join'];
let lecture = null, lectureReady = false, lectureBad = false, barTimer = 0, uiTick = 0, holdStart = 0, holdRaf = 0, holdPid = null, askingPw = false;

const lectureSrc = () => { const id = ytId(get('panicVideo') || ''); return id ? { id, start: 0, end: 0 } : LECTURE_DEFAULT; };
function lectureInit() {
  if (lecture || lectureBad) return;
  const s = lectureSrc();
  ytApi(() => {
    if (lecture) return;
    lecture = new YT.Player('lecturePlayer', {
      videoId: s.id,
      playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, fs: 0, modestbranding: 1, rel: 0, iv_load_policy: 3, playsinline: 1, start: s.start, ...(s.end ? { end: s.end } : {}) },
      events: {
        onReady: () => { lectureReady = true; lecture.mute(); try { lecture.setPlaybackQuality('small'); } catch {} lecture.playVideo(); if (saverOn) showLecture(); },
        onStateChange: (e) => { if (e.data === 0) { lecture.seekTo(lectureSrc().start, true); lecture.playVideo(); } }, // 끝나면 처음부터 (지루한 반복이 아니라 계속 보는 것처럼)
        onError: () => { lectureBad = true; if (saverOn) showLecture(); }, // 퍼가기가 막혔거나 못 불러옴: 별 화면으로
      },
    });
  });
}
// 방에 들어오면 미리 재생해 둔다 (설정에서 끄면 패닉을 누를 때 불러온다)
{
  const j = handlers.joined;
  handlers.joined = function (m) { const r = j.call(this, m); if (get('panicPreplay') !== '0') lectureInit(); return r; };
}
const lectureVisible = () => saverOn && lectureReady && !lectureBad;
function showLecture() {
  const on = lectureVisible();
  saverEl.classList.toggle('lec', on); $('#lecture').classList.toggle('on', on);
  if (!on) return;
  try { if (lecture.getPlayerState() !== 1) lecture.playVideo(); } catch {}
  $('#lecTitle').textContent = lecture.getVideoData?.()?.title || '';
  lecUi();
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const lecRange = () => { const a = lectureSrc().start, b = lectureSrc().end || lecture.getDuration() || a + 1; return [a, Math.max(b, a + 1)]; };
function lecUi() { // 컨트롤 모양을 지금 재생 상태에 맞춘다
  if (!lectureVisible()) return;
  const [a, b] = lecRange(), t = Math.min(Math.max(lecture.getCurrentTime() - a, 0), b - a), playing = lecture.getPlayerState() === 1, vol = lecture.isMuted() ? 0 : lecture.getVolume();
  $('#lecTime').textContent = `${fmt(t)} / ${fmt(b - a)}`;
  $('#lecSeek').value = Math.round((t / (b - a)) * 1000);
  $('#lecPlay').setAttribute('aria-label', playing ? '정지' : '재생'); $('#lecPlay').firstElementChild.setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#lecMute').firstElementChild.setAttribute('href', vol ? '#i-volume' : '#i-volume-x'); $('#lecMute').setAttribute('aria-label', vol ? '소리 끄기' : '소리 켜기');
  if (document.activeElement !== $('#lecVol')) $('#lecVol').value = vol;
}
function showBar() { // 마우스를 움직이거나 화면을 건드리면 컨트롤이 나오고 3초 뒤 사라진다
  saverEl.classList.add('ui'); clearTimeout(barTimer);
  barTimer = setTimeout(() => saverEl.classList.remove('ui'), 3000);
}
$('#lecPlay').onclick = () => { if (!lectureVisible()) return; lecture.getPlayerState() === 1 ? lecture.pauseVideo() : lecture.playVideo(); setTimeout(lecUi, 120); };
$('#lecMute').onclick = () => { if (!lectureVisible()) return; if (lecture.isMuted() || !lecture.getVolume()) { lecture.unMute(); if (!lecture.getVolume()) lecture.setVolume(60); } else lecture.mute(); lecUi(); };
$('#lecVol').oninput = (e) => { if (!lectureVisible()) return; const v = +e.target.value; v ? (lecture.unMute(), lecture.setVolume(v)) : lecture.mute(); lecUi(); };
$('#lecSeek').oninput = (e) => { if (!lectureVisible()) return; const [a, b] = lecRange(); lecture.seekTo(a + ((b - a) * e.target.value) / 1000, true); };
for (const id of ['lecBar', 'lecAuth']) $('#' + id).addEventListener('pointerdown', (e) => e.stopPropagation()); // 컨트롤을 누르는 것은 "10초 누르기"가 아니다

// 10초 누르기: 막(shield)을 한 번 누른 채로 버틴다. 떼면 처음부터. 짧게 톡 누르면 재생/정지.
const shield = $('#lecShield');
function holdStop() {
  cancelAnimationFrame(holdRaf); holdRaf = 0; holdStart = 0; holdPid = null;
  $('#lecHold').classList.remove('on');
}
function holdFrame() {
  if (!holdStart) return;
  const spent = Date.now() - holdStart, left = HOLD_MS - spent;
  if (left <= 0) { holdStop(); return askUnlock(); }
  const hint = $('#lecHold');
  hint.classList.toggle('on', left <= HINT_MS); // 3초가 남았을 때부터 남은 초가 뜬다
  if (left <= HINT_MS) { $('#lecHoldN').textContent = Math.ceil(left / 1000); hint.style.setProperty('--p', Math.round((1 - left / HINT_MS) * 100)); }
  holdRaf = requestAnimationFrame(holdFrame);
}
function holdBegin(pid) {
  if (!saverOn || askingPw || holdStart) return;
  holdStart = Date.now(); holdPid = pid; holdFrame(); showBar();
}
shield.addEventListener('pointerdown', (e) => { e.preventDefault(); shield.setPointerCapture?.(e.pointerId); const t = Date.now(); shield._down = t; holdBegin(e.pointerId); });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) shield.addEventListener(ev, (e) => {
  if (e.pointerId !== holdPid) return;
  const quick = ev === 'pointerup' && Date.now() - (shield._down || 0) < 300;
  holdStop(true);
  if (quick && lectureVisible()) $('#lecPlay').click(); // 톡 누르면 재생/정지 (일반 플레이어처럼)
});
saverEl.addEventListener('pointermove', showBar);
// 키보드로도: 막에 포커스를 두고 Enter/스페이스를 10초 누르고 있기
shield.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); holdBegin('key'); } });
shield.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') holdStop(true); });

// 해제: 로그인한 사람은 계정 비밀번호(서버가 확인), 게스트는 이 기기에 정해 둔 4자리 PIN (없으면 지금 정한다)
const shaHex = async (s) => {
  if (crypto.subtle) return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return String(h); // http(비보안) 주소에서는 crypto.subtle이 없다: 남의 눈을 피하는 용도라 간단한 값으로 대신
};
const pinOk = (p) => /^\d{4}$/.test(p);
async function setPin(pin) { const salt = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join(''); set('pinSalt', salt); set('pinHash', await shaHex(salt + pin)); }
async function checkPin(pin) { return !!get('pinHash') && (await shaHex(get('pinSalt') + pin)) === get('pinHash'); }
let wrongs = 0, lockUntil = 0;
function askUnlock() {
  askingPw = true; saverEl.classList.add('asking'); $('#lecAuth').hidden = false;
  const acct = loggedIn(), first = !acct && !get('pinHash');
  $('#lecAuthNote').textContent = acct ? '계정 비밀번호를 입력해 주세요.' : first ? '화면 잠금 PIN(숫자 4자리)을 처음 정해 주세요. 다음부터 이 PIN으로 풀어요.' : 'PIN(숫자 4자리)을 입력해 주세요.';
  const pw = $('#lecPw'), pw2 = $('#lecPw2');
  pw.value = pw2.value = ''; pw.maxLength = acct ? 64 : 4; pw.inputMode = acct ? 'text' : 'numeric'; pw.autocomplete = acct ? 'current-password' : 'off';
  pw.setAttribute('aria-label', acct ? '계정 비밀번호' : 'PIN 4자리');
  pw2.hidden = !first; $('#lecAuthMsg').textContent = '';
  setTimeout(() => pw.focus(), 50);
}
function cancelUnlock() { askingPw = false; saverEl.classList.remove('asking'); $('#lecAuth').hidden = true; shield.focus({ preventScroll: true }); }
$('#lecCancel').onclick = cancelUnlock;
$('#lecAuth').onsubmit = async (e) => {
  e.preventDefault();
  const msg = $('#lecAuthMsg'), v = $('#lecPw').value, acct = loggedIn(), first = !acct && !get('pinHash');
  if (Date.now() < lockUntil) return void (msg.textContent = `잠시 뒤에 다시 해 주세요. (${Math.ceil((lockUntil - Date.now()) / 1000)}초)`);
  let ok = false;
  if (acct) {
    $('#lecGo').disabled = true; const r = await authPost('/auth/check', { password: v }); $('#lecGo').disabled = false;
    if (r.error === 'net') return void (msg.textContent = '연결이 되면 풀 수 있어요. 잠시 뒤에 다시 해 주세요.');
    if (r.error === 'locked') return void (msg.textContent = r.msg);
    ok = !!r.ok;
  } else if (first) {
    if (!pinOk(v)) return void (msg.textContent = 'PIN은 숫자 4자리예요.');
    if (v !== $('#lecPw2').value) return void (msg.textContent = '두 번 입력한 PIN이 달라요.');
    await setPin(v); ok = true;
  } else ok = pinOk(v) && (await checkPin(v));
  if (!ok) { wrongs++; if (wrongs >= 5) { lockUntil = Date.now() + 30000; wrongs = 0; msg.textContent = '여러 번 틀렸어요. 30초 뒤에 다시 해 주세요.'; } else msg.textContent = acct ? '비밀번호가 맞지 않아요.' : 'PIN이 맞지 않아요.'; $('#lecPw').value = ''; return; }
  wrongs = 0; unlockSaver();
};

/* ---------- 별 화면 (강의를 못 불러왔을 때의 대신 화면) ---------- */
function drawStars() {
  const c = $('#saverCanvas'), g = c.getContext('2d'), dpr = Math.min(devicePixelRatio || 1, 2);
  const W = (c.width = Math.round(innerWidth * dpr)), H = (c.height = Math.round(innerHeight * dpr));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; // 움직임 줄이기 설정이면 별이 가만히 있는다
  const fresh = () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() * 0.98 + 0.02 });
  const stars = Array.from({ length: 220 }, fresh);
  (function frame() {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    for (const s of stars) {
      if (!reduce && (s.z -= 0.004) <= 0.02) Object.assign(s, fresh(), { z: 1 });
      const k = 0.5 / s.z, px = W / 2 + ((s.x * k * W) / 2), py = H / 2 + ((s.y * k * H) / 2);
      g.fillStyle = `rgba(255,255,255,${Math.min(1, 1 - s.z + 0.15)})`;
      g.beginPath(); g.arc(px, py, Math.max(0.6, (1 - s.z) * 2.6) * dpr, 0, 7); g.fill();
    }
    saverRaf = requestAnimationFrame(frame);
  })();
}
const tickClock = () => { $('#saverClock').textContent = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }); };

/* ---------- 켜기 · 끄기 ---------- */
// 폰: 전체 화면 + 가로로 고정한다. 방향 고정을 못 하는 기기(iPhone 등)에서 세로로 들고 있으면 화면을 90도 돌려 보여 준다
const coarse = () => matchMedia('(pointer:coarse)').matches;
function fitOrientation() {
  const rot = saverOn && coarse() && innerHeight > innerWidth;
  saverEl.classList.toggle('rot', rot); $('#lecture').classList.toggle('rot', rot);
}
addEventListener('resize', fitOrientation);
function startSaver() {
  if (saverOn) return;
  saverOn = true; set('panicLocked', '1');
  if (settingsDlg.hasAttribute('open')) closeSettings();
  SAVER_UI.forEach((s) => { const e = $(s); if (e) e.inert = true; }); // 키보드로 뒤의 화면을 조작할 수 없게
  saverEl.hidden = false; saverEl.classList.remove('asking'); $('#lecAuth').hidden = true; askingPw = false;
  Promise.resolve(document.documentElement.requestFullscreen?.()).then(() => coarse() && screen.orientation?.lock?.('landscape').catch(() => {}).finally(fitOrientation)).catch(() => {}); // 가능하면 전체 화면 (폰은 가로로 고정)
  fitOrientation();
  lectureInit();
  if (lectureReady && !lectureBad) showLecture();
  else { drawStars(); tickClock(); saverClockTimer = setInterval(tickClock, 1000); } // 강의가 아직 안 떴으면 별 화면으로 시작하고, 뜨면 강의로 바꾼다
  uiTick = setInterval(() => { lecUi(); if (lectureVisible() && !$('#lecture').classList.contains('on')) { cancelAnimationFrame(saverRaf); clearInterval(saverClockTimer); showLecture(); } }, 500);
  showBar(); shield.focus({ preventScroll: true });
}
function unlockSaver() {
  if (!saverOn) return;
  saverOn = false; set('panicLocked', '');
  cancelAnimationFrame(saverRaf); clearInterval(saverClockTimer); clearInterval(uiTick); clearTimeout(barTimer); holdStop(true);
  saverEl.hidden = true; saverEl.classList.remove('lec', 'ui', 'asking', 'rot'); $('#lecture').classList.remove('on', 'rot'); $('#lecAuth').hidden = true; askingPw = false;
  SAVER_UI.forEach((s) => { const e = $(s); if (e) e.inert = false; });
  try { screen.orientation?.unlock?.(); } catch {}
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  if (lecture && lectureReady) { try { lecture.mute(); } catch {} } // 풀고 나면 다시 소리 없이 계속 재생해 둔다
  panicIdentity(false);
  sys('화면 보호기를 껐어요. 소리는 꺼진 상태예요. 다시 켜려면 스피커 버튼을 누르세요.');
  ($('#app').hidden ? $('#nameIn') : $('#panicBtn'))?.focus();
}
function panic() {
  if (saverOn) return;
  setSoundOff(true);       // 모든 소리
  setMicMuted(true);       // 내 마이크 (음성에 안 들어가 있으면 아무 일도 안 한다)
  panicIdentity(true);     // 탭 제목·아이콘
  startSaver();
}

$('#panicBtn').onclick = panic;
// 잠겨 있는 동안에는 키를 모두 막는다 (비밀번호 칸에 쓰는 것만 허용). Esc나 전체 화면 해제로는 풀리지 않는다
addEventListener('keydown', (e) => { if (saverOn && !e.target.closest?.('#lecAuth') && !(e.target === shield && (e.key === 'Enter' || e.key === ' '))) e.preventDefault(); }, true);
// Esc를 빠르게 두 번: 어디서든 패닉 (입력창에 글을 쓰던 중이어도)
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.repeat || saverOn) return;
  if (document.querySelector('dialog[open]')) { lastEsc = 0; return; } // 창(설정, 로그인 …)을 Esc로 닫는 것은 패닉 Esc 두 번에 세지 않는다
  const now = Date.now();
  if (now - lastEsc < 600) { lastEsc = 0; panic(); } else lastEsc = now;
});
renderSound();
if (get('panicLocked') === '1') panic(); // 새로고침해도 잠금은 유지된다

/* ---------- 설정 창: 패닉 화면 ---------- */
$('#panicPre').checked = get('panicPreplay') !== '0';
$('#panicPre').onchange = (e) => { set('panicPreplay', e.target.checked ? '1' : '0'); if (e.target.checked && joined) lectureInit(); };
$('#panicVideoIn').value = get('panicVideo') || '';
$('#panicVideoGo').onclick = () => {
  const v = $('#panicVideoIn').value.trim(), id = v && ytId(v);
  if (v && !id) return void setMsg('panicMsg', '유튜브 링크를 알아볼 수 없어요. 주소 전체를 붙여 넣어 보세요.');
  set('panicVideo', id ? v : ''); setMsg('panicMsg', id ? '강의 영상을 바꿨어요. 새로고침하면 적용돼요.' : '기본 강의로 돌렸어요. 새로고침하면 적용돼요.', true);
};
function pinUi() {
  const acct = loggedIn();
  $('#pinBox').hidden = acct; $('#pinAcct').hidden = !acct;
  $('#pinNow').textContent = get('pinHash') ? 'PIN이 정해져 있어요. 바꾸려면 새 PIN을 입력하세요.' : '아직 PIN이 없어요. 패닉을 풀 때 처음 정하거나 여기서 정해 두세요.';
}
$('#pinGo').onclick = async () => {
  const v = $('#pinNew').value;
  if (!pinOk(v)) return void setMsg('pinMsg', 'PIN은 숫자 4자리예요.');
  await setPin(v); $('#pinNew').value = ''; setMsg('pinMsg', 'PIN을 저장했어요.', true); pinUi();
};
$('#settingsBtn').addEventListener('click', pinUi); $('#joinSettings').addEventListener('click', pinUi);
pinUi();
