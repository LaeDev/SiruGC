/* ================= 무대: 영상 / 공유 화면 ================= */
// 무대에는 한 번에 하나만 보인다. 둘 다 있으면 위의 '영상 | 공유 화면' 버튼으로 고른다.
let ytShown = false, stageView = 'yt', soundOff = false;
const screenEl = $('#screen');

function renderStage() {
  const hasScreen = !!sharerId, hasYt = ytShown;
  if (!hasScreen) stageView = 'yt'; else if (!hasYt) stageView = 'screen';
  $('#seg').hidden = !(hasScreen && hasYt);
  $('#segYt').setAttribute('aria-pressed', stageView === 'yt');
  $('#segScreen').setAttribute('aria-pressed', stageView === 'screen');
  $('#ytWrap').hidden = !hasYt || stageView !== 'yt';
  $('#screenWrap').hidden = !hasScreen || stageView !== 'screen';
  $('#empty').hidden = hasScreen || hasYt;
  const sharer = users.find((u) => u.id === sharerId);
  const base = sharer ? (sharer.id === me ? '내 화면을 공유하고 있어요' : `${sharer.name} 님이 공유 중`) : '';
  $('#screenBadge').textContent = base && shareStatus ? `${base} (${shareStatus})` : base;
  $('#retryShare').hidden = shareStatus !== '연결 실패';
  const btn = $('#shareBtn');
  $('#shareLbl').textContent = localStream ? '공유 중지' : '화면 공유';
  $('#shareIcon').innerHTML = `<use href="#${localStream ? 'i-stop' : 'i-screen'}"/>`;
  btn.setAttribute('aria-label', localStream ? '화면 공유 중지' : '화면 공유 시작');
  setTone(btn, localStream ? 'stop' : 'blue');
  btn.disabled = !!sharerId && sharerId !== me;
  btn.title = btn.disabled ? '다른 사람이 공유하는 동안에는 시작할 수 없어요' : '';
  applySound();
}
$('#segYt').onclick = () => { stageView = 'yt'; renderStage(); };
$('#segScreen').onclick = () => { stageView = 'screen'; renderStage(); };

// 모든 소리(영상, 공유 화면)를 한곳에서 정한다. 화면에 안 보이는 쪽, 내 공유 미리보기(에코)는 항상 끈다.
function applySound() {
  const ytHidden = $('#ytWrap').hidden;
  if (playerReady) (soundOff || ytHidden ? player.mute() : player.unMute());
  screenEl.muted = soundOff || !!localStream;
  applyAllVoiceVolumes(); // 상대 목소리: 모든 소리 끄기 + 사람별 크기
  document.querySelectorAll('.media video').forEach((v) => (v.muted = soundOff)); // 채팅에 올라온 동영상
}

/* ================= 같이 보기 (유튜브) ================= */
// 방의 재생 시계는 계속 흐른다. 일시정지는 개인 것 → 다시 틀면 서버에 물어 방의 현재 위치로 맞춘다.
let seekNoteAt = 0, player = null, playerReady = false, ytWant = null, ytSuppress = 0, selfPaused = false, lastSync = 0, lastT = null, lastAt = 0;
const ytId = (s) => (s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/) || [])[1];
const roomTime = () => (ytWant.playing ? ytWant.time + (Date.now() - ytWant.rcv) / 1000 : ytWant.time);

