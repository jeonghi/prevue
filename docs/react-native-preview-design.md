# Prevue — React Native Preview Engine

> 요청된 목표 설계. 현재 구현 및 검증 범위는 [호환성 표](react-native-compatibility.md)에서 확인할 수 있다.

## 1. 프로젝트 개요

### 1.1 목적

kakao/prevue를 확장하여 Jetpack Compose뿐 아니라 React Native 환경에서도 AI 에이전트와 개발자가 동일한 UI Preview를 관찰하고, 코드 수정 및 시각적 검증을 반복할 수 있도록 한다.

단순히 React Native 컴포넌트를 브라우저에 표시하는 도구를 만드는 것이 아니다.

AI 에이전트가 사람의 개입 없이 다음 작업을 수행할 수 있는 개발 인프라를 구축하는 것이 목적이다.

- UI 구현
- 실제 렌더링 결과 확인
- Figma 및 레퍼런스 이미지 비교
- UI 요소의 소스 위치 확인
- UI 인터랙션 수행
- 수정 사항 재검증
- 디자인 품질 검증

### 1.2 프로젝트 원칙

1. 기존 Prevue의 핵심 사용자 경험을 유지한다.
2. 기존 Compose 기능을 훼손하지 않는다.
3. React Native 런타임을 독립적인 렌더링 백엔드로 구현한다.
4. 프레임워크에 종속되는 구현과 공통 Preview 계약을 분리한다.
5. 새로운 렌더링 엔진을 직접 구현하지 않고 검증된 도구를 활용한다.
6. 사용자의 실제 프로젝트 코드가 렌더링되어야 한다.
7. Web Preview와 Native Preview의 정확도 차이를 숨기지 않는다.
8. AI 에이전트가 실제 렌더링을 확인하기 전에는 작업 성공으로 판단하지 않는다.

## 2. 기존 저장소 분석

### 2.1 재사용 대상

| 경로                            | 책임               | 확장 전략          |
| ----------------------------- | ---------------- | -------------- |
| viewer-src/                   | React 기반 웹 뷰어    | 최대한 재사용        |
| viewer-src/src/runtime/api.ts | 데몬 통신            | 기존 계약 유지       |
| viewer-src/src/session.ts     | 상태 수신 및 화면 갱신    | 공통 활용          |
| viewer-src/src/workspace/     | UI 조작 및 요소 선택    | RN 호환성 검증      |
| plugin/viewer/                | 배포용 뷰어           | 기존 생성 파이프라인 유지 |
| plugin/bin/prevue             | CLI 진입점          | RN 명령 분기 추가    |
| plugin/daemon/application/    | Kotlin 애플리케이션 계층 | 기존 구현 보존       |
| plugin/daemon/infrastructure/ | Kotlin 인프라 계층    | 기존 구현 보존       |
| skills-src/prevue/            | AI 에이전트 사용 지침    | RN 작업 방식 추가    |

### 2.2 기존 구현의 제약

Prevue에는 PreviewRenderer, LiveSession, PreviewRepository, Compiler 등의 추상화가 존재한다.

하지만 실제 인터페이스에는 Kotlin의 클래스 로더, Gradle, Compose Preview Parameter, 리터럴 패치 등의 개념이 포함되어 있다.

따라서 기존 Kotlin 인터페이스에 React Native 관련 예외 처리를 계속 추가하는 방식을 지양한다.

기존 Kotlin 데몬과 별도로 Node.js 기반 React Native Preview 데몬을 구성하고, 브라우저 뷰어가 요구하는 계약을 공통 경계로 활용한다.

## 3. 시스템 아키텍처

### 3.1 논리적 구성

- Agent Interface
  - Codex Plugin
  - Claude Code Plugin
  - CLI
  - 향후 MCP Server
- Preview Viewer
  - Preview Board
  - Preview Gallery
  - Interactive Mode
  - UI Inspector
  - Device Controls
