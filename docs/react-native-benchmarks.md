# React Native 프리뷰 실측

2026년 11월 27일, Apple M4 Pro(논리 CPU 14개, RAM 48 GiB), macOS 27.2.1(26B131), Node.js 26.7.0에서 측정했다. 웜 측정은 오름차순 표본에서 `ceil(n × p)` 번째 값을 사용한다. 시간은 모두 밀리초다.

## RN Web

`fixtures/react-native-web/OrderCard.preview.tsx`의 Default, Loading, Error 세 카드를 측정했다. React 19.2.0, React Native 0.82.1, React Native Web 0.21.4, Vite 6.4.6, Playwright 1.65.1의 Chromium을 사용했다. `show`는 새 프로젝트 상태 디렉터리와 새 데몬으로 시작했다. 의존성 및 브라우저 설치는 측정 전에 마쳤다. 런타임 코드는 `56cc088`에서 측정했다.

| 콜드 측정 | 1회 |
| --- | ---: |
| CLI `show` 시작부터 세 카드 응답까지 | 1,825 |
| 그중 데몬 기동 | 980 |
| 세 카드 보드 요청 | 484 |
| 첫 카드 렌더러 내부 시간 | 319 |

| 웜 측정 | 횟수 | P50 | P95 |
| --- | ---: | ---: | ---: |
| 집중 모드의 `render` CLI 응답 | 10 | 399 | 417 |
| 소스 저장부터 세 카드가 같은 새 세대로 확정될 때까지 | 10 | 398 | 526 |
| 상세 버튼 탭부터 새 이미지·트리를 담은 CLI 응답까지 | 10 | 467 | 484 |

한 worktree에서 세 카드가 준비된 직후 RSS 합계는 **801 MiB**, 독립적인 세 worktree에서 같은 보드를 연 뒤에는 **2,330 MiB**였다. 각 데몬과 하위 브라우저·번들러 프로세스의 RSS를 합산한 값으로, 공유 페이지가 중복 집계될 수 있다. Web 웜 `render`는 이 환경에서 P50 1초 및 P95 3초 목표를 충족했다.

## iOS와 Android 최초 기준선

`fixtures/react-native-bare/Shipment.preview.tsx`를 설치된 RN 0.82.1 Debug Host에서 실행했다. iOS 27.2 iPhone Duo Simulator의 주 화면은 1398 × 2034, Android API 36 ARM64 Emulator는 1080 × 2400이다. 설치·빌드가 끝난 뒤 새 데몬을 열었다. Metro 디스크 캐시는 유지했다. CLI 시간에는 이미지와 접근성 트리 수집이 포함된다.

| 측정 | iOS | Android |
| --- | ---: | ---: |
| 첫 `show` 전체, 1회 | 10,410 | 6,377 |
| 데몬 기동, 1회 | 3,221 | 2,577 |
| 첫 보드 요청, 1회 | 6,469 | 3,366 |
| 웜 `render` CLI P50 / P95, 각 5회 | 1,161 / 1,401 | 2,579 / 2,599 |
| 웜 렌더러 캡처 P50 / P95, 각 5회 | 674 / 725 | 2,156 / 2,185 |

iOS는 웜 P50 2초 목표를 충족했다. Android의 최초 5회 측정에서 UI Automator 트리를 포함한 렌더러 캡처는 P50 2,156ms였다. 실제 디바이스 빌드·설치, 웹의 임의 뷰포트, 물리 단말 성능은 이 기록의 측정 대상 밖이다.

### Android 웜 렌더 개선

같은 API 36 ARM64 AVD(`PrevueNativeFixture`, `emulator-5564`)를 한 번 부팅한 상태에서 `1878e45`와 `9d70894`를 비교했다. 설치된 Debug APK, Shipment 프리뷰, Metro 디스크 캐시를 그대로 썼다. 각 버전에서 데몬을 시작해 `show`와 `focus`를 마친 뒤 15회씩 두 번 측정했다. 전체 CLI 시간에는 매번 새 CLI 프로세스에서 실제 PNG와 접근성 트리를 담은 응답을 받기까지가 포함된다.

