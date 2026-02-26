# Windows File Explorer + PDF Extractor (Tauri + React)

Windows 중심 로컬 파일 탐색기 MVP입니다.

## 구현된 MVP 기능

- 좌측 폴더 패널
  - 드라이브 고정 바로가기(C:, D: 등) 표시
  - 자동 정렬 (이름/수정일)
  - 수동 정렬 모드 ON 시 햄버거 핸들 드래그 순서 변경
  - 수동 순서 SQLite 저장/복원
- 우측 파일 패널
  - 자동 정렬 (이름/수정일)
  - 수동 정렬 모드 ON 시 파일 행 드래그로 순서 변경
  - 파일 수동 순서 SQLite 저장/복원
- 우측 항목 패널(혼합 뷰)
  - 폴더 + 파일 동시 표시
  - 우측 패널에서 폴더 열기(이동)
- 상단 북마크 바
  - 현재 폴더/선택 폴더 북마크 고정
  - 북마크 클릭 이동, 개별 제거
- 탐색 인터랙션
  - 폴더 1회 클릭: 우측 파일 미리보기
  - 폴더 2회 클릭: 폴더 진입
- 파일 표시
  - Gallery / List 뷰 전환
  - 파일 선택 및 더블클릭 외부 앱 열기
  - 숨김 파일/폴더 포함 표시(반투명 스타일)
- 파일시스템 작업
  - 복사/잘라내기/붙여넣기
  - 삭제
  - 이름 바꾸기(F2)
  - 새 폴더 만들기(Ctrl/Cmd+Shift+N)
  - 드래그 앤 드롭 이동/복사(내부/외부 파일 드롭)
- PDF 기능
  - PDF 페이지 썸네일 로드
  - 클릭으로 페이지 선택/해제
  - 선택 페이지를 단일 PDF로 추출
- UI
  - 라이트 테마 전용
  - Pretendard 폰트 적용
  - Windows 11 스타일에 맞춘 큰 컨트롤/행 높이
- 경로 호환
  - WSL 환경에서 `C:\...` 입력 경로를 `/mnt/c/...`로 변환 처리

## 기술 스택

- Desktop Shell: **Tauri v2**
- Frontend: **React + TypeScript + Vite**
- Drag & Drop: **@dnd-kit**
- PDF Preview: **pdfjs-dist**
- Backend PDF Extract: **lopdf** (Rust)
- Local Persistence: **rusqlite (SQLite)**
- Icons: **lucide-react**
- Tests: **Vitest**
- Spec Workflow: **OpenSpec**

## 개발 도구/검증 커맨드

```bash
npm install
npm run lint
npm run test
npm run build
source ~/.cargo/env && (cd src-tauri && cargo test)
```

## Windows 실행 경로

- 복사 위치: `C:\workspace\windows-pdf-dir`
- WSL 개발 실행(더블클릭): `RUN_WSL_DEV.bat`
- Windows 설치파일 빌드(더블클릭): `BUILD_WINDOWS_INSTALLER.bat`

## OpenSpec 워크플로우

- 스펙: `openspec/specs/windows-file-explorer-mvp/spec.md`
- 변경 문서: `openspec/changes/2026-02-25-windows-tauri-react-mvp/`
- 검증:

```bash
openspec validate --all --json --no-interactive
```

## 사용자 워크플로우 (텍스트 화면)

### 1) 메인 탐색 화면
- TopBar: 경로, 상위 폴더, 새로고침, 정렬, 수동정렬 토글, 북마크 고정, 뷰 전환
- Bookmark Bar: 크롬 북마크 바처럼 고정된 폴더 칩 표시
- Left: 드라이브 리스트 + 폴더 리스트(드래그 핸들)
- Right: 선택/미리보기 경로의 폴더+파일 혼합 목록/갤러리

### 2) 정렬 모드
- 자동 모드: 정렬 셀렉트 활성
- 수동 모드: 정렬 셀렉트 비활성 + 드래그 핸들 활성

### 3) PDF 추출 모달
- 페이지 썸네일 그리드
- 전체 선택/해제
- 선택 페이지를 새 PDF 1개로 저장

## 디렉터리 구조

- `src/` 프론트엔드 UI
- `src-tauri/src/fs.rs` 파일시스템 조회 명령
- `src-tauri/src/order.rs` SQLite 수동순서 저장/조회
- `src-tauri/src/pdf.rs` PDF 페이지 추출
- `src-tauri/src/models.rs` 공용 DTO 타입