- Preview Protocol
  - HTTP API
  - SSE Events
  - Image Stream
  - Preview Metadata
  - Render Result
  - Interaction
- Preview Runtime
  - 기존 Compose Runtime
  - 신규 React Native Web Runtime
  - 신규 React Native Native Runtime

### 3.2 실행 구조

Compose 프로젝트의 경우 기존 Kotlin 데몬을 실행한다.

React Native 프로젝트의 경우 Node.js 데몬을 실행한다.

두 데몬은 기존 Prevue 웹 뷰어와 호환되는 인터페이스를 제공한다.

초기에는 프로젝트별로 하나의 런타임을 선택한다. 한 뷰어에서 Compose와 React Native Preview를 동시에 실행하는 기능은 후속 범위로 둔다.

### 3.3 기술 스택

| 영역             | 기술                                |
| -------------- | --------------------------------- |
| RN 데몬          | Node.js, TypeScript               |
| CLI            | 기존 Shell CLI 확장                   |
| 파일 감시          | Chokidar 및 Bundler 이벤트            |
| 소스 분석          | TypeScript Compiler API           |
| Web 렌더링        | React Native Web                  |
| Web Bundler    | Vite                              |
| Expo 지원        | 기존 Expo Metro Web Runtime 연동      |
| Web 자동화        | Playwright                        |
| Native Bundler | Metro                             |
| Native 렌더링     | 실제 React Native Debug Host        |
| Native 자동화     | Maestro, simctl, adb              |
| 상태 통신          | HTTP, SSE                         |
| 이미지 전달         | PNG, 필요 시 MJPEG                   |
| 소스 위치 분석       | Babel Instrumentation, Source Map |
| 테스트            | Vitest, Playwright, 기존 Prevue 테스트 |

Expo 프로젝트에 Vite를 강제 적용하지 않는다. Expo에서 이미 제공하는 Metro 기반 웹 환경을 사용할 수 있도록 별도 연결 방식을 제공한다.

## 4. 목표 저장소 구조

아래는 신규 디렉터리의 제안 구조이다. 실제 구현 전 기존 저장소의 빌드 및 패키징 규칙을 확인한다.

```
prevue/
├── plugin/
│   ├── bin/
│   │   ├── prevue
│   │   └── prevue-rn
│   ├── daemon/                 # 기존 Kotlin 데몬
│   ├── rn-runtime/
│   │   ├── packages/
│   │   │   ├── protocol/
│   │   │   ├── core/
│   │   │   ├── discovery/
│   │   │   ├── server/
│   │   │   ├── renderer-web/
│   │   │   ├── renderer-native/
│   │   │   ├── inspector/
│   │   │   └── react-native/
│   │   └── package.json
│   └── viewer/
├── viewer-src/                 # 기존 웹 뷰어 원본
├── skills-src/
├── fixtures/
│   ├── react-native-web/
│   ├── react-native-expo/
│   └── react-native-bare/
├── tests/
│   └── react-native/
└── docs/
```

### 4.1 모듈별 책임

- protocol: 런타임 독립적인 Preview 및 Render 계약
- core: Preview Registry, Session Manager, Render Scheduler
- discovery: TSX Preview 선언 및 프로젝트 구조 분석
- server: 기존 Viewer와 호환되는 HTTP/SSE 서버
- renderer-web: Web 렌더링과 브라우저 조작
- renderer-native: Native Host와 기기 제어
- inspector: UI Tree 및 소스 위치 매핑
- react-native: 개발 프로젝트에서 사용하는 Preview SDK

사용하지 않는 미래 프레임워크용 구현체를 미리 생성하지 않는다.

## 5. 공통 Preview 계약

### 5.1 Preview Descriptor

```
interface PreviewDescriptor {
  id: string;
  framework: 'react-native' | 'compose';
  source: {
    file: string;
    line: number;
    exportName: string;
  };
  name: string;
  platforms: ('web' | 'ios' | 'android')[];
  viewport?: {
    width: number;
    height: number;
    pixelRatio?: number;
  };
  theme?: 'light' | 'dark';
}
```

