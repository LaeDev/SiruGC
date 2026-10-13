/* ================= 모든 소리 끄기 · 패닉(화면 보호기) ================= */
// 소리 끄기: 영상, 공유 화면, 음성 대화(상대 목소리), 쪽지 알림음을 모두 끈다. 내 마이크는 건드리지 않는다.
// 패닉: 소리 끄기 + 내 마이크 끄기 + 탭 제목을 평범하게 + 화면 보호기. 돌아와도 소리는 꺼진 채로 남는다(실수로 크게 울리지 않게).
function renderSound() {
  const b = $('#soundBtn');
  b.setAttribute('aria-pressed', soundOff);
  b.setAttribute('aria-label', soundOff ? '모든 소리 켜기' : '모든 소리 끄기');
  b.title = b.getAttribute('aria-label');
  $('#soundIcon').innerHTML = `<use href="#${soundOff ? 'i-volume-x' : 'i-volume'}"/>`;
  b.classList.toggle('stop', soundOff); // 꺼져 있으면 빨강
}
function setSoundOff(off) { soundOff = off; applySound(); renderSound(); }
$('#soundBtn').onclick = () => setSoundOff(!soundOff);

let saverOn = false, saverRaf = 0, saverClockTimer = 0, saverArmedAt = 0, lastEsc = 0;
const saverEl = $('#saver'), SAVER_UI = ['#app', '#join'];

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

function startSaver() {
  if (saverOn) return;
  saverOn = true; saverArmedAt = Date.now() + 500; // 누르던 손이 바로 닫지 않게 0.5초는 무시
  if (settingsDlg.hasAttribute('open')) closeSettings();
  SAVER_UI.forEach((s) => { const e = $(s); if (e) e.inert = true; }); // 키보드로 뒤의 화면을 조작할 수 없게
  saverEl.hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {}); // 가능하면 전체 화면 (Esc 키는 브라우저가 전체 화면 해제로 먼저 쓴다)
  drawStars(); tickClock(); saverClockTimer = setInterval(tickClock, 1000);
}
function stopSaver() {
  if (!saverOn || Date.now() < saverArmedAt) return;
  saverOn = false;
  cancelAnimationFrame(saverRaf); clearInterval(saverClockTimer);
  saverEl.hidden = true;
  SAVER_UI.forEach((s) => { const e = $(s); if (e) e.inert = false; });
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
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
for (const ev of ['pointerdown', 'keydown']) saverEl.addEventListener(ev, (e) => { e.preventDefault(); stopSaver(); });
addEventListener('keydown', (e) => { if (saverOn) { e.preventDefault(); stopSaver(); } }, true); // 포커스가 어디 있든 아무 키나
addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && saverOn) stopSaver(); }); // 전체 화면이 풀리면(Esc) 같이 끝낸다
// Esc를 빠르게 두 번: 어디서든 패닉 (입력창에 글을 쓰던 중이어도)
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.repeat || saverOn) return;
  if (document.querySelector('dialog[open]')) { lastEsc = 0; return; } // 창(설정, 로그인 …)을 Esc로 닫는 것은 패닉 Esc 두 번에 세지 않는다
  const now = Date.now();
  if (now - lastEsc < 600) { lastEsc = 0; panic(); } else lastEsc = now;
});
renderSound();
