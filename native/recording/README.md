# Native Android recording module

Capacitor bridge planned for phase 2.

Required contract:

- `startSession(meetingId)` starts a foreground recording service.
- `pauseSession()` and `resumeSession()` preserve sequence state.
- `stopSession()` closes the current segment and flushes metadata.
- `listLocalSegments(meetingId)` returns append-only segments and checksums.
- `deleteLocalMeeting(meetingId)` requires explicit user confirmation.

Each segment must remain playable without network access. Upload acknowledgement is separate from local deletion. The module must recover after process death, activity recreation, screen lock, and temporary connectivity loss.
