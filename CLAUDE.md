# portcall

이 저장소는 **실서비스 데몬**입니다. `com.portcall.gateway` 가 launchd 로
상시 떠 있고 `mcp.sukelo.com` 으로 외부에 열려 있습니다. 로컬 실험 대상이
아니라 지금 트래픽을 받는 프로세스라는 걸 전제로 작업합니다.

## 프로세스를 죽일 때

**패턴으로 죽이지 않습니다.** `pkill -f`, `killall` 은 프로세스 표에 대한
추측이고, 추측은 틀립니다.

```
쓰지 말 것   pkill -f 'dist/src/server.js.*'
             killall node
             lsof -ti tcp:PORT | xargs kill

대신         pgrep -fl <패턴>      ← 먼저 무엇이 걸리는지 눈으로 본다
             kill <확인한 PID>     ← 그 PID 만 죽인다
```

2026-09-20 에 위 첫 줄로 운영 데몬을 두 번 죽였습니다. 테스트 인스턴스를
정리하려던 명령이 운영 프로세스까지 잡았습니다. KeepAlive 가 살려내서
피해는 10초 남짓한 다운타임이었지만, 재시작은 **열려 있는 연결을 끊고
guard 의 메모리 상태를 지웁니다** — 인증 실패 차단이 함께 풀립니다.

`.claude/hooks/daemon-kill-guard.py` 가 이걸 강제합니다. launchd 가
관리 중인 PID 에 걸리는 kill 은 실행 전에 막힙니다. 훅에 막히면 우회할
방법을 찾지 말고 PID 를 확인하는 절차를 따르십시오.

데몬 자체를 다뤄야 할 때는 kill 이 아니라 launchctl 입니다.

```
재시작   launchctl kickstart -k gui/$(id -u)/com.portcall.gateway
정지     launchctl bootout gui/$(id -u)/com.portcall.gateway
기동     launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.portcall.gateway.plist
```

plist 의 환경변수를 바꿨다면 kickstart 로는 반영되지 않습니다.
bootout 후 bootstrap 이어야 합니다.

## 테스트 인스턴스

운영과 같은 포트(7100)를 쓰지 않습니다. 빈 포트에 별도로 띄우고, 정리할
때는 그 인스턴스의 PID 를 직접 붙잡아 죽입니다.

```bash
PORTCALL_PORT=7199 PORTCALL_VAULT_PATH=<임시> node dist/src/server.js &
TEST_PID=$!
...
kill "$TEST_PID"
```

## 비밀값

`ps`, `launchctl list`, plist 덤프, 캐시 파일 덤프는 그 자체로 비밀을
흘립니다. cloudflared 는 터널 토큰을 명령줄 인자로 들고 있고, LaunchAgent
plist 에는 `PORTCALL_TOKEN` 과 KIS 자격증명이 들어 있습니다.

점검할 때는 볼 필드를 먼저 정하고 나머지는 걷어냅니다. 키 이름을
블랙리스트로 거르는 방식은 쓰지 않습니다 — 토큰 캐시의 키 이름이
`value` 라서 `'token' in key` 필터를 그대로 통과한 적이 있습니다.

값이 필요하면 길이나 해시만 출력합니다. 실제 값은 클립보드나 파일 같은
경로로 전달하고 대화에는 남기지 않습니다. 이 저장소는 **공개** 입니다.

## 조회 전용

KIS 플러그인에는 매수·매도·정정·취소가 없고, 앞으로도 추가하지 않습니다.
읽기 전용은 세 겹으로 강제돼 있습니다(주문 툴 미구현, 경로 허용목록,
`/trading/` 네임스페이스의 tr_id 검사). 셋 다 테스트가 지키고 있습니다.