function applyYt(s) {
  const changed = !ytWant || ytWant.seq !== s.seq;
  ytWant = { ...s, rcv: Date.now() }; // rcv: 이 상태를 받은 내 시각 (서버 시계와 섞지 않으려고)
  ytShown = true;
  if (changed) selfPaused = false;
  renderStage(); renderQueue();
  ensurePlayer(changed);
}
function ensurePlayer(changed) {
  if (!window.YT?.Player) {
    if (!$('#ytapi')) {
      document.head.append(el('script', { id: 'ytapi', src: 'https://www.youtube.com/iframe_api' }));
      window.onYouTubeIframeAPIReady = () => ensurePlayer(true);
    }
    return;
  }
  if (!player) {
    player = new YT.Player('ytplayer', {
      videoId: ytWant.videoId, playerVars: { playsinline: 1, rel: 0 },
      events: { onReady: () => { playerReady = true; syncYt(true); applySound(); }, onStateChange: onYtState, onError: onYtError },
    });
    return;
  }
  syncYt(changed);
}
function syncYt(changed) {
  const s = ytWant;
  if (!playerReady || !s) return;
  ytSuppress = Date.now() + 1500; // 내가 내린 명령 때문에 생긴 이벤트는 서버로 되돌려 보내지 않음
  if (changed || player.getVideoData?.()?.video_id !== s.videoId) { // 플레이어가 아직 영상 정보를 주지 못할 때도 예외 없이 처음부터 불러온다
    if (s.playing) player.loadVideoById({ videoId: s.videoId, startSeconds: roomTime() });
    else player.cueVideoById({ videoId: s.videoId, startSeconds: 0 });
    return;
  }
  if (!s.playing || selfPaused) return; // 개인 일시정지 중이면 건드리지 않음 (다시 틀 때 맞춤)
  if (Math.abs(player.getCurrentTime() - roomTime()) > 1.5) player.seekTo(roomTime(), true);
  player.playVideo();
}
function onYtState(e) {
  if (Date.now() < ytSuppress) return;
  if (e.data === 2) selfPaused = true; // 일시정지: 나만 멈춘다
  else if (e.data === 1) { // 재생: 방의 현재 위치로 다시 맞춘다
    selfPaused = false;
    if (Date.now() - lastSync > 1000) { lastSync = Date.now(); send({ t: 'yt-sync' }); }
  } else if (e.data === 0 && ytWant) send({ t: 'yt-ended', seq: ytWant.seq });
}
function onYtError() {
  sys('이 영상은 같이 볼 수 없어요(퍼가기가 막힌 영상이에요). 다음 영상으로 넘어가요.');
  if (ytWant) send({ t: 'yt-ended', seq: ytWant.seq });
}
// 유튜브 API에는 '위치 이동' 이벤트가 없어서 0.5초마다 재생 위치가 갑자기 뛰었는지 본다.
setInterval(() => {
  if (!playerReady || !ytWant || player.getPlayerState() !== 1) { lastT = null; return; }
  const t = player.getCurrentTime(), now = Date.now();
  if (lastT !== null && now > ytSuppress) {
    const expected = lastT + ((now - lastAt) / 1000) * player.getPlaybackRate();
    if (Math.abs(t - expected) > 2) { // 직접 위치를 옮겼다
      if (isHost) { // 호스트의 이동은 모두에게 적용
        ytWant = { ...ytWant, playing: true, time: t, rcv: now };
        send({ t: 'yt-seek', time: t });
      } else { // 그 밖의 사람은 방의 위치로 되돌린다 (영상 위치는 호스트만 바꿀 수 있다)
        ytSuppress = now + 1500; player.seekTo(roomTime(), true); lastT = null;
        if (now - seekNoteAt > 8000) { seekNoteAt = now; sys('영상 위치는 호스트만 바꿀 수 있어요.'); }
        return;
      }
    } else if (ytWant.playing && !selfPaused && Math.abs(t - roomTime()) > 4) syncYt(false); // 버퍼링 등으로 많이 어긋남
  }
  lastT = t; lastAt = now;
}, 500);

