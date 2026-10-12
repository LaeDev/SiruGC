# 방 채팅 (SiruGC)

하나의 방에서 채팅, 유튜브 같이 보기(대기열), 화면 공유, 음성 대화, 쪽지를 할 수 있는 웹앱입니다. 회원가입 없이 닉네임·아바타·내 색만 정하고 들어옵니다.

## 시작하기

| 환경 | 방법 |
|---|---|
| Windows | `start-windows.bat` 더블클릭 (터미널에서는 `.\start-windows.bat`) |
| Linux / macOS | `./start-linux.sh` (실행 권한이 없으면 `chmod +x start-linux.sh`) |
| 직접 | `npm install` 후 `npm start` |

Node.js 18 이상이 필요합니다. 켜면 접속 주소가 나옵니다(`http://localhost:3000`). 끄려면 Ctrl+C — 접속자 화면에는 "서버가 꺼졌습니다" 안내가 바로 뜹니다.

## 설정 (`config.env`)

`config.example.env`를 `config.env`로 복사해서 필요한 줄만 켜세요. `config.env`는 git에 올라가지 않습니다(비밀번호를 여기에 두세요).

- `TRUST_PROXY=1`, `HOST=0.0.0.0` — NPM/nginx 같은 프록시 뒤에서 https로 공개할 때. 프록시는 Scheme을 `http`, **Websockets Support를 켜기**.
- `ICE_SERVERS` 또는 `TURN_URL`+`TURN_SECRET` — 집 밖 네트워크에서 화면 공유·음성이 안 보일 때(TURN 중계 서버).
- `VAPID_SUBJECT` — 푸시 알림을 보낼 때 푸시 서비스에 알리는 연락처(`mailto:` 또는 `https://` 주소).

화면 공유·마이크·알림·앱 설치는 `https` 주소(또는 `localhost`)에서만 동작합니다.

## 점검

```
npm test                      서버 로직: 밴, 대기열, 재생 시계, 쪽지, 푸시, 설정 파일
node tools/check-contrast.js  모든 테마의 글자 대비(WCAG AA)
node tools/ui-check.js        화면 배치(폰에서 영상+채팅이 한 화면에 들어오는지 등)
node tools/parity-check.js    PC와 폰·태블릿 UI가 같은지
node tools/rtc-check.js       음성과 화면 공유 연결 (브라우저 2개)
node tools/dm-check.js        쪽지, 알림 위장, 소리 끄기, 패닉
node tools/pwa-check.js       웹앱 설치 조건, 서버가 꺼졌을 때의 안내
node tools/down-check.js      서버를 갑자기 껐을 때
node tools/turn-check.js      config.env에 설정한 TURN 서비스 (실제 연결)
```

`tools/*-check.js`는 Chrome이 필요합니다(`CHROME` 환경변수로 경로 지정). 임시 포트와 임시 상태 파일을 쓰므로 실제 데이터는 건드리지 않고, 소리는 꺼진 채로 돌아갑니다.

## 구조

- `server.js` — HTTP 정적 서빙 + 웹소켓(방, 대기열, 음성/공유 신호, 밴). `messages.js` — 쪽지와 웹 푸시.
- `public/` — `app.js`(입장·참가자·채팅) `media.js`(영상·대기열·화면 공유) `voice.js` `dm.js` `notify.js`(알림·위장) `panic.js`(소리 끄기·패닉) `settings.js`(테마·설정 창) `pwa.js` `sw.js`, 스타일 `style.css` `themes.css`.
- `state.json` — 호스트 키, 차단 목록, 쪽지, 푸시 구독, 푸시 서명 키가 저장됩니다. **비밀 값이 들어 있으니 공유하지 마세요**(git에서 제외됨). 호스트 키를 잃었다면 이 파일의 `hostKey`를 지우고 재시작하면 다음 입장자가 호스트가 됩니다.

개인정보 처리와 이용 조건은 `PRIVACY.md`, `TERMS.md`를 보세요.
