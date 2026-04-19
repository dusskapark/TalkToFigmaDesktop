# Upstream 최신화 및 업데이트 반영 기획서

- 작성일: 2026-04-18 (UTC)
- 대상 저장소(Upstream): `https://github.com/grab/TalkToFigmaDesktop`
- 현재 로컬 저장소: `TalkToFigmaDesktop` (Kotlin Compose Desktop 기반)

## 1) 목적

1. Upstream 최신 상태를 추적 가능한 형태로 연결한다.
2. 현재 저장소에 반영 가능한 변경사항을 분류한다.
3. 전체 교체가 아닌, 단계적 반영 로드맵을 수립한다.

## 2) 현재 상태 요약

- 본 저장소는 Kotlin Compose Desktop 앱으로 WebSocket/MCP 서버를 데스크톱 트레이에서 제어하는 구조다.
- Upstream(`grab/TalkToFigmaDesktop`)은 Electron/React 기반 구조로 알려져 있어 기술 스택 차이가 크다.
- 따라서 단순 `merge` 또는 `rebase`로는 안전한 최신화가 어렵고, 기능 단위 이식 전략이 필요하다.

## 3) Upstream 연결 및 최신화 시도 결과

### 완료
- `upstream` remote 등록 완료

### 미완료 (환경 제약)
- `git fetch upstream --prune` 수행 시 네트워크 정책으로 실패
  - 에러: `CONNECT tunnel failed, response 403`

> 결론: 현재 환경에서는 git 네트워크 접근으로 upstream 커밋/태그를 직접 동기화할 수 없음.

## 4) 최신화 전략 (환경 제약 고려)

### 전략 A. 네트워크 허용 환경에서 즉시 실행 (권장)

```bash
git remote add upstream https://github.com/grab/TalkToFigmaDesktop.git   # already added
git fetch upstream --prune
git checkout -b sync/upstream-main upstream/main
```

- 목적: upstream 기준 브랜치를 별도 확보하여 diff를 안전하게 분석
- 산출물:
  - `docs/upstream-diff-summary.md`
  - `docs/upstream-adoption-matrix.md`

### 전략 B. 현 환경에서 선행 가능한 작업

- 아키텍처 갭 분석 및 반영 계획 문서화
- 기능 단위 반영 백로그 정리
- 위험요소/테스트 전략 수립

## 5) 반영 범위 분류 (기능 단위)

### P0 (즉시 반영 후보)
- MCP 서버 관리 UX 개선
  - 서버 상태, 시작/정지, 로그 가시성 개선
- 채팅 인터페이스 골격
  - 메시지/툴호출 이력, 오류 표시, 재시도 액션

### P1 (단기)
- 로컬 LLM(Ollama) 어댑터 추가
  - 엔드포인트/모델 설정 UI
  - 연결 상태 점검(health check)
- MCP 도구 호출 관측성
  - 호출 파라미터/응답/지연시간 로깅

### P2 (중기)
- 프롬프트 템플릿/워크스페이스별 설정
- 도구 권한 정책 및 안전장치
- 진단 번들(export logs + settings snapshot)

## 6) 기술적 의사결정 가이드

1. **코어 유지**: Kotlin Compose + 기존 MCP/WebSocket 서버 코어는 유지
2. **선택적 이식**: Upstream의 UX/워크플로우는 기능 단위로 선택 이식
3. **호환 계층 도입**: 향후 Electron/웹 UI 연동 가능성을 위한 API 경계 정의

## 7) 작업 로드맵

### Phase 1 — 기준선 확보 (1~2일)
- [ ] upstream fetch 가능한 환경에서 `sync/upstream-main` 브랜치 확보
- [ ] 구조 차이/의존성 차이/런타임 차이 문서화

### Phase 2 — 공통 기능 추출 (3~5일)
- [ ] 공통 도메인 모델 정의 (ChatMessage, ToolCall, ToolResult)
- [ ] 서버 상태/로그/도구호출 이벤트 스키마 정리

### Phase 3 — UI/기능 반영 (1~2주)
- [ ] 채팅 인터페이스 추가
- [ ] Ollama 어댑터 + 설정 화면
- [ ] MCP 호출 관측성 기능 추가

### Phase 4 — 안정화 (3~5일)
- [ ] 회귀 테스트/수동 테스트 시나리오
- [ ] 장애/오류 핸들링 강화
- [ ] 문서 업데이트

## 8) 리스크 및 대응

- 리스크: 스택 차이(Kotlin vs Electron)로 직접 코드 병합 불가
  - 대응: 기능 단위 이식 + 공통 스키마 우선
- 리스크: 네트워크 제약으로 upstream 실시간 동기화 불가
  - 대응: fetch 허용 환경에서 주기적 미러링 브랜치 운영

## 9) 완료 정의 (Definition of Done)

- upstream 동기화 브랜치 확보 (`sync/upstream-main`)
- 반영 범위 매트릭스 문서화
- P0 항목 최소 1개 이상 구현 및 QA 통과

---

### 실행 기록
- `git remote add upstream https://github.com/grab/TalkToFigmaDesktop.git`
- `git fetch upstream --prune` (실패: `CONNECT tunnel failed, response 403`)
