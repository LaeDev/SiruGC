/* ================= 모든 소리 끄기 · 패닉 ================= */
// 소리 끄기: 영상, 공유 화면, 음성 대화(상대 목소리), 쪽지 알림음을 모두 끈다. 내 마이크는 건드리지 않는다.
// 패닉: 소리 끄기 + 내 마이크 끄기 + 탭 제목을 평범하게 + "공부하는 화면". 돌아와도 소리는 꺼진 채로 남는다(실수로 크게 울리지 않게).
function renderSound() {
  const b = $('#soundBtn');
  b.setAttribute('aria-pressed', soundOff);
  b.setAttribute('aria-label', soundOff ? '소리를 다시 전부 켜기' : '소리 전부 끄기');
  b.title = b.getAttribute('aria-label');
  $('#soundLbl').textContent = soundOff ? '다시 전부 켜기' : '소리 전부 끄기';
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
const LECTURE_DEFAULT = '2dI6uMcH5l8'; // 기본 강의 영상. 영상의 한가운데부터 틀고, 끝나면 다시 한가운데부터
let saverOn = false, saverRaf = 0, saverClockTimer = 0, lastEsc = 0;
const saverEl = $('#saver'), SAVER_UI = ['#app', '#join'];
let lecture = null, lectureReady = false, lectureBad = false, barTimer = 0, uiTick = 0, holdStart = 0, holdRaf = 0, holdPid = null, askingPw = false;

const lectureSrc = () => { const id = ytId(get('panicVideo') || ''); return { id: !id || id === 'Xpw_ac9Y2Dg' ? LECTURE_DEFAULT : id }; }; // 예전 기본 영상 주소가 설정에 남아 있어도 새 기본 영상으로 바꾼다
let lecMidDone = false; // 한가운데로 건너뛰었는가
const lecMid = () => Math.floor((lecture?.getDuration?.() || 0) / 2);
function lecJumpMid() { // 영상 길이를 알게 되면(재생이 시작된 뒤) 한가운데로 건너뛴다
  if (lecMidDone || !lecture) return;
  const d = lecture.getDuration?.() || 0;
  if (d > 60) { lecMidDone = true; lecSeekTo(Math.floor(d / 2)); }
}
/* 유튜브는 영상이 시작되거나 건너뛰거나 멈췄다 다시 재생될 때 약 5초 동안 자기 화면(제목 줄, 공유·추천 카드, 가운데 일시정지 표시, 어두운 막)을 영상 위에 그린다.
   자르는 것으로는 못 가리므로, 그런 일이 있고 나서 LEC_SETTLE_MS 동안은 검은 막(#lecCover)이 영상을 덮는다 (실제 유튜브로 재서 정함: 약 4.5초 + 여유). */
const LEC_SETTLE_MS = 5600;
let lecSettle = 0, lecPrevState = -2;
function lecTouch() { lecSettle = Date.now() + LEC_SETTLE_MS; setTimeout(lecUi, LEC_SETTLE_MS + 80); lecUi(); }
function lecSeekTo(t) { lecture.seekTo(t, true); lecTouch(); }
function lectureInit() {
  if (lecture || lectureBad) return;
  const s = lectureSrc();
  ytApi(() => {
    if (lecture) return;
    lecture = new YT.Player('lecturePlayer', {
      videoId: s.id,
      playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, fs: 0, modestbranding: 1, rel: 0, iv_load_policy: 3, cc_load_policy: 0, playsinline: 1 },
      events: {
        onReady: () => {
          lectureReady = true; lecture.mute(); try { lecture.setPlaybackQuality('small'); } catch {} lecture.playVideo();
          const f = lecture.getIframe?.(); if (f) { f.tabIndex = -1; f.removeAttribute('title'); f.setAttribute('aria-hidden', 'true'); } // 유튜브 화면이 조작·낭독 대상이 되지 않게
          if (saverOn) showLecture();
        },
        onStateChange: (e) => {
          if (e.data === 1 && lecPrevState !== 1) lecTouch(); // 시작·재개·버퍼링 뒤 다시 재생
          lecPrevState = e.data;
          if (e.data === 1) lecJumpMid();
          if (e.data === 0) { lecSeekTo(lecMid()); lecture.playVideo(); } // 끝나면 다시 한가운데부터 (계속 보는 것처럼)
          lecUi();
        },
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
  lecUi();
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const lecRange = () => [0, Math.max(lecture.getDuration() || 0, 1)];
const LEC_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], rateTxt = (r) => (Number.isInteger(r) ? r.toFixed(1) : String(r));
const setRate = (r) => { try { lecture.setPlaybackRate(r); } catch {} lecUi(); };
for (const r of LEC_RATES) $('#lecRates').append(el('button', { type: 'button', textContent: rateTxt(r), onclick: () => lectureVisible() && setRate(r) }));
function lecUi() { // 컨트롤 모양을 지금 재생 상태에 맞춘다
  if (!lectureVisible()) return;
  lecJumpMid();
  const [a, b] = lecRange(), t = Math.min(Math.max(lecture.getCurrentTime() - a, 0), b - a), st = lecture.getPlayerState(), playing = st === 1, vol = lecture.isMuted() ? 0 : lecture.getVolume();
  const rate = lecture.getPlaybackRate?.() || 1, hide = !playing || Date.now() < lecSettle;
  $('#lecCover').classList.toggle('on', hide); $('#lecCover').classList.toggle('busy', hide && st !== 2); // 멈춘 동안은 ▶, 불러오는 동안은 돌아가는 표시
  $('#lecTime').textContent = `${fmt(t)} / ${fmt(b - a)}`;
  $('#lecSeek').value = Math.round((t / (b - a)) * 1000);
  $('#lecPlay').setAttribute('aria-label', playing ? '일시정지' : '재생'); $('#lecPlay').firstElementChild.firstElementChild.setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#lecMute').firstElementChild.firstElementChild.setAttribute('href', vol ? '#i-volume' : '#i-volume-x'); $('#lecMute').setAttribute('aria-label', vol ? '소리 끄기' : '소리 켜기');
  if (document.activeElement !== $('#lecVol')) $('#lecVol').value = vol;
  $('#lecVolN').textContent = Math.round(vol / 10); // 참고한 플레이어처럼 0~10
  $('#lecRate').textContent = rateTxt(rate) + 'x';
  [...$('#lecRates').children].forEach((bt, i) => bt.setAttribute('aria-pressed', LEC_RATES[i] === rate));
  const near = lecMarks.findIndex((m) => Math.abs(m - t) < 2);
  $('#lecMark').textContent = near >= 0 ? '북마크해제' : '북마크추가';
}
const showBar = () => {}; // 컨트롤은 늘 보인다 (예전 호출 자리 유지)
const lecStepSec = () => +$('#lecStep').value || 10;
$('#lecPlay').onclick = () => { if (!lectureVisible()) return; lecture.getPlayerState() === 1 ? lecture.pauseVideo() : lecture.playVideo(); setTimeout(lecUi, 120); };
$('#lecStop').onclick = () => { if (!lectureVisible()) return; lecture.pauseVideo(); lecSeekTo(lecMid()); lecLoopClear(); }; // 정지: 멈추고 처음 자리(한가운데)로
const lecSkip = (d) => { if (!lectureVisible()) return; lecSeekTo(Math.min(Math.max(lecture.getCurrentTime() + d, 0), lecRange()[1])); };
$('#lecBack').onclick = () => lecSkip(-lecStepSec());
$('#lecFwd').onclick = () => lecSkip(lecStepSec());
const stepNote = () => { const n = $('#lecStep').selectedOptions[0].textContent; $('#lecBack').setAttribute('aria-label', n + ' 뒤로'); $('#lecFwd').setAttribute('aria-label', n + ' 앞으로'); };
$('#lecStep').value = ['5', '10', '30', '60'].includes(get('lecStep')) ? get('lecStep') : '10'; stepNote();
$('#lecStep').onchange = () => { set('lecStep', $('#lecStep').value); stepNote(); };
$('#lecRate').onclick = () => { if (!lectureVisible()) return; const cur = lecture.getPlaybackRate?.() || 1; setRate(LEC_RATES[(Math.max(LEC_RATES.indexOf(cur), 0) + 1) % LEC_RATES.length]); };
$('#lecMute').onclick = () => { if (!lectureVisible()) return; if (lecture.isMuted() || !lecture.getVolume()) { lecture.unMute(); if (!lecture.getVolume()) lecture.setVolume(60); } else lecture.mute(); lecUi(); };
$('#lecVol').oninput = (e) => { if (!lectureVisible()) return; const v = +e.target.value; v ? (lecture.unMute(), lecture.setVolume(v)) : lecture.mute(); lecUi(); };
$('#lecSeek').oninput = (e) => { if (!lectureVisible()) return; const [a, b] = lecRange(); lecSeekTo(a + ((b - a) * e.target.value) / 1000); };

// 구간반복: 한 번 누르면 시작점, 두 번째는 끝점(그때부터 그 사이를 되풀이), 세 번째는 해제
let loopA = null, loopB = null, loopTimer = 0;
function lecLoopClear() { loopA = loopB = null; clearInterval(loopTimer); loopTimer = 0; loopUi(); }
function loopUi() {
  const b = $('#lecLoop');
  b.setAttribute('aria-pressed', loopA !== null);
  b.textContent = loopA === null ? '구간반복' : loopB === null ? `시작 ${fmt(loopA)} · 끝점 정하기` : `반복 ${fmt(loopA)}–${fmt(loopB)}`;
}
$('#lecLoop').onclick = () => {
  if (!lectureVisible()) return;
  const t = lecture.getCurrentTime();
  if (loopA === null) loopA = t;
  else if (loopB === null) { if (t - loopA < 1) return; loopB = t; loopTimer = setInterval(() => { if (!lectureVisible()) return; const c = lecture.getCurrentTime(); if (c >= loopB || c < loopA - 1) lecSeekTo(loopA); }, 200); }
  else return lecLoopClear();
  loopUi();
};
// 북마크: 지금 자리를 적어 두고 눌러서 돌아간다 (같은 자리에서 다시 누르면 지움)
let lecMarks = [];
function marksUi() {
  $('#lecMarks').replaceChildren(...lecMarks.map((m) => el('button', { type: 'button', textContent: fmt(m), onclick: () => lectureVisible() && lecSeekTo(m) })));
  $('#lecMarks').querySelectorAll('button').forEach((bt, i) => bt.setAttribute('aria-label', '북마크 ' + fmt(lecMarks[i]) + ' 로 이동'));
}
$('#lecMark').onclick = () => {
  if (!lectureVisible()) return;
  const t = lecture.getCurrentTime(), near = lecMarks.findIndex((m) => Math.abs(m - t) < 2);
  if (near >= 0) lecMarks.splice(near, 1); else if (lecMarks.length < 8) lecMarks = [...lecMarks, t].sort((x, y) => x - y);
  marksUi(); lecUi();
};
// 화면크기: S1~S4는 영상을 키워서(가장자리는 잘림) 글씨를 크게, 일반은 통째로, 전체는 브라우저 전체 화면
const LEC_SIZES = [['S1', 1.15], ['S2', 1.3], ['S3', 1.5], ['S4', 1.75], ['일반', 1]];
function sizeUi() {
  const cur = LEC_SIZES.some(([k]) => k === get('lecSize')) ? get('lecSize') : '일반';
  $('#lecture').style.setProperty('--z', LEC_SIZES.find(([k]) => k === cur)[1]);
  [...$('#lecSizes').children].forEach((bt) => { if (bt.id !== 'lecFull') bt.setAttribute('aria-pressed', bt.textContent === cur); });
}
for (const [k] of LEC_SIZES) $('#lecSizes').append(el('button', { type: 'button', textContent: k, onclick: () => { set('lecSize', k); sizeUi(); } }));
if (document.documentElement.requestFullscreen) $('#lecSizes').append(el('button', { type: 'button', id: 'lecFull', textContent: '전체', onclick: () => { (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}); } }));
sizeUi();
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
  holdStart = Date.now(); holdPid = pid; holdFrame();
}
shield.addEventListener('pointerdown', (e) => { e.preventDefault(); shield.setPointerCapture?.(e.pointerId); const t = Date.now(); shield._down = t; holdBegin(e.pointerId); });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) shield.addEventListener(ev, (e) => {
  if (e.pointerId !== holdPid) return;
  const quick = ev === 'pointerup' && Date.now() - (shield._down || 0) < 300;
  holdStop(true);
  if (quick && lectureVisible()) $('#lecPlay').click(); // 톡 누르면 재생/정지 (일반 플레이어처럼)
});
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
  setTimeout(() => { pw.focus(); placeAuth(); }, 50);
}
// 키보드가 올라와 보이는 영역이 줄면(visualViewport) 비밀번호 칸이 가려지지 않게 보이는 영역의 가운데로 옮긴다 (돌려서 보여 줄 때는 가운데 그대로)
function placeAuth() {
  const f = $('#lecAuth'), vv = window.visualViewport;
  if (!vv || !askingPw || saverEl.classList.contains('rot')) { f.style.top = ''; return; }
  f.style.top = (vv.offsetTop + Math.max(vv.height / 2, f.offsetHeight / 2 + 8)) + 'px';
}
window.visualViewport?.addEventListener('resize', placeAuth); window.visualViewport?.addEventListener('scroll', placeAuth);
function cancelUnlock() { askingPw = false; $('#lecAuth').style.top = ''; saverEl.classList.remove('asking'); $('#lecAuth').hidden = true; shield.focus({ preventScroll: true }); }
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
  saverOn = true; set('panicLocked', '1'); document.documentElement.classList.add('saver-on');
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
  saverOn = false; set('panicLocked', ''); document.documentElement.classList.remove('saver-on');
  cancelAnimationFrame(saverRaf); clearInterval(saverClockTimer); clearInterval(uiTick); clearTimeout(barTimer); holdStop(true);
  saverEl.hidden = true; lecLoopClear(); saverEl.classList.remove('lec', 'asking', 'rot'); $('#lecture').classList.remove('on', 'rot'); $('#lecAuth').hidden = true; askingPw = false;
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