Preview ID는 프로젝트 상대 경로와 export 이름을 기준으로 안정적으로 생성한다.

파일 수정 시 동일한 Preview ID를 유지한다.

### 5.2 Renderer Adapter

```
interface PreviewRenderer {
  capabilities(): RendererCapabilities;
  prepare(context: ProjectContext): Promise<void>;
  render(request: RenderRequest): Promise<RenderResult>;
  openSession(request: RenderRequest): Promise<PreviewSession>;
  dispose(): Promise<void>;
}
```

### 5.3 Interactive Session

```
interface PreviewSession {
  id: string;

  capture(): Promise<RenderResult>;
  inspect(): Promise<UITree>;
  dispatch(input: Interaction): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}
```

### 5.4 Render Result

```
interface RenderResult {
  previewId: string;
  sessionId: string;
  generation: number;
  platform: 'web' | 'ios' | 'android';
  status: 'ready' | 'error' | 'stale';
  imagePath?: string;
  treePath?: string;
  width: number;
  height: number;
  durationMs: number;
  warnings: string[];
  error?: RenderError;
}
```

모든 렌더링 결과에는 Generation을 포함한다.

이전 코드에서 생성된 이미지를 현재 코드의 결과로 반환하면 안 된다.

### 5.5 Capability

렌더러마다 다음 기능의 지원 여부를 명시한다.

- Screenshot
- Interactive Input
- UI Tree
- Source Location
- Viewport Resize
- Theme Override
- Native Insets
- Animation Frame Control
- State Reset

지원하지 않는 기능은 성공한 것처럼 처리하지 않는다. UI와 CLI 모두 명시적으로 미지원 상태를 반환한다.

## 6. React Native Preview SDK

### 6.1 Preview 선언 방식

Compose의 @Preview에 대응하는 개발 전용 SDK를 제공한다.

```
import { definePreview } from '@prevue/react-native';
import { OrderCard } from './OrderCard';

export const Default = definePreview({
  name: 'Default',
  render: () => <OrderCard order={mockOrder} />,
});

export const Loading = definePreview({
  name: 'Loading',
  render: () => <OrderCard isLoading />,
});

export const Empty = definePreview({
  name: 'Empty',
  render: () => <OrderCard order={null} />,
});

export const Dark = definePreview({
  name: 'Dark mode',
  theme: 'dark',
  render: () => <OrderCard order={mockOrder} />,
});
```

### 6.2 파일 규칙

초기 지원 대상:

- `*.preview.tsx`
- `*.preview.jsx`

후속 지원 대상:

- \*.stories.tsx
- \*.stories.jsx
- 명시적으로 등록한 Screen 및 Component

프리뷰 선언을 찾기 위해 소스 모듈을 실행하지 않는다. AST로 export와 definePreview 호출을 분석한다.

실제 컴포넌트 실행은 렌더링 단계에서만 수행한다.

### 6.3 Provider 지원

실제 프로젝트 화면에서 필요한 환경을 주입할 수 있어야 한다.

- Theme Provider
- Navigation Provider
- Query Client
- Safe Area Provider
- Localization Provider
- State Management Provider
- Native Module Mock

전역 Provider와 Preview별 Provider를 구분한다.

프리뷰는 실제 운영 서버의 데이터를 사용하지 않고 명시적으로 선언한 Fixture 또는 Mock 데이터를 사용한다.

### 6.4 Storybook 호환

기존 Storybook CSF 파일을 재사용할 수 있도록 Adapter를 추가한다.

첫 지원 범위는 default meta, named story, args, render이다.

이후 decorators 및 parameters를 지원한다.

지원하지 않는 Storybook 동작을 임의로 생략하고 정상 렌더링으로 처리하지 않는다.

## 7. React Native Web Renderer

### 7.1 책임

