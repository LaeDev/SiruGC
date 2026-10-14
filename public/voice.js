/* ================= 음성 대화 (WebRTC 메시: 음성에 참가한 사람끼리 1:1 연결) ================= */
// ponytail: 사람 수만큼 연결이 늘어나는 메시 구조 (오디오는 가벼워서 8~10명까지는 충분). 더 늘리려면 SFU로 교체.
//
// 내 마이크: 마이크(micRaw) → 입력 크기 → [목소리 필터] → 음소거 → 처리된 스트림(mic) 을 상대에게 보낸다.
//            필터를 바꿔도 보내는 트랙(mic)은 그대로라서 연결을 다시 맺지 않는다.
// 상대 소리: WebAudio의 gain으로 재생한다. HTMLAudioElement.volume은 iOS에서 무시되고 100%를 넘길 수도 없어서.
let mic = null, micRaw = null, micMuted = false, voiceList = [];
const vpcs = new Map(); // 상대 id → { pc, audio, src, gain }
const AC = window.AudioContext || window.webkitAudioContext;
let actx = null, mg = null; // mg: 내 마이크 처리 그래프
const levels = new Map(); // id → { an, buf, src }  (누가 말하는지 표시용)
const dropLevel = (id) => { try { levels.get(id)?.src.disconnect(); } catch {} levels.delete(id); };

let voicePrefs = { mic: 100, ns: true, nsAmt: 100, dr: 0, ec: true, agc: true, monitor: false };
try { Object.assign(voicePrefs, JSON.parse(get('voicePrefs') || '{}')); } catch {}
delete voicePrefs.filter; // (옛 버전의 목소리 필터 설정은 버린다)
let voiceVol = {}; // 사람별 목소리 크기 (계정은 공개 번호 uid, 게스트는 'g:닉네임' → 0~2). 브라우저에 저장해서 다음에도 유지
try { voiceVol = JSON.parse(get('voiceVol') || '{}'); } catch {}
const saveVoicePrefs = () => set('voicePrefs', JSON.stringify(voicePrefs));

const inVoice = () => !!mic;
const audioCtx = () => {
  if (!actx) {
    try { actx = new AC({ sampleRate: 48000 }); } catch { actx = new AC(); } // 기기가 44.1k·96k 라도 48kHz 로 맞춘다 (AI 잡음 억제가 48kHz 용이고, 음성 통화도 48kHz 가 기본)
    actx.onstatechange = () => { applyAllVoiceVolumes(); if (actx.state !== 'running') actx.resume?.().catch(() => {}); };
  }
  if (actx.state !== 'running') actx.resume?.().catch(() => {});
  return actx;
};
// 오디오가 멈추면(탭 전환, 블루투스 기기 바뀜, 모바일 인터럽트 등) 보내는 소리도 받는 소리도 전부 사라진다 → 화면을 건드리거나 돌아올 때, 그리고 음성 중에는 주기적으로 되살린다
for (const ev of ['pointerdown', 'keydown', 'touchend', 'visibilitychange']) addEventListener(ev, () => { if (actx && actx.state !== 'running') actx.resume().catch(() => {}); }, { capture: true, passive: true });
setInterval(() => { if (actx && inVoice() && actx.state !== 'running') actx.resume().catch(() => {}); }, 2000);
addEventListener('pointerdown', () => actx?.state === 'suspended' && actx.resume?.(), { passive: true }); // 브라우저가 멈춰 둔 오디오를 첫 터치에 깨운다

/* ---------- AI 잡음 억제 (GTCRN 신경망, 이 기기 안에서만 실행) ----------
   브라우저 기본 잡음 억제는 키보드·선풍기·주변 말소리를 잘 못 지운다. 그래서 작은 신경망(GTCRN, MIT)을 AudioWorklet 으로 돌려서 목소리만 남긴다.
   "강도"는 처리한 소리와 원래 소리를 섞는 비율이다. 못 불러오면(구형 브라우저, 샘플레이트 불일치) 브라우저 기본 잡음 억제로 대신한다. 출처: public/vendor/gtcrn/NOTICE.txt */
