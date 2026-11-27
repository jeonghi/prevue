# React Native 구현 순서와 검증 경로

기준은 `kakao/prevue`의 `e40cb00b9315b72dd5471e33638562b7e8730478`이다. 기존 CLI, Compose JVM 테스트, Pearl 실제 프리뷰와 Viewer 생성물을 먼저 확인했다. 아래 PR은 `jeonghi/prevue` 포크에서 리뷰할 수 있다.

| 단계 | PR과 기준 | 구현·검증 범위 |
| --- | --- | --- |
| M0 계약 | [Foundation #1](https://github.com/jeonghi/prevue/pull/1) → `main` | Viewer 계약, 기준 커밋, 설계와 ADR |
| M1 탐색·데몬 | [Core #2](https://github.com/jeonghi/prevue/pull/2) → #1 | 로컬 SDK, 정적 AST, 프리뷰 ID, 세대, CLI, 동시 기동과 프로젝트 격리 |
| M1 화면 | [Viewer #3](https://github.com/jeonghi/prevue/pull/3)와 [Web #4](https://github.com/jeonghi/prevue/pull/4) → #2 | 기존 보드·갤러리·파일 검색·집중 모드, Vite와 RN Web, Playwright 실제 프레임 |
| M2 Inspector | [Inspector #5](https://github.com/jeonghi/prevue/pull/5) → #4 | 렌더링된 요소에서 실제 TSX 위치로 이동, 수정 후 새 이미지 확인 |
| M3 기기 | [Native #6](https://github.com/jeonghi/prevue/pull/6) → #2 | Metro, 명시적 기기 임대, iOS·Android 캡처와 입력, 변경·복구·호스트 재빌드 |
| 통합 | [Integration #7](https://github.com/jeonghi/prevue/pull/7) → `stack/rn-runtimes` | #2–#6 병합 기준. 세 worktree E2E, 에이전트 스킬, CI, 실제 캡처와 측정 |
| 프로젝트 호환 | [Project adapters #8](https://github.com/jeonghi/prevue/pull/8) → #7 | Expo Metro SDK 54, Storybook CSF의 meta·args·render, 명시적 RN 모듈 mock |
| 기존 앱 삽입 | [Brownfield #9](https://github.com/jeonghi/prevue/pull/9) → #8 | 네이티브 첫 화면, Debug의 RN 자식 화면, 양 플랫폼의 Release 경계 |

## 구현 위치

| 경로 | 책임 |
| --- | --- |
| `plugin/bin/prevue`, `plugin/bin/prevue-rn` | Compose와 RN의 CLI 진입점 및 의존성 안내 |
| `plugin/rn-runtime/packages/react-native` | `definePreview`, 초기 props와 프로젝트·프리뷰 Provider |
| `plugin/rn-runtime/src` | 프로젝트 탐색, 세션과 세대, 렌더러 계약, CLI와 HTTP 서버 |
| `plugin/rn-runtime/src/web`, `plugin/rn-runtime/src/native` | Web 브라우저와 Metro 기기 어댑터 |
| `plugin/rn-runtime/src/viewer`, `viewer-src`, `plugin/viewer` | HTTP·SSE 상태 매핑, 기존 뷰어 원본과 배포 자산 |
| `plugin/rn-runtime/packages/native-host` | Metro 정적 레지스트리, React 커밋 응답, 기기에서의 재설정 |
| `fixtures/react-native-web`, `fixtures/react-native-bare`, `fixtures/react-native-expo` | 프로젝트별 실행 가능한 예제 |
| `tests/react-native`, `skills-src/prevue` | E2E·벤치마크와 Codex/Claude Code용 작업 절차 |

## 완료 확인

[CLI 데모](react-native-cli.md)는 실제 OrderCard 세 가지 상태를 연다. `board.e2e.mjs`는 공통 padding을 22에서 36으로 저장하고 새 세대의 PNG, 구문 오류로 남은 과거 세대, 정상 복구를 확인한다. `selection.e2e.mjs`는 사용자가 클릭한 버튼의 TSX 위치에서 높이를 바꾼 뒤 새 영역 크기와 픽셀을 검사한다. [검증 환경](react-native-compatibility.md)과 [측정 방법 및 원시 표본](react-native-benchmarks.md)에서 적용 범위를 확인할 수 있다.
