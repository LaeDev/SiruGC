/* ================= 음성 대화 (WebRTC 메시: 음성에 참가한 사람끼리 1:1 연결) ================= */
// ponytail: 사람 수만큼 연결이 늘어나는 메시 구조 (오디오는 가벼워서 8~10명까지는 충분). 더 늘리려면 SFU로 교체.
let mic = null, micMuted = false, voiceList = [];
const vpcs = new Map(); // 상대 id → { pc, audio }
const AC = window.AudioContext || window.webkitAudioContext;
let actx = null;
const levels = new Map(); // id → { an, buf }  (누가 말하는지 표시용)

const inVoice = () => !!mic;

async function joinVoice() {
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch { return sys('마이크를 쓸 수 없어요. 브라우저의 마이크 권한과 https 접속을 확인해 주세요.'); }
  micMuted = false;
  watchLevel(me, mic);
  send({ t: 'voice-join' });
  renderVoice();
}
function leaveVoice() {
  if (!mic) return;
  mic.getTracks().forEach((t) => t.stop());
  mic = null; levels.delete(me);
  [...vpcs.keys()].forEach(closeVpc);
  send({ t: 'voice-leave' });
  renderVoice();
}
function setMicMuted(muted) { // 패닉 버튼도 이 함수를 쓴다
  if (!mic || micMuted === muted) return;
  micMuted = muted;
  mic.getAudioTracks().forEach((t) => (t.enabled = !muted));
  send({ t: 'voice-mute', muted });
  renderVoice();
}

// 서버가 알려 준 음성 참가자 목록에 맞춰 연결을 정리한다.
// 두 사람 중 id가 작은 쪽이 항상 먼저 offer를 보낸다 → 동시에 보내서 엉키는 일이 없다.
function syncVoicePeers() {
  if (!mic) return;
  const ids = new Set(voiceList.map((v) => v.id));
  [...vpcs.keys()].filter((id) => !ids.has(id)).forEach(closeVpc);
  for (const v of voiceList) if (v.id !== me && !vpcs.has(v.id) && me < v.id) callPeer(v.id);
}
async function callPeer(id) {
  const pc = makeVpc(id);
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));
  await pc.setLocalDescription(await pc.createOffer());
  send({ t: 'rtc', to: id, data: { k: 'v', sdp: pc.localDescription } });
}
function makeVpc(id) {
  closeVpc(id);
  const pc = new RTCPeerConnection(rtcConfig);
  const audio = new Audio(); audio.autoplay = true; audio.muted = soundOff;
  vpcs.set(id, { pc, audio });
  pc.onicecandidate = (e) => e.candidate && send({ t: 'rtc', to: id, data: { k: 'v', ice: e.candidate } });
  pc.ontrack = (e) => { audio.srcObject = e.streams[0]; audio.play().catch(() => {}); watchLevel(id, e.streams[0]); };
  pc.onconnectionstatechange = () => {
    if (vpcs.get(id)?.pc !== pc || pc.connectionState !== 'failed') return; // 이미 교체된 연결의 이벤트는 무시
    closeVpc(id);
    if (mic && me < id && voiceList.some((v) => v.id === id)) setTimeout(() => !vpcs.has(id) && mic && callPeer(id), 1500);
  };
  return pc;
}
function closeVpc(id) {
  const v = vpcs.get(id); if (!v) return;
  vpcs.delete(id); levels.delete(id);
  v.pc.close(); v.audio.srcObject = null;
}
async function onVoiceRtc(from, d) {
  const v = vpcs.get(from);
  if (d.sdp?.type === 'offer') {
    if (!mic) return;
    const pc = makeVpc(from);
    mic.getTracks().forEach((t) => pc.addTrack(t, mic));
    await pc.setRemoteDescription(d.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    send({ t: 'rtc', to: from, data: { k: 'v', sdp: pc.localDescription } });
  } else if (d.sdp && v) await v.pc.setRemoteDescription(d.sdp);
  else if (d.ice && v) await v.pc.addIceCandidate(d.ice);
}

// ---- 누가 말하는지 (소리 크기를 보고 아바타 테두리를 키운다) ----
function watchLevel(id, stream) {
  if (!AC) return;
  actx ||= new AC();
  actx.resume?.();
  const an = actx.createAnalyser(); an.fftSize = 256;
  actx.createMediaStreamSource(stream).connect(an); // 스피커로는 연결하지 않음 (소리는 audio 요소가 낸다)
  levels.set(id, { an, buf: new Uint8Array(an.frequencyBinCount) });
}
setInterval(() => {
  for (const [id, { an, buf }] of levels) {
    an.getByteTimeDomainData(buf);
    let peak = 0; for (const x of buf) peak = Math.max(peak, Math.abs(x - 128));
    const speaking = peak > 14 && !(id === me && micMuted);
    document.querySelectorAll(`.av[data-id="${id}"]`).forEach((n) => n.classList.toggle('speaking', speaking));
  }
}, 150);

// ---- 버튼 ----
function renderVoice() {
  const on = inVoice();
  $('#voiceBtn').setAttribute('aria-pressed', on);
  $('#voiceIcon').innerHTML = `<use href="#${on ? 'i-phone-off' : 'i-mic'}"/>`;
  $('#voiceLbl').textContent = on ? '음성 나가기' : '음성 참가';
  $('#voiceBtn').setAttribute('aria-label', on ? '음성 대화에서 나가기' : '음성 대화에 참가');
  $('#micBtn').hidden = !on;
  $('#micIcon').innerHTML = `<use href="#${micMuted ? 'i-mic-off' : 'i-mic'}"/>`;
  $('#micLbl').textContent = micMuted ? '마이크 켜기' : '마이크 끄기';
  $('#micBtn').setAttribute('aria-label', micMuted ? '마이크 켜기' : '마이크 끄기');
  $('#micBtn').setAttribute('aria-pressed', micMuted);
  setTone($('#voiceBtn'), on ? 'stop' : 'go');
  setTone($('#micBtn'), micMuted ? 'stop' : 'go'); // 마이크 상태 색: 켜져 있으면 초록('끄기' 버튼), 꺼져 있으면 빨강('켜기' 버튼)
  renderUsers();
}
$('#voiceBtn').onclick = () => (inVoice() ? leaveVoice() : joinVoice());
$('#micBtn').onclick = () => setMicMuted(!micMuted);
addEventListener('pagehide', () => mic?.getTracks().forEach((t) => t.stop()));

handlers.voice = (m) => { voiceList = m.list; syncVoicePeers(); renderUsers(); };
