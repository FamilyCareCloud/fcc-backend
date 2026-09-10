# API 계약 v0.1

로컬 주소: http://127.0.0.1:3000. `/health` 외 요청은 `Authorization: Bearer <DEV_TOKEN>` 필요. JSON 객체 요청/응답. 성공 GET/PATCH 200, 생성 POST 201, assistant POST 200. 오류 `{ "error": "설명" }`, 코드 400/401/403/404/409/413/500.

아래 `{g}`는 그룹 ID, `{id}`는 해당 리소스 ID. 날짜는 시간대 포함 ISO 8601, 예: `2026-09-12T10:00:00+09:00`. ID와 작성자는 서버에서 설정합니다.

| 메서드 | 경로 | 입력/설명 |
|---|---|---|
| GET | /health | 상태 확인 |
| POST | /groups | elderName, name(생성 보호자 이름) |
| GET | /groups | 참여 그룹 목록 |
| GET | /groups/{g} | 그룹·담당 이력·기록·일정·요청 |
| POST | /groups/{g}/members | userId, name, role(caregiver/elder, 기본 caregiver); 소유자만 |
| PATCH | /groups/{g}/assignment | nextCaregiverId(또는 null); 현재 담당자만 |
| POST | /groups/{g}/handover | 다음 담당자로 교대; 현재 담당자만 |
| POST | /groups/{g}/events | type, content, timestamp(생략 시 현재); 보호자만 |
| GET | /groups/{g}/events | 선택 쿼리 from, to, type; 시간 오름차순 |
| POST | /groups/{g}/schedules | title, type, scheduledAt, caregiverId(기본 현재 담당자); 보호자만 |
| GET | /groups/{g}/schedules | 시간 오름차순 |
| PATCH | /groups/{g}/schedules/{id} | status: completed; 현재 담당자만 |
| POST | /groups/{g}/approvals | scheduleId, action(cancel/reschedule), reason, proposedAt(reschedule 필수) |
| GET | /groups/{g}/approvals | 요청 목록 및 담당자 |
| PATCH | /groups/{g}/approvals/{id} | decision: approve/reject/call; 현재 담당자만 |
| GET | /groups/{g}/handoff | days: 1~30, 기본 7 |
| POST | /groups/{g}/assistant | question: 한국어 질문 |

CareEvent type: hospital, meal, medication, homecoming, care_center, observation. 시스템 생성 type: schedule, approval, handover.
Schedule type: hospital, visit, care_center, medication, other. 상태: scheduled/completed/cancelled.
Approval 상태: pending/approved/rejected. call은 contactRequestedAt만 기록하며 대기 상태를 유지합니다.

예시 기록 요청:
```json
{"type":"meal","content":"저녁 식사 절반 섭취","timestamp":"2026-09-09T18:40:00+09:00"}
```

기록 응답 필드: id, type, content, timestamp, createdAt, createdBy, source(caregiver/system).
일정 응답 필드: id, title, type, scheduledAt, caregiverId, status, version, createdBy.
인수인계 응답 필드: mode(extractive), generatedAt, since, health, life, needsAttention, upcomingSchedules, pendingApprovals, primaryCaregiverId, nextCaregiverId. 분류 항목은 eventId/content/timestamp로 원문 근거를 제공합니다.
질문 응답 필드: mode(database), answer, sources(scheduleId 목록), requiresApproval(변경/취소 질문 시 true).

현재 목록은 페이지네이션이 없는 소규모 로컬 MVP입니다. 구성원 등록은 기존 인증 사용자 ID를 알고 있는 소유자용 계약이며 이메일 초대/가입 검증은 AWS 인증 구현 때 추가합니다. 프론트 로컬 개발 서버는 /api 프록시를 백엔드로 연결하고 /api 접두사를 제거하세요. DEV_TOKEN을 브라우저 배포 번들에 포함하지 마세요.