실제 프로젝트의 React Native 코드를 React Native Web으로 렌더링하고 Playwright를 이용하여 시각적 결과를 수집한다.

### 7.2 동작 순서

1. 프로젝트 루트 및 패키지 매니저 확인
2. Preview 파일 탐색
3. 개발용 Preview Entry 생성
4. Web Dev Server 실행
5. Playwright Browser Context 생성
6. Preview Component 렌더링
7. 렌더링 완료 신호 수신
8. Screenshot 및 UI Tree 수집
9. 브라우저 뷰어 갱신

### 7.3 Bundler 정책

- React Native를 React Native Web으로 alias한다.
- .web.tsx 등 플랫폼별 파일 탐색 순서를 지원한다.
- 기존 프로젝트의 React 버전을 재사용한다.
- React 중복 설치로 인한 Invalid Hook Call을 방지한다.
- TSConfig Alias 및 Monorepo Workspace를 지원한다.
- Babel 및 Metro에만 의존하는 라이브러리는 호환성을 검사한다.
- 해결할 수 없는 Native Module은 명시적인 오류를 반환한다.

모든 Native Module을 자동 Mock 처리하지 않는다. 사용자 지정 Mock만 허용한다.

### 7.4 Preview 격리

각 Preview는 독립적인 렌더링 환경과 초기 상태를 가진다.

정적 Board는 제한된 동시성으로 렌더링하고, Interactive Preview는 별도의 활성 Session으로 관리한다.

한 카드에서 버튼을 클릭한 결과가 다른 카드에 전파되어서는 안 된다.

### 7.5 Hot Reload

Vite의 HMR 및 React Fast Refresh를 활용한다.

소스 변경을 감지한 뒤 단순히 일정 시간 대기하고 Screenshot을 찍는 방식은 금지한다.

다음 상태를 분리한다.

- Source changed
- Bundling
- Runtime applied
- Rendering
- Ready
- Error

Runtime의 갱신 및 렌더 완료 신호가 확인된 시점에 Screenshot을 생성한다.

실패 시 마지막 정상 이미지는 유지하되 stale 상태를 표시한다.

## 8. React Native Native Renderer

### 8.1 목적

Web에서 재현할 수 없는 실제 iOS 및 Android UI를 검증한다.

지원 대상:

- Native Module
- Native Font Rendering
- 플랫폼별 컴포넌트
- Safe Area
- Gesture
- Reanimated
- Keyboard
- Native Navigation
- React Native Brownfield

### 8.2 실행 방식

- Metro Dev Server
- React Native Debug Host
- Preview Registry
- Runtime Bridge
- iOS Simulator 또는 Android Emulator

기존 앱의 네이티브 기능을 필요로 하는 Preview는 해당 기능이 실제로 포함된 Debug Host에서 실행해야 한다.

독립 Preview Host가 모든 프로젝트의 Native Module을 자동으로 실행할 수 있다고 가정하지 않는다.

### 8.3 Runtime Bridge

Preview Host는 로컬 데몬으로부터 Preview ID 및 실행 옵션을 전달받는다.

지원 명령:

- Open Preview
- Reset Preview
- Set Args
- Capture
- Inspect
- Close Preview

Preview Registry는 Metro에서 처리할 수 있도록 정적 import 목록을 생성한다.

실제 Preview Component가 렌더링된 뒤 generation과 previewId를 포함한 ACK를 데몬에 반환한다.

### 8.4 Screenshot 및 Input

- iOS: simctl을 이용한 실제 Simulator Screenshot
- Android: adb를 이용한 실제 Emulator Screenshot
- Input 및 UI Hierarchy: Maestro 또는 검증된 기기 제어 Adapter

기기 Screenshot 좌표와 UI Tree 좌표의 변환 규칙을 명확하게 정의한다.

Native에서 지원되지 않는 임의의 화면 크기나 Safe Area 변경을 가짜로 구현하지 않는다.

### 8.5 Device Isolation

하나의 Native Session은 하나의 기기를 독점한다.

