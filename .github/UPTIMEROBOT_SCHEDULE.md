# UptimeRobot 절전 스케줄 설정

이 저장소의 `UptimeRobot sleep schedule` 워크플로는 다음 일정으로 동작합니다.

- 매일 06:00 KST: UptimeRobot 모니터를 일시정지합니다.
- 매일 17:45 KST: UptimeRobot 모니터를 다시 시작합니다.
- Render는 마지막 요청 후 약 15분 동안 요청이 없으면 절전 상태로 전환됩니다.

## 필요한 GitHub Actions Secrets

GitHub 저장소의 `Settings > Secrets and variables > Actions`에서 다음 Repository secrets를 추가합니다.

| Secret | 값 |
| --- | --- |
| `UPTIMEROBOT_API_KEY` | UptimeRobot `Integrations & API`에서 발급한 쓰기 가능한 Main API Key |
| `UPTIMEROBOT_MONITOR_ID` | Render 서비스 URL을 감시하는 UptimeRobot Monitor ID |

API Key는 저장소 파일, 커밋, 이슈 또는 Actions 로그에 직접 입력하지 않습니다. Monitor-specific API Key와 Read-only API Key는 모니터 시작/중지 권한이 없으므로 사용할 수 없습니다.

## UptimeRobot 모니터 설정

UptimeRobot의 HTTP(s) 모니터 URL은 다음 공개 상태 확인 경로를 사용합니다.

```text
https://song-queue-server.onrender.com/health
```

무료 플랜에서는 모니터링 간격을 5분으로 설정합니다.

## 최초 확인

Secrets 설정 후 GitHub 저장소의 `Actions > UptimeRobot sleep schedule > Run workflow`에서 다음 순서로 확인합니다.

1. `pause`를 실행하고 UptimeRobot 대시보드에서 모니터가 Paused 상태인지 확인합니다.
2. `start`를 실행하고 모니터가 다시 Started/Up 상태인지 확인합니다.
3. 두 실행이 모두 성공한 뒤 예약 실행을 그대로 사용합니다.

GitHub Actions 예약 실행은 정각에 약간 지연될 수 있습니다. 그래서 18시 사용 시작보다 15분 빠른 17:45에 모니터를 시작합니다.
