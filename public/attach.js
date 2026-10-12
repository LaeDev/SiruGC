/* ================= 사진·동영상 첨부 (채팅과 쪽지) ================= */
// 흐름: 파일 고르기(버튼/붙여넣기/끌어다 놓기) → 사진은 필요하면 줄이기 → /upload 로 올리기(진행률) → 받은 주소를 채팅/쪽지 메시지에 붙여 보내기.
// 서버가 다시 확인하므로 여기서 주소를 만들어 보내도 우리가 저장한 파일이 아니면 무시된다.
let uploadToken = '';
const IMG_KEEP_BYTES = 1.5 * 1024 * 1024, IMG_KEEP_DIM = 2048, IMG_TARGET = 1600;
const mediaKind = (f) => (f.type.startsWith('image/') ? 'image' : /^video\/(mp4|webm|quicktime)$/.test(f.type) ? 'video' : null);

const decodeImage = async (file) => {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } // 폰 사진의 회전 정보를 반영
  catch {
    return new Promise((ok, no) => { const i = new Image(), u = URL.createObjectURL(file); i.onload = () => { URL.revokeObjectURL(u); ok(i); }; i.onerror = () => no(new Error('이 사진은 이 브라우저에서 열 수 없어요. 다른 형식(JPG, PNG)으로 올려 주세요.')); i.src = u; });
  }
};
// 작은 사진(스크린샷 같은 PNG 포함)은 화질이 변하지 않게 그대로 올리고, 큰 사진만 1600px JPEG로 줄인다. GIF는 움직임이 사라지니 그대로.
async function prepareImage(file) {
  const bmp = await decodeImage(file), w = bmp.width, h = bmp.height;
  if (file.type === 'image/gif' || (file.size <= IMG_KEEP_BYTES && Math.max(w, h) <= IMG_KEEP_DIM && /^image\/(jpeg|png|webp)$/.test(file.type))) { bmp.close?.(); return { blob: file, w, h }; }
  const s = Math.min(1, IMG_TARGET / Math.max(w, h)), W = Math.round(w * s), H = Math.round(h * s);
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H }), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(bmp, 0, 0, W, H); bmp.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('사진을 줄이지 못했어요.');
  return { blob, w: W, h: H };
}
function videoSize(file) { // 메시지 칸을 미리 잡아 두려고 크기만 읽는다 (못 읽어도 올리는 데는 문제없음)
  return new Promise((ok) => {
    const v = document.createElement('video'), u = URL.createObjectURL(file), done = (w, h) => { URL.revokeObjectURL(u); ok({ w, h }); };
    v.preload = 'metadata'; v.muted = true; v.onloadedmetadata = () => done(v.videoWidth || undefined, v.videoHeight || undefined); v.onerror = () => done(); setTimeout(done, 4000); v.src = u;
  });
}
function uploadBlob(blob, onProgress) {
  return new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/upload'); x.setRequestHeader('X-Token', uploadToken);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let j = {}; try { j = JSON.parse(x.responseText); } catch {}
      if (x.status === 200) return ok(j);
      // nginx/NPM이 직접 막은 413은 JSON이 아니라 HTML로 온다
      no(new Error(x.status === 413 && !j.error ? '서버 앞의 프록시(NPM)가 큰 파일을 막고 있어요. 운영자가 client_max_body_size를 늘려야 해요.' : j.error || `올리지 못했어요 (${x.status})`));
    };
    x.onerror = () => no(new Error('올리지 못했어요. 연결을 확인해 주세요.'));
    x.send(blob);
  });
}