let nsState = 'idle', nsWasm = null, nsCtx = null; // idle | ready | fail
const NS_NODE = '@sapphi-red/web-noise-suppressor/gtcrn', NS_LATENCY = 768 / 48000; // 48kHz에서 한 번에 768샘플씩 처리하므로 원래 소리도 그만큼 늦춰 섞는다
let nsLoading = null; // 불러오는 중이면 같은 약속을 돌려준다 (미리 불러오기와 음성 참가가 겹쳐도 한 번만)
const nsLoad = () => (nsLoading ||= nsLoadOnce().finally(() => { nsLoading = null; }));
async function nsLoadOnce() {
  if (nsState === 'fail') return false;
  try {
    const ctx = audioCtx();
    if (nsState === 'ready' && nsCtx === ctx) return true;
    if (!ctx.audioWorklet || (ctx.sampleRate !== 48000 && ctx.sampleRate !== 16000)) throw new Error('이 브라우저는 AI 잡음 억제를 쓸 수 없어요 (' + ctx.sampleRate + 'Hz)');
    if (!nsWasm) { const r = await fetch('/vendor/gtcrn/gtcrn.wasm?v=' + BUILD); if (!r.ok) throw new Error('모델 파일을 못 받았어요'); nsWasm = await r.arrayBuffer(); }
    if (nsCtx !== ctx) { await ctx.audioWorklet.addModule('/vendor/gtcrn/workletProcessor.js?v=' + BUILD); nsCtx = ctx; }
    nsState = 'ready'; return true;
  } catch (e) { console.warn('AI 잡음 억제를 못 켜서 브라우저 기본 잡음 억제를 써요:', e.message); nsState = 'fail'; return false; }
}
// 음성에 참가하는 순간 기다리지 않도록, 화면이 뜨고 잠시 뒤에 모델을 미리 불러와 둔다 (오디오 컨텍스트는 첫 터치에 깨어난다)
addEventListener('load', () => { if (AC && voicePrefs.ns) setTimeout(() => nsLoad(), 1200); });
const nsActive = () => voicePrefs.ns && nsState === 'ready' && nsCtx === actx;
function makeNs(ctx, amt) { // 입력 → (AI 처리본 × 강도 + 원래 소리 × (1-강도)) → 출력
  const input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain(), delay = ctx.createDelay(0.1);
  const ai = new AudioWorkletNode(ctx, NS_NODE, { processorOptions: { maxChannels: 1, wasmBinary: nsWasm }, channelCount: 1, channelCountMode: 'explicit', numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  delay.delayTime.value = ctx.sampleRate === 48000 ? NS_LATENCY : 256 / 16000;
  const setAmt = (a) => { wet.gain.value = a / 100; dry.gain.value = 1 - a / 100; };
  setAmt(amt);
  input.connect(ai).connect(wet).connect(output); input.connect(delay).connect(dry).connect(output);
  return { input, output, setAmt, stop() { try { ai.port.postMessage('destroy'); } catch {} [input, ai, wet, dry, delay, output].forEach((n) => { try { n.disconnect(); } catch {} }); } };
}
/* ---------- 울림 줄이기 (방에서 울리는 소리) ----------
   잡음 억제 모델은 울림을 따로 다루지 않아서, 늦게 따라오는 소리를 빼는 작은 워커(public/dereverb.js)를 뒤에 붙인다. 0%면 그래프에 넣지 않는다. */
const DR_MAX = 2; // 슬라이더 100% 일 때 워커의 'amount'
let drCtx = null, drFail = false;
async function drLoad() {
  try {
    const ctx = audioCtx();
    if (drCtx === ctx) return true;
    if (drFail || !ctx.audioWorklet) return false;
    await ctx.audioWorklet.addModule('/dereverb.js?v=' + BUILD); drCtx = ctx; return true;
  } catch (e) { console.warn('울림 줄이기를 못 켜요:', e.message); drFail = true; return false; }
}
function makeDr(ctx, pct) {
  const node = new AudioWorkletNode(ctx, 'dereverb', { channelCount: 1, channelCountMode: 'explicit', numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const setAmt = (p) => { node.parameters.get('amount').value = p / 100 * DR_MAX; };
  setAmt(pct);
  return { input: node, output: node, setAmt, stop() { try { node.disconnect(); } catch {} } };
}
// 입력 크기 → (AI 잡음 억제) → (울림 줄이기) → 필터 → 음소거 → 보낼 스트림
function buildMicGraph(raw) {
  const ctx = audioCtx();
  const src = ctx.createMediaStreamSource(raw), inGain = ctx.createGain(), out = ctx.createGain(), dest = ctx.createMediaStreamDestination();
  inGain.gain.value = voicePrefs.mic / 100;
  src.connect(inGain); out.connect(dest);
  mg = { src, inGain, out, dest, chain: null };
  wireFilter();
  return dest.stream;
}
function wireFilter() {
  if (!mg) return;
  mg.ns?.stop(); mg.ns = null; mg.dr?.stop(); mg.dr = null; try { mg.inGain.disconnect(); } catch {}
  let tail = mg.inGain;
  if (nsActive()) { try { mg.ns = makeNs(actx, voicePrefs.nsAmt); tail.connect(mg.ns.input); tail = mg.ns.output; } catch (e) { console.warn(e); mg.ns = null; nsState = 'fail'; } }
  if (voicePrefs.dr > 0 && drCtx === actx) { try { mg.dr = makeDr(actx, voicePrefs.dr); tail.connect(mg.dr.input); tail = mg.dr.output; } catch (e) { console.warn(e); mg.dr = null; drFail = true; } }
  tail.connect(mg.out);
  try { mg.out.disconnect(actx.destination); } catch {}
  if (voicePrefs.monitor) mg.out.connect(actx.destination); // 내 목소리 들어 보기 (이어폰 권장)
}
const browserNs = () => voicePrefs.ns && !nsActive(); // AI 잡음 억제를 쓰면 브라우저 것은 끈다 (겹쳐 쓰면 목소리가 뭉개진다)
function applyMicConstraints() { // 켜져 있는 마이크에도 바로 적용
  micRaw?.getAudioTracks().forEach((t) => t.applyConstraints({ echoCancellation: voicePrefs.ec, noiseSuppression: browserNs(), autoGainControl: voicePrefs.agc }).catch(() => {}));
}

let joining = false, joinGen = 0; // 마이크를 여는 동안 또 눌러도 두 번 열지 않고, 그 사이에 나가기를 눌렀으면 뒤늦게 참가되지 않게
async function joinVoice() {
  if (mic || joining) return;
  joining = true; const gen = ++joinGen; let raw;
  if (AC && voicePrefs.ns) await nsLoad(); // 마이크를 열기 전에 AI 잡음 억제를 준비해서, 쓸 수 있으면 브라우저 것을 끈다
  if (AC && voicePrefs.dr) await drLoad();
  try {
    raw = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: voicePrefs.ec, noiseSuppression: browserNs(), autoGainControl: voicePrefs.agc } });
  } catch { joining = false; return sys('마이크를 쓸 수 없어요. 브라우저의 마이크 권한과 https 접속을 확인해 주세요.'); }
  joining = false;
  if (gen !== joinGen || mic) { raw.getTracks().forEach((t) => t.stop()); return; }
  micRaw = raw;
  try { mic = AC ? buildMicGraph(micRaw) : micRaw; } catch (e) { console.warn('마이크 처리를 못 만들어 원래 소리로 보내요', e); mic = micRaw; mg = null; }
  micMuted = false;
  watchLevel(me, mic);
  send({ t: 'voice-join' });
  renderVoice();
}
function leaveVoice() {
  joinGen++; // 열리는 중이던 마이크가 있으면 버린다
  if (!mic) return;
  micRaw?.getTracks().forEach((t) => t.stop());
  mic.getTracks().forEach((t) => t.stop());
  if (mg) { mg.ns?.stop(); mg.dr?.stop(); [mg.src, mg.inGain, mg.out].forEach((n) => { try { n.disconnect(); } catch {} }); mg = null; }
  mic = micRaw = null; dropLevel(me);
  [...vpcs.keys()].forEach(closeVpc);
  send({ t: 'voice-leave' });
  renderVoice();
}
function setMicMuted(muted) { // 패닉 버튼도 이 함수를 쓴다
  if (!mic || micMuted === muted) return;
  micMuted = muted;
  [mic, micRaw].forEach((st) => st?.getAudioTracks().forEach((t) => (t.enabled = !muted)));
  send({ t: 'voice-mute', muted });
  renderVoice();
}

/* ---------- 상대 소리 크기 ---------- */
const volKey = (u) => u.uid || 'g:' + u.name;
const volOf = (id) => { const u = users.find((x) => x.id === id); return (u && voiceVol[volKey(u)]) ?? 1; };
function applyVoiceVolume(id) {
  const v = vpcs.get(id); if (!v) return;
  const vol = soundOff ? 0 : volOf(id);
  if (v.gain && actx?.state === 'running') { v.gain.gain.value = vol; v.audio.muted = true; }
  else { v.audio.muted = vol === 0; v.audio.volume = Math.min(1, vol); } // WebAudio가 멈춰 있거나 없을 때: 100%를 넘는 키우기는 안 되지만 소리는 난다
}
function applyAllVoiceVolumes() { for (const id of vpcs.keys()) applyVoiceVolume(id); }
function setVoiceVolume(key, pct) {
  voiceVol[key] = pct / 100; set('voiceVol', JSON.stringify(voiceVol)); applyAllVoiceVolumes();
}
function volumeControl(u) { // 참가자를 눌렀을 때 나오는 메뉴에 들어간다
  const pct = Math.round((voiceVol[volKey(u)] ?? 1) * 100);
  const out = el('output', { textContent: pct + '%' });
  const input = el('input', { type: 'range', className: 'vol', min: 0, max: 200, step: 5, value: pct });
  input.setAttribute('aria-label', `${u.name} 목소리 크기`);
  input.oninput = () => { out.textContent = input.value + '%'; setVoiceVolume(volKey(u), +input.value); };
  return el('label', { className: 'volrow' }, el('span', { textContent: '목소리 크기' }), input, out);
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
  const sid = Math.random().toString(36).slice(2, 10), pc = makeVpc(id, sid);
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));
  const { dead } = vpcs.get(id);
  await Promise.race([pc.setLocalDescription(await Promise.race([pc.createOffer(), dead])), dead]);
  if (vpcs.get(id)?.pc !== pc) return; // 그 사이에 닫혔거나 교체됨
  send({ t: 'rtc', to: id, data: { k: 'v', s: sid, sdp: pc.localDescription } });
}
// 연결이 막혔을 때 다시 맺는다. 거는 쪽(id가 작은 쪽)이면 직접, 받는 쪽이면 다시 걸어 달라고 알린다
function retryPeer(id, pc) {
  if (vpcs.get(id)?.pc !== pc || !mic || !voiceList.some((v) => v.id === id)) return;
  closeVpc(id);
  if (me < id) callPeer(id); else send({ t: 'rtc', to: id, data: { k: 'v', redo: true } });
}
function makeVpc(id, sid) {
  closeVpc(id);
  const pc = new RTCPeerConnection(rtcConfig);
  const audio = new Audio(); audio.autoplay = true;
  let kill; const dead = new Promise((_, no) => (kill = no)); dead.catch(() => {});
  vpcs.set(id, { pc, audio, sid, dead, kill, src: null, gain: null, timer: setTimeout(() => pc.connectionState !== 'connected' && retryPeer(id, pc), 12000) });
  pc.onicecandidate = (e) => e.candidate && send({ t: 'rtc', to: id, data: { k: 'v', s: sid, ice: e.candidate } });
  pc.ontrack = (e) => {
    const v = vpcs.get(id); if (!v || v.pc !== pc) return;
    const stream = e.streams[0];
    audio.srcObject = stream;
    try { v.src?.disconnect(); v.gain?.disconnect(); } catch {} // 같은 연결에서 트랙이 또 오면 지난 경로를 걷어 낸다 (소리가 겹치지 않게)
    if (AC) { // 소리는 WebAudio로 낸다. 요소는 스트림을 깨우는 용도로만 두고 음소거
      const ctx = audioCtx();
      v.src = ctx.createMediaStreamSource(stream); v.gain = ctx.createGain();
      v.src.connect(v.gain).connect(ctx.destination);
      audio.muted = true;
    }
    audio.play().catch(() => {});
    applyVoiceVolume(id); watchLevel(id, stream);
  };
  pc.onconnectionstatechange = () => {
    if (vpcs.get(id)?.pc !== pc) return; // 이미 교체된 연결의 이벤트는 무시
    if (pc.connectionState === 'failed') retryPeer(id, pc);
    else if (pc.connectionState === 'disconnected') setTimeout(() => pc.connectionState === 'disconnected' && retryPeer(id, pc), 5000);
  };
  return pc;
}
function closeVpc(id) {
  const v = vpcs.get(id); if (!v) return;
  vpcs.delete(id); dropLevel(id); clearTimeout(v.timer); v.kill(new Error('연결이 닫혔어요'));
  try { v.src?.disconnect(); v.gain?.disconnect(); } catch {}
  v.pc.close(); v.audio.srcObject = null;
}
async function onVoiceRtc(from, d) {
  if (d.redo) { // 받는 쪽이 연결을 잃어서 다시 걸어 달라고 함
    if (mic && me < from && voiceList.some((v) => v.id === from)) callPeer(from);
    return;
  }
  if (d.sdp?.type === 'offer') {
    if (!mic) return;
    const pc = makeVpc(from, d.s), { dead } = vpcs.get(from), until = (p) => Promise.race([p, dead]);
    mic.getTracks().forEach((t) => pc.addTrack(t, mic));
    await until(pc.setRemoteDescription(d.sdp));
    await until(pc.setLocalDescription(await until(pc.createAnswer())));
    if (vpcs.get(from)?.pc !== pc) return;
    send({ t: 'rtc', to: from, data: { k: 'v', s: d.s, sdp: pc.localDescription } });
    return;
  }
  const v = vpcs.get(from);
  if (!v || v.sid !== d.s) return; // 지난 연결에 대한 늦은 응답·후보는 버린다
  if (d.sdp) { if (v.pc.signalingState === 'have-local-offer') await Promise.race([v.pc.setRemoteDescription(d.sdp), v.dead]); }
  else if (d.ice) await Promise.race([v.pc.addIceCandidate(d.ice), v.dead]);
}

