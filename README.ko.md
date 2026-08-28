# 🏙️ Agent Office (비서실)

**오피스에 입장하면, AI 직원들이 이미 일하고 있습니다.**

여러 프로젝트를 여러 AI 코딩 에이전트(Claude Code · OpenAI Codex · xAI Grok)로 굴리는 셀프호스팅 모바일 "비서실". 폰에서 단톡방처럼 지시하고 보고받습니다. 프레임워크 0, DB 0, npm 의존성 2개(`marked`, `web-push`), 코드 파일 2개.

[English README](README.md)

## 컨셉

- **로비** — 프로젝트 하나가 오피스 하나. 카드에 실시간 활동 배지(작업 중/오늘 활동)와 플랜 한도 %가 뜹니다.
- **오피스 입장** — 이름·역할·**서로 다른 모델**을 가진 비서들이 있습니다. 채팅으로 지시하면 그 프로젝트 폴더에서 실제 작업이 돕니다.
- **교차검증 체인** — 토글 하나로: 실무(Claude) 실행 → 감사(Codex)가 실물 파일을 회의적으로 검증 → 비서실장이 요약 보고. 3사 모델이 서로를 견제합니다.
- **아침 브리핑** — 매일 7:30, 비서실장이 전 프로젝트의 최근 세션을 읽고 우선순위 브리핑을 폰으로 푸시합니다.

기본 비서진 (`config.json`에서 이름·성격·모델 자유 변경):

| 비서 | 역할 | 백엔드 |
|---|---|---|
| 🟣 아라 | 비서실장 — 조율·최종 보고 | `claude` |
| 🔵 무진 | 실무 — 실행, 파일 편집 가능 | `claude` |
| 🟠 하연 | 감사 — 실물 증거로 검증 | `codex` |
| 🟢 제나 | 전략 — 트렌드·웹 검색 | `grok` |

## 기능