다른 Worktree에서 동일한 Simulator 또는 Emulator를 동시에 제어하지 못하도록 Device Lease를 적용한다.

기기가 부족하면 대기하거나 명시적인 오류를 반환한다.

사용자가 다른 작업에 사용 중인 기기를 임의로 종료하지 않는다.

### 8.6 Native Build 정책

JS/TS 변경은 Fast Refresh를 우선 사용한다.

다음 변경은 Native Host 재빌드가 필요할 수 있다.

- Pod 또는 Gradle Dependency
- Native Module
- Swift, Objective-C, Kotlin, Java
- Expo Config Plugin
- 네이티브 빌드 설정

재빌드 필요 상태는 CLI 및 Viewer에 표시한다.

## 9. Brownfield 지원

### 9.1 배경

React Native 전체 앱뿐 아니라 기존 iOS 또는 Android 앱에 React Native 화면이 삽입된 프로젝트도 지원한다.

### 9.2 두 가지 Native Host 형태

**Standalone Preview Host**

독립적인 Debug App에서 RN 컴포넌트를 실행한다. 초기 PoC에 사용한다.

**Embedded Preview Host**

기존 앱의 Debug Build에 Preview Entry와 Runtime Bridge를 추가한다.

기존 앱의 인증, Native Module, Navigation, 디자인 시스템과 연결할 수 있도록 한다.

### 9.3 제약

- Release Build에는 Preview Host를 포함하지 않는다.
- 인증 토큰 및 운영 API 접근을 자동 상속하지 않는다.
- 기존 앱 빌드 설정을 사용자 승인 없이 변경하지 않는다.
- Native Bridge 및 App Entry의 통합 방법은 프로젝트별로 명시한다.

## 10. 기존 Web Viewer 통합

### 10.1 기존 프로토콜 재사용

실제 Prevue Viewer는 다음 HTTP 및 SSE 계약을 사용한다.

- GET /viewer/state
- GET /events
- GET /project-files.json
- GET /preview-files.json
- GET /gallery/card
- POST /viewer/{intent}
- GET /stream
- POST /stream/viewport

신규 RN 데몬에서 이 계약을 호환 구현한다.

구체적인 요청과 응답은 BrowserEndpoint, BrowserMapper, runtime/api.ts 및 기존 테스트 Fixture를 기준으로 확정한다.

### 10.2 Viewer 변경 범위

유지할 기능:

- Preview Board
- Gallery
- File Search
- Tabs
- Focus Mode
- Screenshot
- Interactive Mode
- UI Inspector

추가할 기능:

- Runtime 구분
- Web / iOS / Android 표시
- 지원 가능한 Platform 선택
- Capability에 따른 조작 제한
- Native Build 필요 상태
- Native Module 미지원 오류
- Render Generation 및 Freshness 표시

Web으로 렌더링한 결과를 실제 iOS 또는 Android 렌더링이라고 표기하지 않는다.

### 10.3 배포 파이프라인

viewer-src를 원본으로 유지한다.

plugin/viewer의 생성 파일을 직접 수정하지 않는다.

기존 tools/gen-viewer.sh 및 Contract Fixture 생성 방식을 준수한다.

기존 Compose 상태 JSON과의 하위 호환성을 유지한다.

## 11. UI Inspector

### 11.1 공통 UI Node

```
interface UINode {
  id: string;
  name: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  source?: {
    file: string;
    line: number;
    column?: number;
  };
  text?: string;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  testId?: string;
  children: UINode[];
}
```

### 11.2 Web Inspector

DOM의 실제 Layout Bounds를 수집한다.

Babel Instrumentation을 통해 사용자 TSX 코드의 소스 정보를 등록하고 렌더링된 요소와 연결한다.

사용자가 UI를 선택하면 가능한 범위에서 컴포넌트 이름, 실제 파일 경로, 줄 번호 및 크기를 반환한다.