// ---- 누가 말하는지 (소리 크기를 보고 아바타 테두리를 키운다) ----
function watchLevel(id, stream) {
  if (!AC) return;
  const ctx = audioCtx();
  dropLevel(id);
  const an = ctx.createAnalyser(), src = ctx.createMediaStreamSource(stream); an.fftSize = 256;
  src.connect(an); // 스피커로는 연결하지 않음 (소리는 위의 gain 경로가 낸다)
  levels.set(id, { an, buf: new Uint8Array(an.frequencyBinCount), src });
}
// 디스코드처럼 조금이라도 소리가 들리면 바로 켠다: 작게 말해도 보이도록 기준을 낮추고(128 중 5), 0.05초마다 본다
const SPEAK_PEAK = 5, SPEAK_HOLD = 400;
setInterval(() => {
  const now = Date.now();
  for (const [id, L] of levels) {
    L.an.getByteTimeDomainData(L.buf);
    let peak = 0; for (const x of L.buf) peak = Math.max(peak, Math.abs(x - 128));
    if (peak > SPEAK_PEAK && !(id === me && micMuted)) L.until = now + SPEAK_HOLD;
    const speaking = (L.until || 0) > now;
    document.querySelectorAll(`.av[data-id="${id}"]`).forEach((n) => n.classList.toggle('speaking', speaking)); // 목록이 다시 그려져도 바로 맞춰진다
  }
}, 50);