- 📱 메신저급 채팅 UI (PWA, 다크, 타임스탬프, 날짜 구분선, 작업 중 표시)
- 🗂 오피스별 파일 브라우저 + 앱 내 마크다운 렌더링
- 📜 프로젝트별 실제 Claude Code 세션 기록 열람 + **폰에서 그 세션 이어가기**(`claude --resume`)
- 📊 사용량 대시보드: Claude 5시간/주간 한도 %, Codex 주간 %, Grok 크레딧, 오늘 토큰·비용([ccusage](https://github.com/ryoppippi/ccusage))
- 🔔 모든 에이전트 보고·아침 브리핑 웹 푸시
- ✅ 할일 위젯 (오피스별 `TODO.md` 체크박스)
- 🧰 스킬 카탈로그 뷰어 (`~/.claude/skills/SKILLS_GUIDE.md` 렌더링)

### 토큰 아끼는 설계

- Claude 5시간 창이 **90%**를 넘으면 선제적으로 Codex로 우회합니다.
- 어떤 백엔드든 한도 초과·오류면 **3사 간 자동 폴백**(claude → codex → grok).
- 캐시 가능한 건 전부 캐시(사용량 10분, 한도 5분). 서버 자체는 LLM을 호출하지 않습니다 — 기존 구독의 CLI만 씁니다.

## 빠른 시작

필요: macOS, Node 18+, [Claude Code](https://claude.com/claude-code) 로그인. 선택: `codex` CLI, `grok` CLI(Grok Build), 폰 접속용 [Tailscale](https://tailscale.com).

**명령어 하나로:**

```sh
curl -fsSL https://raw.githubusercontent.com/MOSW626/agent-office/main/install.sh | bash
```

사전 요구사항 체크 → `~/agent-office`에 클론 → 의존성 설치 → `config.json` 생성까지 자동. 물어보고 진행하는 선택 항목: [에이전트 하네스](#프로젝트-관리-하네스와-함께-쓰기)(unlazy+gstack+gbrain) 설치, launchd 상시 운영 + 아침 브리핑 등록. 다시 실행하면 업데이트됩니다. 비대화형 플래그:

```sh
curl -fsSL https://raw.githubusercontent.com/MOSW626/agent-office/main/install.sh | bash -s -- --all
# --with-harness   unlazy + gstack + gbrain
# --with-launchd   상시 서버 + 07:30 브리핑
# --dir <경로>      설치 위치 (기본 ~/agent-office)
```

<details>
<summary>수동 설치</summary>

```sh
git clone https://github.com/MOSW626/agent-office.git && cd agent-office
npm install                          # marked + web-push 두 개
cp config.example.json config.json   # 프로젝트 경로·비서 구성 수정
node server.mjs                      # → http://localhost:8787
```

</details>

### 폰 접속 (Tailscale)

```sh
# 1회: https://login.tailscale.com/admin/dns 에서 "Enable HTTPS"
tailscale serve --bg 8787
# → https://<맥이름>.<테일넷>.ts.net — 폰에서 열고 "홈 화면에 추가"
```

푸시는 HTTPS 필수. 홈 화면 추가 후 로비의 🔔을 누르세요.

### 상시 운영 + 아침 브리핑 (launchd)

[`setup/`](setup/)의 템플릿 2개를 `~/Library/LaunchAgents/`에 복사하고 경로 수정 후:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agenthub.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agenthub.brief.plist
```

> ⚠️ launchd 로그 경로가 `~/Desktop` 안이면 macOS가 차단해 스폰이 실패합니다(EX_CONFIG). 로그는 `~/Library/Logs/`에 (템플릿은 이미 그렇게 돼 있음).

### 한도 % (Claude)

대시보드는 macOS 키체인의 Claude Code OAuth 토큰으로 공식 사용량 엔드포인트를 조회합니다. 첫 호출 때 키체인 팝업이 뜨면 **"항상 허용"**. 토큰은 맥 밖으로 나가지 않고 %만 제공됩니다.

## 프로젝트 관리 하네스와 함께 쓰기

Agent Office는 *리모컨*이고, 작업 품질은 에이전트가 도는 하네스가 만듭니다. 함께 검증한 스택:

- [**unlazy**](https://github.com/Leonxlnx/unlazy) — 완료 규율: Depth Tree 분해, 실행 가능한 GATES, 증거 기반 검증. `npx skills add Leonxlnx/unlazy`
- [**gstack**](https://github.com/garrytan/gstack) — 50+ 스킬 팀 워크플로(계획→리뷰→QA→배포): `git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup`
- [**gbrain**](https://github.com/garrytan/gbrain) — 세션을 넘는 영구 메모리(MCP): `gbrain init --pglite` 후 `claude mcp add --scope user gbrain -- gbrain serve`

권장 배치: 프로젝트 지식은 각 프로젝트 `CLAUDE.md`에, 교차 지식은 gbrain에, 전역 규칙만 `~/.claude/CLAUDE.md`에 — 그리고 세션은 항상 프로젝트 폴더에서 열기 (컨텍스트 격리가 가장 싼 할루시네이션 방지책).

## 구조

```
index.html   PWA (바닐라 JS, SSE 실시간)
server.mjs   node:http — 채팅·오케스트레이션·세션·파일·사용량·푸시
config.json  비서 구성(페르소나·백엔드·플래그) + 오피스(경로)
data/        messages.jsonl, 푸시 구독, VAPID 키 (gitignore)
```

에이전트 = 오피스 폴더에서의 headless CLI 호출(`claude -p` / `codex exec` / `grok -p`) + 페르소나 시스템 프롬프트. 새 백엔드 추가는 `callBackend()`에 분기 하나입니다.

## 보안 메모

- 서버는 평문 HTTP — **테일넷(또는 신뢰하는 LAN) 안에서만** 노출하세요. 인증 계층은 의도적으로 없습니다(Tailscale이 경계).
- 파일 API는 등록된 프로젝트 폴더로 제한(경로 탈출 차단).
- 실무 비서만 `--permission-mode acceptEdits`. 더 넓은 권한은 해당 프로젝트의 `.claude/settings.json`에서.

MIT © 2026