const targetBox = (t) => (t.kind === 'dm' ? $('#dmMsgs') : $('#chat'));
function progressLine(t, text) {
  const line = el('div', { className: 'sys upl', role: 'status', textContent: text });
  targetBox(t).append(line); targetBox(t).scrollTop = targetBox(t).scrollHeight;
  return line;
}
let attaching = false;
async function attach(file, t) {
  if (!mediaKind(file)) return sys('사진(JPG, PNG, GIF, WebP)이나 동영상(MP4, WebM, MOV)만 올릴 수 있어요.');
  if (attaching) return sys('다른 파일을 올리는 중이에요. 끝난 뒤에 다시 해 주세요.');
  if (t.kind === 'dm' && !t.uid) return;
  attaching = true;
  const line = progressLine(t, `${file.name || '파일'} 준비하는 중…`);
  try {
    const kind = mediaKind(file);
    const prep = kind === 'image' ? await prepareImage(file) : { blob: file, ...(await videoSize(file)) };
    const j = await uploadBlob(prep.blob, (p) => (line.textContent = `올리는 중 ${Math.round(p * 100)}%`));
    const input = t.kind === 'dm' ? $('#dmIn') : $('#chatIn'), text = input.value.trim(); // 입력창에 써 둔 글은 설명으로 같이 보낸다
    const media = { url: j.url, w: prep.w, h: prep.h };
    const sent = t.kind === 'dm' ? sendPaced('dm', { t: 'dm', to: t.uid, text, media }) : sendPaced('chat', { t: 'chat', text, media });
    if (!sent) throw new Error('연결이 끊겨서 보내지 못했어요. 다시 연결되면 한 번 더 올려 주세요.');
    input.value = ''; line.remove();
  } catch (e) {
    line.textContent = e.message || '올리지 못했어요.'; line.classList.add('err');
    setTimeout(() => line.remove(), 9000);
  } finally { attaching = false; }
}

/* ---------- 메시지 안에서 보여 주기 ---------- */
const expiredNote = () => el('p', { className: 'expired', textContent: '파일이 없어요. 보관 기간이 지나 지워졌을 수 있어요.' });
function mediaNode(m) {
  const box = el('div', { className: 'media' });
  if (m.w && m.h) box.style.aspectRatio = `${m.w} / ${m.h}`; // 불러오는 동안 칸이 흔들리지 않게
  if (m.kind === 'image') {
    const img = el('img', { src: m.url, alt: '보낸 사진', loading: 'lazy', decoding: 'async' });
    img.onerror = () => { box.style.aspectRatio = ''; box.replaceChildren(expiredNote()); };
    const b = el('button', { type: 'button', className: 'mbtn', onclick: () => openLightbox(m.url) }, img);
    b.setAttribute('aria-label', '사진 크게 보기');
    box.append(b);
  } else {
    const v = el('video', { src: m.url, controls: true, preload: 'metadata', playsInline: true });
    v.muted = soundOff; // 모든 소리 끄기/패닉이 켜져 있으면 동영상도 소리 없이
    v.onerror = () => { box.style.aspectRatio = ''; box.replaceChildren(expiredNote()); };
    box.append(v);
  }
  return box;
}
const lightbox = $('#lightbox');
function openLightbox(url) {
  $('#lbImg').src = url;
  if (typeof lightbox.showModal === 'function') lightbox.showModal(); else window.open(url, '_blank', 'noopener'); // <dialog>를 모르는 구형 브라우저는 새 탭으로
}
lightbox.addEventListener('click', () => lightbox.close()); // 어디를 눌러도 닫힘

/* ---------- 버튼 / 붙여넣기 / 끌어다 놓기 ---------- */
const chatTarget = () => ({ kind: 'chat' }), dmTarget = () => ({ kind: 'dm', uid: dmOpenUid });
const firstMedia = (list) => [...(list || [])].find((f) => mediaKind(f));
function wireAttach(btnSel, fileSel, inputSel, areaSel, target) {
  $(btnSel).onclick = () => $(fileSel).click();
  $(fileSel).onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) attach(f, target()); };
  $(inputSel).addEventListener('paste', (e) => { const f = firstMedia(e.clipboardData?.files); if (f) { e.preventDefault(); attach(f, target()); } });
  const area = $(areaSel);
  area.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); area.classList.add('drop'); } });
  area.addEventListener('dragleave', () => area.classList.remove('drop'));
  area.addEventListener('drop', (e) => { e.preventDefault(); area.classList.remove('drop'); const f = firstMedia(e.dataTransfer?.files); if (f) attach(f, target()); });
}
wireAttach('#attachBtn', '#attachFile', '#chatIn', '#p-chat', chatTarget);
wireAttach('#dmAttachBtn', '#dmAttachFile', '#dmIn', '#dmThread', dmTarget);