// 칩을 누르면 뜨는 작은 창: 그 사람 목소리 크기 (내 칩이면 내 마이크 입력 크기)
let vpopFor = null;
function closeVpop() { $('#vpop')?.remove(); vpopFor = null; }
function openVpop(chip, u) {
  closeVpop(); vpopFor = u.id;
  const body = u.id === me ? micGainControl() : volumeControl(u);
  const pop = el('div', { id: 'vpop', className: 'vpop', role: 'dialog' }, el('b', { textContent: u.id === me ? '내 마이크' : u.name }), body);
  pop.setAttribute('aria-label', u.id === me ? '내 마이크 입력 크기' : `${u.name} 목소리 크기`);
  document.body.append(pop);
  const r = chip.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + 'px';
  pop.style.top = (r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(innerHeight - h - 8, r.bottom + 8)) + 'px';
  pop.querySelector('input')?.focus({ preventScroll: true });
}
function micGainControl() {
  const out = el('output', { textContent: voicePrefs.mic + '%' });
  const input = el('input', { type: 'range', className: 'vol', min: 0, max: 200, step: 5, value: voicePrefs.mic });
  input.setAttribute('aria-label', '내 마이크 입력 크기');
  input.oninput = () => { voicePrefs.mic = +input.value; out.textContent = voicePrefs.mic + '%'; saveVoicePrefs(); if (mg) mg.inGain.gain.value = voicePrefs.mic / 100; $('#micGain').value = voicePrefs.mic; $('#micGainOut').textContent = voicePrefs.mic + '%'; };
  return el('label', { className: 'volrow' }, el('span', { textContent: '입력 크기' }), input, out);
}
document.addEventListener('pointerdown', (e) => { if (vpopFor && !e.target.closest('#vpop, .vp.clk')) closeVpop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && vpopFor) { const id = vpopFor; closeVpop(); document.querySelector(`.vp .av[data-id="${id}"]`)?.closest('.vp')?.focus(); } });
addEventListener('resize', closeVpop);

