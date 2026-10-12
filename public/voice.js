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

const VOICE_FILTERS = { off: '원래 목소리', high: '높은 목소리', low: '낮은 목소리', robot: '로봇', radio: '라디오', cave: '동굴' };
let voicePrefs = { filter: 'off', mic: 100, ns: true, ec: true, agc: true, monitor: false };
try { Object.assign(voicePrefs, JSON.parse(get('voicePrefs') || '{}')); } catch {}
if (!VOICE_FILTERS[voicePrefs.filter]) voicePrefs.filter = 'off';
let voiceVol = {}; // 사람별 목소리 크기 (공개 번호 uid → 0~2). 브라우저에 저장해서 다음에도 유지
try { voiceVol = JSON.parse(get('voiceVol') || '{}'); } catch {}
const saveVoicePrefs = () => set('voicePrefs', JSON.stringify(voicePrefs));

const inVoice = () => !!mic;
const audioCtx = () => {
  if (!actx) {
    actx = new AC();
    actx.onstatechange = () => { applyAllVoiceVolumes(); if (actx.state !== 'running') actx.resume?.().catch(() => {}); };
  }
  if (actx.state !== 'running') actx.resume?.().catch(() => {});
  return actx;
};
// 오디오가 멈추면(탭 전환, 블루투스 기기 바뀜, 모바일 인터럽트 등) 보내는 소리도 받는 소리도 전부 사라진다 → 화면을 건드리거나 돌아올 때, 그리고 음성 중에는 주기적으로 되살린다
for (const ev of ['pointerdown', 'keydown', 'touchend', 'visibilitychange']) addEventListener(ev, () => { if (actx && actx.state !== 'running') actx.resume().catch(() => {}); }, { capture: true, passive: true });
setInterval(() => { if (actx && inVoice() && actx.state !== 'running') actx.resume().catch(() => {}); }, 2000);
addEventListener('pointerdown', () => actx?.state === 'suspended' && actx.resume?.(), { passive: true }); // 브라우저가 멈춰 둔 오디오를 첫 터치에 깨운다