/* ================= 대기열 ================= */
let queue = [];
const canManage = () => isHost; // 대기열 조작은 호스트(와 관리자)만. 올린 사람도 예외 없음
const thumb = (id) => el('img', { className: 'thumb', src: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, alt: '', width: 96, height: 54, loading: 'lazy' });
const iconBtn = (id, label, onclick) => {
  const b = el('button', { type: 'button', className: 'btn icon', title: label, onclick }, icon(id));
  b.setAttribute('aria-label', label); return b;
};
function renderQueue() {
  [...$('#qForm').elements].forEach((e) => (e.disabled = !canQueue)); $('#qPerm').hidden = canQueue; // 호스트가 허락한 사람만 올릴 수 있다
  const cur = ytWant && !ytWant.ended ? ytWant : null;
  $('#now').hidden = !cur;
  if (cur) {
    $('#nowThumb').src = `https://i.ytimg.com/vi/${cur.videoId}/mqdefault.jpg`;
    $('#nowTitle').textContent = cur.title || cur.videoId;
    $('#nowBy').textContent = cur.byName ? `${cur.byName} 님이 올렸어요 · 지금 재생 중` : '지금 재생 중';
    $('#nowSkip').hidden = !canManage();
  }
  const ul = $('#qList'); ul.replaceChildren();
  queue.forEach((q, i) => {
    const btns = el('div', { className: 'qbtns' });
    if (canManage()) {
      const grip = iconBtn('i-grip', '끌어서 순서 바꾸기', () => {}); grip.classList.add('grip');
      const up = iconBtn('i-up', '위로 옮기기', () => send({ t: 'queue-move', qid: q.qid, to: i - 1 })), down = iconBtn('i-down', '아래로 옮기기', () => send({ t: 'queue-move', qid: q.qid, to: i + 1 }));
      up.disabled = i === 0; down.disabled = i === queue.length - 1;
      btns.append(grip, up, down, iconBtn('i-play', '바로 재생', () => send({ t: 'queue-play', qid: q.qid })), iconBtn('i-x', '대기열에서 빼기', () => send({ t: 'queue-remove', qid: q.qid })));
      const li = el('li', {}, thumb(q.videoId), el('div', { className: 'qbody' }, el('div', { className: 'qt' }, el('b', { textContent: q.title || q.videoId }), el('small', { textContent: `${q.byName} 님이 올렸어요` })), btns));
      li.dataset.qid = q.qid; dragToReorder(grip, li, q, ul);
      ul.append(li);
    } else {
      const li = el('li', {}, thumb(q.videoId), el('div', { className: 'qbody' }, el('div', { className: 'qt' }, el('b', { textContent: q.title || q.videoId }), el('small', { textContent: `${q.byName} 님이 올렸어요` }))));
      li.dataset.qid = q.qid; ul.append(li); // 남이 올린 항목에도 번호를 달아 둔다
    }
  });
  $('#qEmpty').hidden = queue.length > 0 || !!cur;
  setDot('queue', queue.length);
}
// 끌어서 순서 바꾸기 (마우스·터치·펜 모두): 손잡이를 잡고 위아래로 끌면 다른 항목이 비켜서고, 놓으면 그 자리로 서버에 알린다
function dragToReorder(grip, li, q, ul) {
  grip.style.touchAction = 'none'; // 손잡이 위에서는 화면 스크롤 대신 끌기로 쓴다
  grip.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const items = [...ul.children], from = items.indexOf(li), rects = items.map((x) => x.getBoundingClientRect());
    const step = rects[from].height + parseFloat(getComputedStyle(ul).rowGap || 0), y0 = e.clientY;
    let to = from; li.classList.add('dragging');
    const move = (ev) => {
      const dy = ev.clientY - y0, mid = rects[from].top + rects[from].height / 2 + dy;
      li.style.transform = `translateY(${dy}px)`;
      to = rects.findIndex((r) => mid < r.top + r.height); // 끌고 있는 항목의 가운데가 걸친 칸이 새 위치 (맨 위 위쪽이면 0, 맨 아래 아래쪽이면 -1)
      if (to < 0) to = items.length - 1;
      items.forEach((x, i) => { if (x !== li) x.style.transform = from < to && i > from && i <= to ? `translateY(${-step}px)` : from > to && i >= to && i < from ? `translateY(${step}px)` : ''; });
    };
    const end = (ev) => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', end); grip.removeEventListener('pointercancel', end);
      li.classList.remove('dragging'); items.forEach((x) => (x.style.transform = ''));
      if (ev.type === 'pointerup' && to !== from) send({ t: 'queue-move', qid: q.qid, to });
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  });
}
$('#nowSkip').onclick = () => send({ t: 'yt-next' });
$('#qForm').onsubmit = (e) => {
  e.preventDefault();
  if (!canQueue) return;
  const id = ytId($('#qUrl').value.trim());
  $('#qMsg').textContent = id ? '' : '유튜브 링크를 알아볼 수 없어요. 주소 전체를 붙여 넣어 보세요.';
  if (!id) return;
  $('#qUrl').value = '';
  send({ t: 'queue-add', videoId: id });
};