// ---- 영상/공유 화면 아래 음성 참가자 바: 누가 음성에 있고 누가 말하는지 (말하는 사람은 아바타 테두리가 커진다) ----
function renderVoiceBar() {
  const bar = $('#voiceBar'); if (!bar) return;
  const inV = voiceList.map((v) => ({ v, u: users.find((x) => x.id === v.id) })).filter((x) => x.u);
  bar.hidden = !inV.length;
  bar.replaceChildren(...inV.map(({ v, u }) => {
    const chip = el('div', { className: 'vp', role: 'listitem' }, avEl(u), el('span', { className: 'nm', textContent: u.id === me ? '나' : u.name }));
    chip.setAttribute('aria-label', `${u.id === me ? '나' : u.name}${v.muted ? ', 마이크 꺼짐' : ''}`);
    chip.title = `${u.name} (눌러서 ${u.id === me ? '마이크 입력 크기' : '목소리 크기'} 조절)`;
    chip.classList.add('clk'); chip.tabIndex = 0; chip.setAttribute('aria-haspopup', 'dialog');
    chip.onclick = () => (vpopFor === u.id ? closeVpop() : openVpop(chip, u));
    chip.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chip.onclick(); } };
    if (v.muted) { const m = icon('i-mic-off'); m.setAttribute('class', 'i vi'); chip.append(m); }
    return chip;
  }));
}

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
addEventListener('pagehide', () => { micRaw?.getTracks().forEach((t) => t.stop()); mic?.getTracks().forEach((t) => t.stop()); });