/* ---------- 목소리 필터 ---------- */
// 높낮이 바꾸기: 소리를 지연선에 통과시키며 지연 시간을 톱니파로 흔든다(도플러 효과). 두 개를 반 주기씩 어긋나게 번갈아 섞어서 끊김을 가린다.
// ratio > 1 이면 높아지고 < 1 이면 낮아진다. 지연이 줄어드는 속도가 (ratio-1)이다.
function makePitchShifter(ctx, ratio) {
  const P = 0.1, slope = Math.abs(ratio - 1), range = slope * P, base = 0.02, up = ratio > 1;
  const len = Math.round(P * ctx.sampleRate);
  const saw = ctx.createBuffer(1, len, ctx.sampleRate), win = ctx.createBuffer(1, len, ctx.sampleRate);
  const s = saw.getChannelData(0), w = win.getChannelData(0);
  for (let i = 0; i < len; i++) { const ph = i / len; s[i] = up ? 1 - ph : ph; w[i] = Math.sin(Math.PI * ph) ** 2; }
  const input = ctx.createGain(), output = ctx.createGain(), nodes = [input, output], sources = [];
  const t0 = ctx.currentTime + 0.05;
  for (const offset of [0, P / 2]) {
    const delay = ctx.createDelay(1); delay.delayTime.value = base;
    const depth = ctx.createGain(); depth.gain.value = range;
    const weight = ctx.createGain(); weight.gain.value = 0;
    const mod = ctx.createBufferSource(), fade = ctx.createBufferSource();
    mod.buffer = saw; fade.buffer = win; mod.loop = fade.loop = true;
    mod.connect(depth).connect(delay.delayTime); fade.connect(weight.gain);
    input.connect(delay); delay.connect(weight).connect(output);
    mod.start(t0 + offset); fade.start(t0 + offset);
    sources.push(mod, fade); nodes.push(delay, depth, weight);
  }
  return { input, output, stop() { sources.forEach((x) => { try { x.stop(); } catch {} }); nodes.forEach((n) => { try { n.disconnect(); } catch {} }); } };
}
// 목소리를 바꾸는 효과 하나를 만든다 (입력 노드 → 출력 노드). 효과가 없으면 null.
function makeFilter(ctx, kind) {
  const input = ctx.createGain(), output = ctx.createGain(), nodes = [input, output], extra = [];
  const done = () => ({ input, output, stop() { extra.forEach((o) => { try { o.stop(); } catch {} }); nodes.forEach((n) => { try { n.disconnect(); } catch {} }); } });
  const node = (n) => (nodes.push(n), n);
  if (kind === 'high' || kind === 'low') { const p = makePitchShifter(ctx, kind === 'high' ? 1.35 : 0.75); input.connect(p.input); p.output.connect(output); return { input, output, stop() { p.stop(); [input, output].forEach((n) => { try { n.disconnect(); } catch {} }); } }; }
  if (kind === 'robot') { // 링 변조: 목소리에 70Hz 사인파를 곱하면 금속성 소리가 난다. 원음을 조금 섞어 알아듣기 쉽게
    const ring = node(ctx.createGain()), dry = node(ctx.createGain()), osc = ctx.createOscillator();
    ring.gain.value = 0; dry.gain.value = 0.3; osc.frequency.value = 70; osc.connect(ring.gain); osc.start(); extra.push(osc);
    input.connect(ring).connect(output); input.connect(dry).connect(output); return done();
  }
  if (kind === 'radio') { // 좁은 대역 + 살짝 찌그러뜨리기: 무전기/라디오 느낌
    const hp = node(ctx.createBiquadFilter()), lp = node(ctx.createBiquadFilter()), sh = node(ctx.createWaveShaper());
    hp.type = 'highpass'; hp.frequency.value = 600; lp.type = 'lowpass'; lp.frequency.value = 3200;
    const curve = new Float32Array(257); for (let i = 0; i < 257; i++) { const x = (i / 128) - 1; curve[i] = Math.tanh(x * 3) / Math.tanh(3); }
    sh.curve = curve; input.connect(hp).connect(lp).connect(sh).connect(output); return done();
  }
  if (kind === 'cave') { // 되울리는 소리: 지연 + 되먹임 + 어두운 음색
    const dry = node(ctx.createGain()), delay = node(ctx.createDelay(1)), fb = node(ctx.createGain()), lp = node(ctx.createBiquadFilter()), wet = node(ctx.createGain());
    dry.gain.value = 0.75; delay.delayTime.value = 0.16; fb.gain.value = 0.45; lp.type = 'lowpass'; lp.frequency.value = 2400; wet.gain.value = 0.6;
    input.connect(dry).connect(output); input.connect(delay); delay.connect(lp).connect(fb).connect(delay); lp.connect(wet).connect(output); return done();
  }
  return null;
}
// 입력 크기 → 필터 → 음소거 → 보낼 스트림
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
  mg.chain?.stop(); try { mg.inGain.disconnect(); } catch {}
  mg.chain = makeFilter(actx, voicePrefs.filter);
  if (mg.chain) { mg.inGain.connect(mg.chain.input); mg.chain.output.connect(mg.out); } else mg.inGain.connect(mg.out);
  try { mg.out.disconnect(actx.destination); } catch {}
  if (voicePrefs.monitor) mg.out.connect(actx.destination); // 내 목소리 들어 보기 (이어폰 권장)
}
function applyMicConstraints() { // 켜져 있는 마이크에도 바로 적용
  micRaw?.getAudioTracks().forEach((t) => t.applyConstraints({ echoCancellation: voicePrefs.ec, noiseSuppression: voicePrefs.ns, autoGainControl: voicePrefs.agc }).catch(() => {}));
}