/* ================= 화면 공유 (WebRTC 메시: 보는 사람마다 연결 1개) ================= */
// ponytail: 공유자가 시청자 수만큼 업로드. 10명 넘게 쓰려면 SFU(mediasoup/LiveKit)로 교체.
let localStream = null, shareStatus = '', shareTry = 0, chain = Promise.resolve();
const pcs = new Map();
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function makePc(id) {
  pcs.get(id)?.close();
  const pc = new RTCPeerConnection(rtcConfig);
  pc.onicecandidate = (e) => e.candidate && send({ t: 'rtc', to: id, data: { ice: e.candidate } });
  pc.ontrack = (e) => {
    screenEl.srcObject = e.streams[0];
    screenEl.play().catch(() => { screenEl.muted = true; screenEl.play(); });
  };
  pc.onconnectionstatechange = () => {
    if (pcs.get(id) !== pc) return; // 이미 교체된 연결의 이벤트는 무시
    const s = pc.connectionState;
    if (id !== sharerId) { if (s === 'failed' || s === 'closed') closePc(id); return; } // 공유하는 쪽: 실패한 시청자 연결은 정리만
    if (s === 'connected') { shareTry = 0; shareStatus = ''; connType(pc).then((t) => { if (pcs.get(id) === pc && t === 'relay') { shareStatus = '중계 서버 경유'; renderStage(); } }); }
    else if (s === 'disconnected') shareStatus = '연결이 불안정해요';
    else if (s === 'failed') {
      closePc(id);
      if (shareTry < 2) { shareTry++; shareStatus = '다시 연결하는 중'; setTimeout(() => sharerId && requestShare(true), 1500); }
      else {
        shareStatus = '연결 실패';
        sys('공유 화면에 연결하지 못했어요. 공유하는 사람과 네트워크가 달라서 직접 연결이 안 되는 경우일 수 있어요. 운영자가 중계(TURN) 서버를 설정하면 해결돼요.');
      }
    } else shareStatus = '연결 중';
    renderStage();
  };
  pcs.set(id, pc);
  return pc;
}
// 지금 어떤 경로로 연결됐는지: 'relay'면 중계(TURN) 서버를 거치는 중
async function connType(pc) {
  try {
    const stats = await pc.getStats();
    for (const r of stats.values()) {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') return stats.get(r.localCandidateId)?.candidateType;
    }
  } catch {}
}
function closePc(id) { pcs.get(id)?.close(); pcs.delete(id); }

async function onRtc(from, d) {
  if (d.k === 'v') return onVoiceRtc(from, d); // 음성 대화용 신호
  let pc = pcs.get(from);
  if (d.want) { // 시청자가 내 화면을 요청
    if (!localStream) return;
    pc = makePc(from);
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    await pc.setLocalDescription(await pc.createOffer());
    send({ t: 'rtc', to: from, data: { sdp: pc.localDescription } });
    // 시청자마다 같은 영상을 따로 올리므로 한 명당 전송량을 제한해 집 업로드 대역폭을 다 쓰지 않게 한다
    for (const snd of pc.getSenders()) {
      if (snd.track?.kind !== 'video') continue;
      try {
        const p = snd.getParameters();
        if (!p.encodings?.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 2_500_000; p.encodings[0].maxFramerate = 30;
        await snd.setParameters(p);
      } catch {}
    }
  } else if (d.sdp?.type === 'offer') { // 공유자의 offer
    pc = makePc(from);
    await pc.setRemoteDescription(d.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    send({ t: 'rtc', to: from, data: { sdp: pc.localDescription } });
  } else if (d.sdp && pc) await pc.setRemoteDescription(d.sdp);
  else if (d.ice && pc) await pc.addIceCandidate(d.ice);
}

function requestShare(retry) {
  if (!sharerId || sharerId === me) return;
  if (!retry) shareTry = 0;
  shareStatus = shareStatus || '연결 중';
  send({ t: 'rtc', to: sharerId, data: { want: true } });
  renderStage();
}
function remoteShareEnded() {
  pcs.forEach((pc, id) => closePc(id));
  if (!localStream) screenEl.srcObject = null;
  shareStatus = '';
}

async function startShare() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch { return sys('화면 공유를 시작하지 못했어요. https 주소에서 접속했는지 확인해 주세요.'); }
  localStream.getVideoTracks()[0].onended = stopShare;
  screenEl.srcObject = localStream;
  stageView = 'screen';
  send({ t: 'share-start' });
  renderStage();
}
function stopLocal() {
  if (!localStream) return;
  localStream.getTracks().forEach((t) => t.stop());
  localStream = null; screenEl.srcObject = null;
  pcs.forEach((pc, id) => closePc(id));
  renderStage();
}
function stopShare() { if (localStream) { stopLocal(); send({ t: 'share-stop' }); } }
$('#shareBtn').onclick = () => (localStream ? stopShare() : startShare());
$('#retryShare').onclick = () => { shareStatus = ''; requestShare(); };
