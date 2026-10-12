/* ================= 채팅 화면 크기 조정 ================= */
// 1) PC·태블릿 가로: 영상과 채팅 사이의 선을 끌어서 채팅 너비를 바꾼다 (--side-w)
// 2) 폰 세로: 영상과 채팅 사이의 손잡이를 끌어서 영상 높이를 바꾼다 (--video-h)
// 3) 설정의 채팅 글자 크기 (--chat-fs)
// 값은 이 기기에만 저장된다. 선과 손잡이는 키보드로도 조절되고(←→ ↑↓, Home/End), 두 번 누르면 기본값으로 돌아간다.
const SIDE = { min: 280, def: 400 }, VIDEO_MIN = 120;
const CHAT_SIZES = { small: ['작게', 14], normal: ['보통', 16], large: ['크게', 18], xlarge: ['아주 크게', 21] };
const root = document.documentElement;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isStacked = () => matchMedia('(max-width:900px) and (orientation:portrait)').matches; // 폰 세로: 영상 위, 채팅 아래

const sideMax = () => Math.max(SIDE.min, Math.min(720, Math.round(innerWidth * 0.6)));
const videoMax = () => Math.max(VIDEO_MIN, Math.round(innerHeight * 0.6));
const videoDef = () => Math.round(innerWidth * 9 / 16); // 기본은 16:9

function applyLayout() {
  const sw = +get('sideW'), vh = +get('videoH');
  if (sw) root.style.setProperty('--side-w', clamp(sw, SIDE.min, sideMax()) + 'px'); else root.style.removeProperty('--side-w');
  if (vh) root.style.setProperty('--video-h', clamp(vh, VIDEO_MIN, videoMax()) + 'px'); else root.style.removeProperty('--video-h');
  root.classList.toggle('video-h', !!vh);
  syncHandle();
}

const resizer = el('div', { id: 'resizer', className: 'resizer', role: 'separator', tabIndex: 0 });
$('.side').prepend(resizer);
function syncHandle() {
  const stacked = isStacked();
  resizer.setAttribute('aria-orientation', stacked ? 'horizontal' : 'vertical');
  resizer.setAttribute('aria-label', stacked ? '영상 높이 조절 (위아래로 끌기)' : '채팅 너비 조절 (좌우로 끌기)');
  resizer.title = stacked ? '위아래로 끌어서 영상 높이 조절, 두 번 누르면 원래대로' : '좌우로 끌어서 채팅 너비 조절, 두 번 누르면 원래대로';
  const [lo, hi, now] = stacked ? [VIDEO_MIN, videoMax(), Math.round($('.stage').getBoundingClientRect().height)] : [SIDE.min, sideMax(), Math.round($('.side').getBoundingClientRect().width)];
  resizer.setAttribute('aria-valuemin', lo); resizer.setAttribute('aria-valuemax', hi); resizer.setAttribute('aria-valuenow', clamp(now, lo, hi));
}
function setSize(px) { // 지금 방향에 맞는 값을 저장하고 적용
  if (isStacked()) set('videoH', Math.round(clamp(px, VIDEO_MIN, videoMax())));
  else set('sideW', Math.round(clamp(px, SIDE.min, sideMax())));
  applyLayout();
}
function resetSize() { set(isStacked() ? 'videoH' : 'sideW', ''); applyLayout(); }
const curSize = () => (isStacked() ? ($('.stage .frame:not([hidden]), .stage .empty:not([hidden])') || $('.stage')).getBoundingClientRect().height : $('.side').getBoundingClientRect().width);

resizer.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  e.preventDefault(); resizer.setPointerCapture(e.pointerId); resizer.classList.add('dragging'); document.body.classList.add('resizing');
  const stacked = isStacked(), start = stacked ? e.clientY : e.clientX, from = curSize();
  const move = (ev) => setSize(stacked ? from + (ev.clientY - start) : from - (ev.clientX - start)); // 채팅은 오른쪽에 있어서 왼쪽으로 끌수록 넓어진다
  const end = () => { resizer.classList.remove('dragging'); document.body.classList.remove('resizing'); resizer.removeEventListener('pointermove', move); resizer.removeEventListener('pointerup', end); resizer.removeEventListener('pointercancel', end); };
  resizer.addEventListener('pointermove', move); resizer.addEventListener('pointerup', end); resizer.addEventListener('pointercancel', end);
});
resizer.addEventListener('dblclick', resetSize);
resizer.addEventListener('keydown', (e) => {
  const stacked = isStacked(), step = e.shiftKey ? 80 : 20, size = curSize();
  const grow = stacked ? 'ArrowDown' : 'ArrowLeft', shrink = stacked ? 'ArrowUp' : 'ArrowRight';
  if (e.key === grow) setSize(size + step);
  else if (e.key === shrink) setSize(size - step);
  else if (e.key === 'Home') setSize(stacked ? VIDEO_MIN : SIDE.min);
  else if (e.key === 'End') setSize(stacked ? videoMax() : sideMax());
  else if (e.key === 'Enter' || e.key === ' ') resetSize();
  else return;
  e.preventDefault();
});
addEventListener('resize', applyLayout);
addEventListener('orientationchange', applyLayout);

/* ---------- 채팅 글자 크기 ---------- */
function applyChatSize(key) {
  const [, px] = CHAT_SIZES[key] || CHAT_SIZES.normal;
  root.style.setProperty('--chat-fs', px + 'px');
  const label = (CHAT_SIZES[key] || CHAT_SIZES.normal)[0];
  $('#chatSizeOut').textContent = label; $('#chatSize').setAttribute('aria-valuetext', label);
}
{
  const saved = CHAT_SIZES[get('chatSize')] ? get('chatSize') : 'normal', keys = Object.keys(CHAT_SIZES), range = $('#chatSize');
  range.max = keys.length - 1; range.value = keys.indexOf(saved);
  applyChatSize(saved);
  range.oninput = () => { const k = keys[+range.value]; set('chatSize', k); applyChatSize(k); };
  $('#layoutReset').onclick = () => { set('sideW', ''); set('videoH', ''); set('chatSize', 'normal'); range.value = keys.indexOf('normal'); applyChatSize('normal'); applyLayout(); };
}
applyLayout();