React 내부 비공개 Fiber API에 핵심 기능 전체를 의존하지 않는다.

### 11.3 Native Inspector

Accessibility Tree와 Runtime Instrumentation을 활용한다.

Native Accessibility Tree는 React Component Tree와 동일하지 않으므로 별도의 소스 매핑이 필요하다.

정확한 소스 위치를 확인할 수 없는 경우 null과 미지원 사유를 반환한다.

추정한 위치를 확정적인 소스 위치로 반환하지 않는다.

## 12. CLI 및 AI Agent Integration

### 12.1 CLI 명령

초기에는 기존 Compose 명령과 충돌하지 않는 prevue rn 네임스페이스를 사용한다.

```
prevue rn doctor
prevue rn show src/OrderCard.preview.tsx --platform web
prevue rn previews
prevue rn board
prevue rn focus 0 --on
prevue rn render
prevue rn wait --timeout 30
prevue rn status
prevue rn touch 120 340
prevue rn scroll --direction down
prevue rn type "hello"
prevue rn selection
prevue rn reset
prevue rn open
prevue rn log
prevue rn stop
```

위 명령은 목표 API이다. 실제 옵션은 기존 Prevue CLI와 최대한 일치시키고 각 --help로 확인할 수 있어야 한다.

### 12.2 종료 코드

기존 Prevue의 종료 코드 의미를 유지한다.

- 0: 성공
- 1: 렌더링 또는 실행 실패
- 2: 잘못된 사용법
- 3: 런타임 연결 또는 준비 실패

### 12.3 에이전트 작업 절차

1. Preview 탐색
2. 최초 Render
3. Screenshot 및 UI Tree 확인
4. 요구 디자인과 비교
5. 실제 소스 코드 수정
6. 해당 변경 Generation이 적용될 때까지 대기
7. 새로운 Screenshot 확인
8. 필요 시 Interactive 검증
9. 차이가 남으면 반복
10. 최종 결과와 검증 근거 보고

MCP 연동은 CLI 계약과 핵심 기능이 안정화된 이후 진행한다.

## 13. 병렬 개발 및 Worktree 격리

다음 값들을 Worktree별로 분리한다.

- 데몬 식별자
- HTTP Port
- Bundler Port
- Preview Registry
- Browser Context
- Runtime Session
- Artifact Cache
- PID 및 로그
- Native Device Lease

저장소의 remote URL이 아니라 canonical Worktree 경로를 식별 기준에 포함한다.

포트 충돌 시 다른 Worktree의 데몬에 연결하지 않는다.

한 Worktree의 수정과 종료 명령이 다른 Worktree에 영향을 주면 안 된다.

## 14. 오류 처리 및 보안

구조화된 오류 유형:

- PROJECT_NOT_FOUND
- PREVIEW_NOT_FOUND
- DEPENDENCY_MISSING
- BUNDLE_FAILED
- RUNTIME_FAILED
- UNSUPPORTED_NATIVE_MODULE
- NATIVE_BUILD_REQUIRED
- DEVICE_UNAVAILABLE
- TIMEOUT
- STALE_RENDER

기본 서버는 localhost에만 바인딩한다.

외부 접근, 사용자 프로젝트 파일 실행 및 네이티브 기기 조작에는 명시적인 신뢰 경계와 권한을 둔다.

HTTP Origin 검증과 Session Token을 적용한다.

프로젝트 경로를 벗어나는 파일 접근과 경로 조작을 방지한다.

사용자의 승인 없이 dependency 설치, lockfile 변경, 운영 API 호출을 하지 않는다.

Preview 코드는 신뢰된 로컬 프로젝트에서만 실행한다.

## 15. 성능 요구사항

다음은 목표치이며 기존 Prevue의 벤치마크를 RN에서 그대로 달성한다고 가정하지 않는다.

