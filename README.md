# Gemination — Gemini Web → Local PC MCP 커넥터

`gemination`은 [gemini.google.com](https://gemini.google.com)의 **공식 MCP 커넥터(Custom Connector)**를 통해 웹 채팅창에서 내 로컬 Mac/PC의 파일, 검색, Git, 셸 명령, 백그라운드 프로세스를 제어할 수 있게 해주는 로컬 MCP 서버입니다.

- **공식 프로토콜 준수**: Stateless **Streamable HTTP** (`/mcp`) + **OAuth 2.1** (RFC 9728 Protected Resource Metadata, RFC 8414 Authorization Server Metadata, RFC 7591 Dynamic Client Registration, PKCE `S256`, RFC 8707 Resource Indicators) 내장
- **터널 방식 선택 UI 내장**: 실행 시 **Tailscale Funnel(본인 도메인 없이 무료 고정 HTTPS)**, **Cloudflare Quick Tunnel(즉시 임시 HTTPS)**, **직접 HTTPS URL(보유 도메인/Named Tunnel)** 중 원하는 방식을 선택할 수 있습니다.
- **이중 포트 로컬 보안 경계**: 외부 터널이 연결되는 MCP 포트(`3847`)와 로컬 전용 Studio 관리 UI 포트(`3848`)를 분리하고, 워크스페이스 격리(dangling symlink 차단), 민감 경로 차단, 1회성 로컬 소유자 승인 PIN(`scrypt` 해시), Secret Shield, JSONL 감사 로그를 제공합니다.

---

## 설치 및 빠른 시작

필수 요구 사항: [Bun](https://bun.sh) 1.4+ (macOS 우선 지원, Linux는 POSIX 셸 폴백 지원)

```sh
git clone https://github.com/remorser58/gemination.git
cd gemination
bun install
```

터널 방식에 따라 **둘 중 하나만** 준비하면 됩니다 (본인 도메인이 없어도 사용 가능):
- **고정 주소를 원할 때 (추천)**: [Tailscale](https://tailscale.com) (`brew install --cask tailscale` 또는 macOS App Store 설치 + 로그인)
- **가입/설정 없이 바로 시험해볼 때**: `cloudflared` (`brew install cloudflared`)

### 방법 A · Gemination Studio GUI로 시작 (추천)

macOS Finder에서 **[Start-Gemination-UI.command](Start-Gemination-UI.command)** 를 더블클릭하거나, 터미널에서 실행하세요:

```sh
bun run gui
```

- **처음 실행 시 자동 준비**: `Start-Gemination-UI.command`와 `./start.sh`는 Bun 미설치 시 자동 설치를 제안하고, 최초 실행 시 `bun install`과 기본 작업 폴더 설정·PIN 발급을 자동으로 처리합니다. (이전에 Tailscale Funnel 또는 고정 URL을 저장해 둔 경우 GUI를 다시 열면 자동으로 재연결됩니다.)
- **전용 Chrome 프로필 로그인**: UI의 `연결 및 로그인` 화면에서 **전용 Chrome으로 Gemini 로그인 / 열기**를 누르면 Google 로그인 세션이 전용 프로필에 안전하게 저장·유지됩니다.
- **UI 내 터널 원클릭 제어**: Tailscale Funnel / Quick Tunnel(재등록 주의 안내 포함) / 직접 URL을 UI 안에서 바로 선택해 켜고 끌 수 있습니다.
- **워크스페이스 탐색기 & 보안 제어**: Finder 폴더 선택, 파일/Git diff 조회(Secret Shield 적용), 실시간 도구 감사 로그, 비상 토큰 차단까지 한 화면에서 조작할 수 있습니다.

### 방법 B · 터미널 CLI로 바로 시작

macOS Finder에서 **[Start-Gemination.command](Start-Gemination.command)** 를 더블클릭하거나, 터미널에서 아래 한 줄을 실행하세요:

```sh
./start.sh    # 또는 bun run up
```

실행하면 먼저 **터널 방식 선택창**이 나타납니다:

```text
  [1] Tailscale Funnel (추천 · 무료 고정 HTTPS · 본인 도메인 불필요)
  [2] Cloudflare Quick Tunnel (임시 HTTPS · 계정/도메인 불필요)
      - 주의: 서버를 껐다 켜면 URL이 매번 바뀌므로,
        재시작할 때마다 gemini.google.com 커넥터를 다시 등록해야 합니다.
  [3] 직접 HTTPS URL 입력 (보유 도메인 / Cloudflare Named Tunnel)
  [4] 로컬 전용 (127.0.0.1 · 외부 터널 없음 / 테스트용)
```

선택 후에는 의존성 확인, 기본 워크스페이스 루트(`~/Projects` 등) 자동 설정, **Approval Code (`XXXX-XXXX-XXXX`)** 발급, HTTPS 터널 시작, 그리고 **`Gemini MCP URL` 클립보드 자동 복사**까지 한 번에 진행됩니다.

---

## 터널 방식 비교 (도메인이 꼭 필요한가요?)

| 선택지 | 본인 도메인 | 계정 필요 | 서버 재시작 시 URL 유지 | 특징 |
| --- | --- | --- | --- | --- |
| **1. Tailscale Funnel (추천)** | **불필요** (`*.ts.net` 무료 발급) | Tailscale 계정 | **유지됨 (고정)** | Gemini에 한 번만 등록하면 재시작 후에도 그대로 사용 |
| **2. Cloudflare Quick Tunnel** | **불필요** (`*.trycloudflare.com`) | **불필요** | **변경됨 (재등록 필요)** | 설치만 하면 5초 만에 테스트 가능, 단 재시작 시 Gemini 커넥터 재등록 필요 |
| **3. 직접 HTTPS URL 입력** | 보유 도메인 또는 자체 서버 | 선택 | **유지됨 (고정)** | Cloudflare Named Tunnel / Caddy / Nginx 등 연결 |

> **중요 (Cloudflare Quick Tunnel 사용 시 주의)**
> Cloudflare Quick Tunnel(`https://<random>.trycloudflare.com`)은 일회성 터널이라 **서버를 껐다 켜면 URL이 매번 바뀝니다.**
> 따라서 서버를 재시작할 때마다 `gemini.google.com`의 커넥터를 다시 등록해야 합니다. 매번 재등록하는 번거로움을 없애려면 **[1] Tailscale Funnel**을 사용하세요.

---

## Tailscale Funnel 최초 1회 설정 (본인 도메인 불필요)

Tailscale이 이미 설치/로그인되어 있다면 개인 도메인 없이 무료 고정 HTTPS 주소(`https://<내장비>.<tailnet>.ts.net`)를 받을 수 있습니다.

1. Mac에 Tailscale 설치 및 로그인 (`brew install --cask tailscale` 또는 App Store).
2. [Tailscale Admin Console → DNS](https://login.tailscale.com/admin/dns)에서 **MagicDNS**와 **HTTPS Certificates**가 활성화되어 있는지 확인합니다.
3. `./start.sh` 또는 Studio GUI에서 **Tailscale Funnel**을 선택합니다.
   - 계정에 Funnel 권한이 아직 꺼져 있다면 활성화 링크(`https://login.tailscale.com/...`)가 안내됩니다. 브라우저에서 한 번만 열어 **Enable Funnel**을 누르면 자동으로 연결이 이어집니다.

---

## `gemini.google.com` 연결 방법

1. [gemini.google.com](https://gemini.google.com)에 로그인합니다. *(Google Workspace/학교 계정은 관리자 정책에 따라 커스텀 커넥터가 비활성화되어 있을 수 있으며, 개인 Google 계정에서 동작합니다.)*
2. 왼쪽 사이드바에서 **Customize (맞춤설정)** → **Connectors (커넥터)** → **+ Custom** 을 클릭합니다.
3. **MCP Server URL**에 터미널 또는 Studio UI에 표시된 `https://.../mcp` 주소를 입력합니다.
4. **Client ID / Client Secret** 입력란은 **비워둡니다** (Dynamic Client Registration으로 자동 등록됨).
5. **Next** → 위험 안내 동의 후 **Connect** → Google 계정 연결 화면에서 **Agree and continue** 를 클릭합니다.
6. `gemination` 로컬 승인 화면이 열리면 발급받은 **Local Owner Approval Code (`XXXX-XXXX-XXXX`)** 를 입력하고 **Approve Connection** 을 클릭합니다.
7. 이후 Gemini 채팅창에서 `@` 커넥터 또는 일반 프롬프트로 로컬 파일 조회/수정 및 명령 실행을 지시할 수 있습니다.

---

## 제공되는 편의 기능

- **실행 시 터널 & 폴더 선택창 (`./start.sh` / `Start-Gemination.command`)**:
  - `[1] Tailscale Funnel (추천)`, `[2] Cloudflare Quick Tunnel`, `[3] 직접 HTTPS URL`, `[4] 로컬 전용` 중 선택
  - `[s]` 메뉴에서 **macOS Finder 폴더 선택 팝업**과 **안전 모드(읽기 전용) / 개발 모드** 프리셋 바로 설정
  - `Tailscale` / `cloudflared` 미설치 시 Homebrew 자동 설치 제안 및 Tailscale Funnel 최초 활성화 링크 브라우저 자동 열기
- **독립 포트의 로컬 전용 Studio UI (`http://127.0.0.1:3848/`)**:
  - 외부 터널·리버스 프록시가 절대 도달할 수 없도록 MCP 포트(`3847`)와 별도의 loopback 전용 포트(`port + 1`, 기본 `3848`)에서 동작 (`Host`, 프록시 헤더, `Sec-Fetch-Site`, CSRF 토큰 이중 검증)
  - MCP URL 원클릭 복사, 1회성 승인 PIN 재발급, 허용 폴더 추가/삭제, 쓰기/셸/시크릿 마스킹 실시간 토글, 최근 도구 감사 로그 조회, **원클릭 토큰 비상 차단(Revoke All)**
- **실행 중 터미널 단축키**:
  - `c` (MCP URL 복사) · `p` (새 PIN 발급) · `d` (Studio UI 열기) · `g` (Gemini Web 열기) · `r` (모든 토큰 즉시 폐기) · `q` / `Ctrl+C` (종료)
- **자동 시크릿 마스킹 (Secret Shield)**:
  - `read_file` / `run_command` / 로컬 미리보기·감사 로그에서 OpenAI/Anthropic/GitHub/AWS/Google/Stripe/Slack 키, `gma_`/`gmr_`/`gsec_` 토큰, Bearer 헤더, JWT, PEM 개인키, 자격증명 포함 URL, `API_KEY=`/`PASSWORD=`/`PIN=` 설정값을 자동 감지해 `[... hidden]` 처리한 뒤 전송·기록합니다 (`--no-secret-shield` 또는 UI에서 해제 가능).
- **안정성 & 백그라운드 상시 실행 (macOS)**:
  - **외부 HTTPS 셀프 체크**: 터널 시작 직후 실제 외부 HTTPS 도달 가능 여부를 자동 점검
  - **macOS 잠자기 방지 (`caffeinate`)**: 서버 실행 중 Mac 유휴 잠자기 방지 (`--no-caffeinate`로 해제 가능)
  - **중복 실행 방지 락 & 포트 자동 전환**: 동일 프로필 중복 실행 차단, 기본 포트 점유 시 빈 포트로 자동 이동
  - **멀티 프로필 & Mac 자동 시작 서비스**: `--profile <name>`, `bun run config`, `bun run service:install` (LaunchAgent) 지원

---

## 제공 MCP 도구 (12종)

| 도구 | 설명 | 권한 |
| --- | --- | --- |
| `local_info` | 호스트 OS/아키텍처, 허용 루트, 기능 플래그, 실행 중 프로세스 수 조회 | 읽기 |
| `list_directory` | 허용된 루트 내 디렉터리 목록 조회 (`recursive`, `maxDepth`, `limit`) | 읽기 |
| `read_file` | UTF-8 텍스트 파일 줄 범위 읽기 (바이너리·초대형 파일 자동 차단) | 읽기 |
| `write_file` | 파일 생성, 덮어쓰기, 이어쓰기 (`--read-only` 시 차단) | 쓰기 |
| `edit_file` | 정확한 텍스트 블록 치환 (`replaceAll` 지원) | 쓰기 |
| `search_files` | `rg` 기반(미설치 시 순수 TS 폴백) 본문/파일명 검색 | 읽기 |
| `run_command` | 허용 루트 내 셸 명령 실행 (타임아웃·출력 바이트 제한) | 실행 |
| `start_process` | 장기 실행 빌드/테스트/서버를 백그라운드 프로세스로 시작 | 실행 |
| `poll_process` | 백그라운드 프로세스 상태 및 증분 stdout/stderr 조회 | 읽기 |
| `stop_process` | 백그라운드 프로세스 종료 (`SIGTERM` / `SIGKILL`) | 실행 |
| `list_processes` | 현재 세션에서 실행한 백그라운드 프로세스 목록 | 읽기 |
| `git_inspect` | `status`, `diff`, `log`, `branch` 읽기 전용 점검 | 읽기 |

---

## 보안 모델 요약

1. **Loopback 바인딩 및 관리 포트 분리**: MCP/OAuth(`3847`)와 Studio 관리 UI(`3848`) 모두 `127.0.0.1`에만 바인딩되며, 터널은 MCP 포트로만 연결되어 관리 API(`/_local/*`)에 외부나 리버스 프록시가 접근할 수 없습니다.
2. **OAuth 2.1 + 1회성 소유자 PIN 동의**: 모든 `/mcp` 호출은 유효한 Bearer 토큰이 필요하며, 브라우저 동의 시 `scrypt` + `timingSafeEqual`로 검증되는 1회성 PIN(승인 즉시 자동 폐기·재회전, 글로벌 5회/5분 실패 잠금)을 요구합니다.
3. **토큰/시크릿 해시 저장**: `~/.config/gemination/state.json` (`0600`)에는 원본 토큰·PIN·시크릿을 저장하지 않고 해시만 기록합니다.
4. **Redirect URI 화이트리스트**: DCR 및 인가 요청 시 Google 공식 OAuth 리다이렉트 호스트(`oauth-redirect.googleusercontent.com`, `oauth-redirect-sandbox.googleusercontent.com`, `vertexaisearch.cloud.google.com`) 및 로컬 테스트 주소(`127.0.0.1`, `localhost`)만 허용하며 프래그먼트(`#`)·userinfo 포함 URI를 거부합니다.
5. **워크스페이스 격리 + Dangling Symlink & 민감 경로 차단**: `lstatSync`·`readlinkSync`·`realpathSync` 기반으로 깨진 심볼릭 링크를 악용한 탈출을 차단하며 `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`, `~/.npmrc`, `~/.netrc`, `~/.git-credentials`, `~/.config/{gh,gcloud,gemination}`, `~/Library/Keychains`, Chrome 사용자 데이터 접근을 차단합니다.
6. **최소 권한 플래그 및 주의사항**: `checkCommandSafety`는 우발적 파괴 명령을 막는 안전 가드레일이며 OS 수준 샌드박스가 아닙니다. 신뢰할 수 없는 저장소를 다룰 때는 **안전 모드(`--read-only --no-shell`)** 사용을 권장합니다 (`--no-shell` 모드에서는 `.git/config`·`.git/hooks` 수정 및 `rg`/`git` 외부 실행 옵션도 차단됩니다).
7. **감사 로그 & 즉시 폐기**: 모든 도구 호출은 `~/.config/gemination/audit.jsonl`에 시크릿 마스킹 후 기록되며, `bun run revoke` 또는 UI로 모든 활성 토큰을 즉시 폐기할 수 있습니다.

---

## CLI 명령어

```sh
bun run gui                                       # Gemination Studio GUI + 전용 Chrome 프로필 로그인
bun run up                                        # 터널 선택창 + 자동 초기화 + Studio UI 안내 + URL 복사
bun run setup                                     # 작업 폴더(Finder 선택)·보안 모드·기본 터널 마법사
bun run start:tailscale                           # 선택창 없이 Tailscale Funnel 바로 실행
bun run start:quick                               # 선택창 없이 Cloudflare Quick Tunnel 바로 실행
bun run serve:local                               # 터널 없이 로컬(127.0.0.1)만 실행
bun run config get                                # 현재 설정 JSON 조회
bun run config read-only on                       # 안전 모드(쓰기 차단) 전환
bun run config add-root ~/MyProject               # 허용 폴더 추가
bun run service:install                           # macOS 로그인 시 백그라운드 자동 시작 등록
bun run service:status                            # 백그라운드 서비스 및 실행 상태 확인
bun run service:uninstall                         # 백그라운드 자동 시작 해제
bun run src/cli.ts up --profile work              # 별도 프로필(`work`)로 독립 실행
bun run src/cli.ts serve --tunnel none --public-url https://gemination.yourdomain.com
bun run credentials --rotate-pin                  # 승인 PIN 재발급
bun run credentials --rotate-static-client        # 수동/Enterprise용 정적 Client ID/Secret 재발급
bun run revoke                                    # 발급된 모든 OAuth 토큰 폐기
bun run doctor                                    # Bun, Tailscale, cloudflared, caffeinate, rg, git, 포트 점검
bun run typecheck && bun test tests               # 타입체크 및 테스트
```

자세한 아키텍처와 UI 설계는 [docs/architecture.md](docs/architecture.md) 및 [docs/design.md](docs/design.md)를 참고하세요.

---

## 라이선스

[MIT License](LICENSE)