| 웜 렌더, 버전별 30회 | 개선 전 P50 | 개선 후 P50 | 개선 전 P95 | 개선 후 P95 |
| --- | ---: | ---: | ---: | ---: |
| 전체 `prevue rn render` CLI | 2,507 | **1,637** | 2,589 | **1,671** |
| 렌더러 내부 캡처 | 2,147 | 1,267 | 2,189 | 1,306 |

기기 명령을 따로 5회 측정했을 때 PNG 캡처 중앙값은 118ms였다. UI Automator는 전체 XML을 1,109ms에 출력했지만 프로세스 종료까지는 1,948ms가 걸렸다. 변경 후에는 같은 UI Automator가 접근성 연결을 닫고 출력하는 성공 메시지를 받은 뒤 XML을 파싱한다. 기기 임대를 반납할 때 남은 프로세스 종료를 기다린다. 전체 CLI 중앙값은 870ms(34.7%) 줄었다. [UI Automator의 종료 순서](https://android.googlesource.com/platform/frameworks/base/+/2940697c9c7d6edecc9ce1d14d9945d92139bf4e/cmds/uiautomator/cmds/uiautomator/src/com/android/commands/uiautomator/DumpCommand.java)

초기 화면, 탭, 입력, 초기화, 스크롤에서 개선 전후의 접근성 트리 전체가 일치했다. 각 상태에서 화면이 안정된 뒤 독립적으로 읽은 `adb screencap` PNG와 렌더러 PNG도 전체 바이트가 일치했다. 별도로 저장한 전후 초기 화면에서 픽셀 차이는 시스템 상태바의 y=52–79에만 있었다. [개선 전 PNG](../assets/react-native/android-warm/before.png) · [개선 후 PNG](../assets/react-native/android-warm/after.png) · [전체 트리](../assets/react-native/android-warm/tree.json) · [UI Automator 원본 XML](../assets/react-native/android-warm/uiautomator.xml) · [원시 표본과 검증값](../assets/react-native/android-warm/measurements.json)

## 기존 네이티브 앱에 삽입한 RN 화면

같은 두 기기에 설치한 Brownfield Debug 빌드에서 네이티브 헤더 아래의 RN 화면을 조작했다. 아래는 각각 한 번 측정한 전체 CLI 시간이다. 저장은 TSX 쓰기 직전부터 새 세대(3 → 4)의 PNG를 읽을 수 있을 때까지 쟀다. 이어진 문법 오류(5)와 복구(6)도 같은 세션에서 확인했다.

| 동작 | iOS | Android |
| --- | ---: | ---: |
| TSX 저장 → 변경된 PNG | 1,070 | 2,601 |
| 탭 → 새 PNG | 1,252 | 2,553 |
| 초기화 → 초기 상태 PNG | 1,059 | 2,749 |

## 원시 표본 및 재현

| 작업 | 실행 순서의 밀리초 |
| --- | --- |
| Web 웜 렌더 | 398, 400, 417, 398, 399, 400, 399, 416, 399, 402 |
| Web 저장 → 세 카드 | 526, 494, 416, 410, 390, 398, 408, 398, 393, 393 |
| Web 탭 → 이미지 | 484, 466, 469, 451, 450, 466, 467, 467, 467, 467 |
| iOS 웜 CLI | 1161, 1401, 1071, 1168, 1044 |
| iOS 웜 캡처 | 674, 725, 618, 713, 597 |
| Android 최초 웜 CLI | 2597, 2599, 2571, 2542, 2579 |
| Android 최초 웜 캡처 | 2185, 2162, 2156, 2134, 2156 |

Web 측정기는 실제 Git worktree 세 개를 만들어 격리된 상태 디렉터리에서 CLI를 실행한다. 아래 명령을 저장소 루트에서 실행한다. 기기 측정에는 [Debug Host 빌드·설치 절차](../tests/react-native/device.md)가 필요하다.

```sh
node tests/react-native/benchmark.mjs 10
node tests/react-native/device.mjs ios "$IOS_UDID"
node tests/react-native/device.mjs android "$ANDROID_SERIAL" --warm-runs 15 --max-warm-p50-ms 2000
```
