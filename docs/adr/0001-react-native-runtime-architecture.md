# 독립 RN 런타임과 기존 뷰어의 경계

승인 대상 기준 커밋은 kakao/prevue의 `e40cb00b9315b72dd5471e33638562b7e8730478`이다.

Compose의 PreviewSpec에는 JVM 함수와 PreviewParameter가, Compiler에는 Gradle 모듈 및 클래스 오버레이가, HotReload에는 Kotlin 리터럴과 리소스 패치가 들어 있다. LiveSession도 Compose 트리와 프레임을 반환한다. RN은 별도 프로세스로 띄우고 브라우저가 관찰하는 상태와 의도를 공유한다. 기존 셸 진입점은 rn을 선택했을 때만 Node를 실행한다.

Viewer API는 BrowserEndpoint의 routeLive, routeData, routeGallery와 BrowserMapper 및 BrowserPresenter가 결정한다. viewer-src/src/session.ts는 증가하는 version만 적용한다. version은 화면 상태의 변경 횟수다. generation은 번들에 반영할 소스 버전이다. 상호작용만으로 version과 이미지가 바뀌어도 generation은 같을 수 있다.

데몬은 프로젝트의 실제 경로별로 분리한다. CLI가 명시적으로 선택한 로컬 프로젝트에서만 프리뷰 모듈을 실행한다. 탐색은 AST를 사용한다. 렌더러는 React 커밋 후 이미지를 반환하고, 서버는 현재 세대에 해당하는 결과만 게시한다. 이전 이미지가 있다면 소속 세대와 오류를 함께 보존한다. 기기 렌더러에는 별도 기기 임대가 필요하다.

설치본의 웹 자산은 viewer-src에서 tools/gen-viewer.sh로 생성한다. Kotlin의 계약 fixture와 기존 실행 경로는 Compose 회귀 기준이다. 서드파티 의존성 설치는 런타임과 샘플에서 명시적으로 수행한다.