let joining = false, joinGen = 0; // 마이크를 여는 동안 또 눌러도 두 번 열지 않고, 그 사이에 나가기를 눌렀으면 뒤늦게 참가되지 않게
async function joinVoice() {
  if (mic || joining) return;
  joining = true; const gen = ++joinGen; let raw;
  try {
    raw = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: voicePrefs.ec, noiseSuppression: voicePrefs.ns, autoGainControl: voicePrefs.agc } });
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
  if (mg) { mg.chain?.stop(); [mg.src, mg.inGain, mg.out].forEach((n) => { try { n.disconnect(); } catch {} }); mg = null; }
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
const volOf = (id) => voiceVol[users.find((u) => u.id === id)?.uid] ?? 1;
function applyVoiceVolume(id) {
  const v = vpcs.get(id); if (!v) return;
  const vol = soundOff ? 0 : volOf(id);
  if (v.gain && actx?.state === 'running') { v.gain.gain.value = vol; v.audio.muted = true; }
  else { v.audio.muted = vol === 0; v.audio.volume = Math.min(1, vol); } // WebAudio가 멈춰 있거나 없을 때: 100%를 넘는 키우기는 안 되지만 소리는 난다
}
function applyAllVoiceVolumes() { for (const id of vpcs.keys()) applyVoiceVolume(id); }
function setVoiceVolume(uid, pct) {
  voiceVol[uid] = pct / 100; set('voiceVol', JSON.stringify(voiceVol)); applyAllVoiceVolumes();
}
function volumeControl(u) { // 참가자를 눌렀을 때 나오는 메뉴에 들어간다
  const pct = Math.round((voiceVol[u.uid] ?? 1) * 100);
  const out = el('output', { textContent: pct + '%' });
  const input = el('input', { type: 'range', className: 'vol', min: 0, max: 200, step: 5, value: pct });
  input.setAttribute('aria-label', `${u.name} 목소리 크기`);
  input.oninput = () => { out.textContent = input.value + '%'; setVoiceVolume(u.uid, +input.value); };
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
setInterval(() => {
  for (const [id, { an, buf }] of levels) {
    an.getByteTimeDomainData(buf);
    let peak = 0; for (const x of buf) peak = Math.max(peak, Math.abs(x - 128));
    const speaking = peak > 14 && !(id === me && micMuted);
    document.querySelectorAll(`.av[data-id="${id}"]`).forEach((n) => n.classList.toggle('speaking', speaking));
  }
}, 150);

// ---- 영상/공유 화면 아래 음성 참가자 바: 누가 음성에 있고 누가 말하는지 (말하는 사람은 아바타 테두리가 커진다) ----
function renderVoiceBar() {
  const bar = $('#voiceBar'); if (!bar) return;
  const inV = voiceList.map((v) => ({ v, u: users.find((x) => x.id === v.id) })).filter((x) => x.u);
  bar.hidden = !inV.length;
  bar.replaceChildren(...inV.map(({ v, u }) => {
    const chip = el('div', { className: 'vp', role: 'listitem' }, avEl(u), el('span', { className: 'nm', textContent: u.id === me ? '나' : u.name }));
    chip.setAttribute('aria-label', `${u.id === me ? '나' : u.name}${v.muted ? ', 마이크 꺼짐' : ''}`);
    chip.title = u.name;
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
  const sel = $('#vfSel');
  for (const [k, label] of Object.entries(VOICE_FILTERS)) sel.append(el('option', { value: k, textContent: label }));
  const sync = () => {
    sel.value = voicePrefs.filter; $('#micGain').value = voicePrefs.mic; $('#micGainOut').textContent = voicePrefs.mic + '%';
    $('#nsOn').checked = voicePrefs.ns; $('#ecOn').checked = voicePrefs.ec; $('#agcOn').checked = voicePrefs.agc; $('#monOn').checked = voicePrefs.monitor;
  };
  sel.onchange = () => { voicePrefs.filter = sel.value; saveVoicePrefs(); wireFilter(); };
  $('#micGain').oninput = (e) => { voicePrefs.mic = +e.target.value; $('#micGainOut').textContent = voicePrefs.mic + '%'; saveVoicePrefs(); if (mg) mg.inGain.gain.value = voicePrefs.mic / 100; };
  for (const [id, key] of [['#nsOn', 'ns'], ['#ecOn', 'ec'], ['#agcOn', 'agc']]) $(id).onchange = (e) => { voicePrefs[key] = e.target.checked; saveVoicePrefs(); applyMicConstraints(); };
  $('#monOn').onchange = (e) => { voicePrefs.monitor = e.target.checked; saveVoicePrefs(); wireFilter(); };
  sync();
}

handlers.voice = (m) => { voiceList = m.list; syncVoicePeers(); renderUsers(); };
