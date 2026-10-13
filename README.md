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
- `UPLOAD_*` — 사진·동영상 업로드의 크기·보관 기간 한도(기본: 사진 12MB, 동영상 80MB, 30일, 서버 전체 2GB). 파일은 `uploads/`에 저장돼요.
  **NPM/nginx 뒤라면** 프록시도 큰 파일을 받게 해야 해요: NPM의 프록시 호스트 → Advanced에 `client_max_body_size 100m;` 을 넣으세요. 안 넣으면 큰 파일이 413 오류로 올라가지 않아요.
- `RESUME_GRACE_MS`, `RESUME_GRACE_MOBILE_MS` — 연결이 끊긴 사람을 방에 남겨 두는 시간. **폰·태블릿은 화면이 꺼져도 기본 10분 동안 "자리 비움"으로 남아요**(PC는 1분). 돌아오면 같은 자리를 이어받고, 앱이 완전히 닫혔다가 알림을 눌러 다시 열려도 같은 자리를 써요. 음성·화면 공유는 1분 넘게 끊기면 정리돼요(방에는 남음).
- 닉네임은 방에서 겹칠 수 없고(대소문자·공백·`_ - .` 차이는 같은 이름으로 봄), 한글·영문·숫자·공백·`_ - .` 만 쓸 수 있어요. IP나 닉네임이 같다는 이유로 다른 사람의 쪽지·프로필을 함께 쓰게 하지는 않아요.
- `VAPID_SUBJECT` — 푸시 알림을 보낼 때 푸시 서비스에 알리는 연락처(`mailto:` 또는 `https://` 주소).

화면 공유·마이크·알림·앱 설치는 `https` 주소(또는 `localhost`)에서만 동작합니다.

**쪽지함**: 입장 화면의 "쪽지함" 버튼(옆의 "입장하기"는 방으로)을 누르면 방에 들어가지 않고 쪽지만 주고받는 쪽지함 화면이 열립니다. 방 사람들 목록에 보이지 않고 채팅·영상·음성도 받지 않으며(호스트가 될 수도 없음), 쪽지 상대 목록에는 나타납니다. 쪽지함 화면의 "방에 들어가기"로 같은 닉네임으로 방에 들어갈 수 있어요. 닉네임은 쪽지함만 쓰는 사람도 방과 똑같이 겹칠 수 없습니다.

**앱 설치 안내**: 설정 창의 "앱으로 설치"에 iPhone·iPad(Safari), Android(Chrome), 삼성 인터넷의 순서와 알림이 안 올 때의 점검이 있습니다. 쓰는 기기의 순서가 미리 펼쳐져요. 앱 이름이 바뀌면 안내 속 "SiruGC"(`manifest.webmanifest`의 `short_name`)도 같이 고치세요.

## 접속이 자주 끊길 때

서버 콘솔에 `[연결 끊김] 이름 code=… 사유=… N초 접속` 줄이 남습니다. 읽는 법:

- `code=1006` — 중간(프록시·공유기·폰 망)에서 연결이 사라짐. 아래 프록시 설정을 확인하세요.
- `code=4001 사유=hb-silent …` / `wake-noreply` — 화면 쪽이 "보낸 신호에 답이 없다"고 보고 스스로 끊음. 연결은 서버가 아닌 중간 경로에서 멈춘 것입니다. 끊겨도 1분 안에 돌아오면 같은 자리·음성·공유를 그대로 이어받습니다.
- 폰·태블릿이 `code=1001`/`1006`으로 끊겼다면 보통 화면이 꺼진 것입니다. 정상이고, 10분 안에 돌아오면 이어져요.
- `code=4000 사유=replaced` — 새 연결로 바뀌어서 옛 연결을 닫음 (정상).

**NPM(nginx) 뒤라면** 프록시 호스트의 Advanced에 아래를 넣으세요. 기본값(60초)은 조용한 연결을 끊습니다.