| 지표                     | 목표                   |
| ---------------------- | -------------------- |
| Warm Web Preview 갱신    | P50 1초 이내            |
| Warm Web Preview 갱신    | P95 3초 이내            |
| Warm Native Preview 갱신 | P50 2초 이내            |
| 오류 후 복구                | 수동 데몬 재시작 없이         |
| UI Board               | 복수 Preview 지원        |
| Worktree               | 최소 3개 Web Session 격리 |
| Native Session         | 기기 수만큼 격리            |

최초 의존성 설치, 최초 Native Build, Warm Reload를 분리해서 측정한다.

파일 저장부터 해당 generation의 Screenshot이 확정되기까지의 시간을 기준으로 측정한다.

메모리 사용량, 최초 렌더 시간, 반복 갱신 시간을 실제 환경에서 기록한다.

## 16. 개발 마일스톤

### M0. Upstream Baseline

- 원본 커밋 고정
- 기존 CLI 및 Viewer 테스트 실행
- 기존 Protocol 분석
- ADR 작성
- Compose 회귀 테스트 기준 확립

### M1. React Native Web MVP

- RN CLI
- Preview SDK
- AST Discovery
- Node.js Daemon
- RN Web Renderer
- Screenshot
- Hot Reload
- 기존 Viewer 연동
- Gallery 및 Board
- 기본 Interactive Mode
- Web Fixture

### M2. AI Inspector

- UI Tree
- 소스 위치 매핑
- Point and Select
- 터치·스크롤·입력
- Agent Skill
- Freshness 검증
- Figma 비교 작업 예시

### M3. Native Preview

- Native Debug Host
- Metro 연결
- iOS Simulator
- Android Emulator
- Runtime Bridge
- Screenshot
- Input
- Device Lease
- Native Build 필요 상태

### M4. 프로젝트 통합

- Expo 지원 확장
- Bare RN 지원 확장
- Storybook CSF
- Monorepo
- Brownfield Debug Host
- 프로젝트별 Provider 및 Mock

### M5. 배포 및 안정화

- 병렬 Worktree 검증
- 성능 벤치마크
- Plugin Packaging
- Codex 및 Claude Code 통합
- 문서화
- 선택적 MCP Server

## 17. 테스트 및 완료 조건

### Unit Test

- Preview Discovery
- Preview ID 안정성
- Project Detection
- Session Routing
- Generation 관리
- Coordinate Conversion
- Error Mapping
- Port Collision

### Integration Test

- 실제 RN Component 렌더링
- 다중 Preview Board
- 소스 수정 후 이미지 변경
- 오류 발생 후 복구
- 마지막 정상 이미지의 stale 처리
- 테마 및 상태별 렌더링
- 버튼 클릭 및 입력
- Worktree 격리
- HTTP/SSE Viewer 계약

### Native E2E Test

- 실제 Simulator / Emulator에서 Preview 실행
- TSX 변경 후 Fast Refresh
- Screenshot 변경 검증
- Native Input
- Device Lease
- Native Dependency 변경 시 재빌드 요구 표시

### Compose Regression Test

기존 Compose Preview의 동작 및 계약이 유지되어야 한다.

기존 테스트를 삭제하거나 완화하여 통과시키지 않는다.

### Definition of Done

AI 에이전트가 실제 RN Preview를 실행하고, 소스 코드를 변경한 뒤, 새로운 Screenshot을 확인하고, 인터랙션을 검증할 수 있어야 한다.

기존 Prevue Viewer에서 개발자와 에이전트가 동일한 결과를 확인할 수 있어야 한다.

테스트와 렌더링 근거가 없는 기능을 완료로 보고하지 않는다.

## 18. 라이선스 및 배포

원본 프로젝트의 Apache 2.0 라이선스와 저작권 고지를 유지한다.

변경한 파일 및 추가한 의존성의 라이선스 조건을 확인한다.

포크된 프로젝트가 Kakao의 공식 배포판으로 오인되지 않도록 한다.

공개 배포 전 프로젝트 명칭, 패키지 네임스페이스 및 배포 권한을 확정한다.