// ---- 설정 창의 '음성' 항목 ----
{
  const sync = () => {
    $('#micGain').value = voicePrefs.mic; $('#micGainOut').textContent = voicePrefs.mic + '%';
    $('#nsAmt').value = voicePrefs.nsAmt; $('#nsAmtOut').textContent = voicePrefs.nsAmt + '%'; nsNote();
    $('#drAmt').value = voicePrefs.dr; $('#drAmtOut').textContent = voicePrefs.dr + '%'; drNote();
    $('#nsOn').checked = voicePrefs.ns; $('#ecOn').checked = voicePrefs.ec; $('#agcOn').checked = voicePrefs.agc; $('#monOn').checked = voicePrefs.monitor;
  };
  $('#micGain').oninput = (e) => { voicePrefs.mic = +e.target.value; $('#micGainOut').textContent = voicePrefs.mic + '%'; saveVoicePrefs(); if (mg) mg.inGain.gain.value = voicePrefs.mic / 100; };
  for (const [id, key] of [['#ecOn', 'ec'], ['#agcOn', 'agc']]) $(id).onchange = (e) => { voicePrefs[key] = e.target.checked; saveVoicePrefs(); applyMicConstraints(); };
  const nsNote = () => { $('#nsNote').textContent = !voicePrefs.ns ? '' : nsState === 'fail' ? '이 브라우저에서는 AI 잡음 억제를 못 써서 브라우저 기본 잡음 억제를 쓰고 있어요.' : nsActive() ? 'AI 잡음 억제를 쓰고 있어요. 소리는 이 기기 안에서만 처리돼요.' : '음성에 참가하면 AI 잡음 억제가 켜져요.'; };
  $('#nsOn').onchange = async (e) => { voicePrefs.ns = e.target.checked; saveVoicePrefs(); if (voicePrefs.ns && mg) await nsLoad(); wireFilter(); applyMicConstraints(); nsNote(); };
  $('#nsAmt').oninput = (e) => { voicePrefs.nsAmt = +e.target.value; $('#nsAmtOut').textContent = voicePrefs.nsAmt + '%'; saveVoicePrefs(); mg?.ns?.setAmt(voicePrefs.nsAmt); };
  const drNote = () => { $('#drNote').textContent = voicePrefs.dr > 0 && drFail ? '이 브라우저에서는 울림 줄이기를 쓸 수 없어요.' : ''; };
  $('#drAmt').oninput = async (e) => {
    voicePrefs.dr = +e.target.value; $('#drAmtOut').textContent = voicePrefs.dr + '%'; saveVoicePrefs();
    if (voicePrefs.dr) await drLoad();
    drNote();
    if (!mg) return;
    if (!!mg.dr === (voicePrefs.dr > 0 && drCtx === actx)) mg.dr?.setAmt(voicePrefs.dr); else wireFilter(); // 켜짐↔꺼짐이 바뀔 때만 그래프를 다시 짠다
  };
  $('#monOn').onchange = (e) => { voicePrefs.monitor = e.target.checked; saveVoicePrefs(); wireFilter(); };
  sync();
}

handlers.voice = (m) => { voiceList = m.list; syncVoicePeers(); renderUsers(); };