```
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

열어 둔 탭·설치한 앱은 서버를 고쳐도 **옛 화면 그대로**입니다. 새 버전이 있으면 접속할 때 "새로고침" 안내가 뜨고, 설정 맨 아래에서 화면 버전을 볼 수 있어요. 안내가 없는 옛 화면은 한 번 새로고침(앱은 완전히 닫았다 다시 열기)해야 합니다.

## 점검

```
npm test                      서버 로직: 밴, 대기열, 재생 시계, 쪽지, 푸시, 설정 파일
node tools/check-contrast.js  모든 테마의 글자 대비(WCAG AA)
node tools/ui-check.js        화면 배치(폰에서 영상+채팅이 한 화면에 들어오는지 등)
node tools/parity-check.js    PC와 폰·태블릿 UI가 같은지
node tools/rtc-check.js       음성과 화면 공유 연결 (브라우저 2개)
node tools/dm-check.js        쪽지, 알림 위장, 소리 끄기, 패닉
node tools/pwa-check.js       웹앱 설치 조건, 서버가 꺼졌을 때의 안내
node tools/dm-only-check.js   입장 화면의 "쪽지함" 버튼(방에 안 보임, 쪽지 주고받기, 방으로 전환), 설치 안내(iPhone/Android)
node tools/voice-check.js     음성 필터(주파수 측정), 마이크 입력 크기, 사람별 음량
node tools/attach-check.js    사진·동영상 첨부, 붙여넣기, 쪽지 첨부
node tools/dm-full-check.js   쪽지 완성: 새 쪽지 고르기, 읽음 표시, 삭제, 대화 정리, 차단
node tools/voice-churn-check.js  음성에서 여러 명이 계속 나갔다 들어와도 서로 들리는지, 오디오가 멈췄을 때 복구
node tools/presence-check.js  참가자 목록의 기기 종류(PC/태블릿/모바일), 영상 아래 음성 참가자 바
node tools/layout-check.js    채팅 너비(PC)·영상 높이(폰) 끌어서 조절, 키보드, 채팅 글자 크기
node tools/globals-check.js   public/*.js 사이에 전역 이름이 겹치는지(겹치면 뒤 파일이 통째로 안 돌아감)
node tools/name-check.js      닉네임 중복 입장 불가, 같은 IP 다른 기기 연결(sync)
node tools/flaky-check.js     소리 없이 죽은 연결·절전으로 늦게 도는 타이머·열어 둔 옛 화면: 끊겼다 돌아오는 동작과 끊김 사유 기록
node tools/down-check.js      서버를 갑자기 껐을 때
node tools/turn-check.js      config.env에 설정한 TURN 서비스 (실제 연결)
```

`tools/*-check.js`는 Chrome이 필요합니다(`CHROME` 환경변수로 경로 지정). 임시 포트와 임시 상태 파일을 쓰므로 실제 데이터는 건드리지 않고, 소리는 꺼진 채로 돌아갑니다.

## 구조

- `server.js` — HTTP 정적 서빙 + 웹소켓(방, 대기열, 음성/공유 신호, 밴, 끊긴 연결 이어받기). `messages.js` — 쪽지와 웹 푸시. `uploads.js` — 사진·동영상 업로드와 제공.
- `public/` — `app.js`(입장·참가자·채팅) `layout.js`(채팅 크기 조절) `media.js`(영상·대기열·화면 공유) `voice.js` `dm.js` `notify.js`(알림·위장) `panic.js`(소리 끄기·패닉) `settings.js`(테마·설정 창) `pwa.js` `sw.js`, 스타일 `style.css` `themes.css`.
- `state.json` — 호스트 키, 차단 목록, 쪽지, 푸시 구독, 푸시 서명 키가 저장됩니다. **비밀 값이 들어 있으니 공유하지 마세요**(git에서 제외됨). 호스트 키를 잃었다면 이 파일의 `hostKey`를 지우고 재시작하면 다음 입장자가 호스트가 됩니다.

개인정보 처리와 이용 조건은 `PRIVACY.md`, `TERMS.md`를 보세요.
