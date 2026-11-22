import { AppError, missing, forbidden, invalidState } from './errors.js';

// TODO-01~04: 업무 규칙과 트랜잭션을 직접 구현합니다. docs/API.md를 먼저 읽으세요.
// actor는 검증된 로그인 사용자입니다. repo의 저장 함수는 권한을 검사하지 않습니다.
// 상태 변경과 이력 저장은 함께 성공하거나 함께 실패해야 합니다.
// 승인 취소와 자동 승급은 신청 2건 + 이력 2건을 한 트랜잭션으로 처리합니다.

// ---- 이하 학생 구현 ----

const alreadyApplied = () => new AppError(409,'ALREADY_APPLIED','이미 이 행사에 신청한 기록이 있습니다.');
const capacityFull = () => new AppError(409,'CAPACITY_FULL','승인 정원이 모두 찼습니다.');

// SQLite UNIQUE(event_id,user_id) 위반 여부. 서비스 검사를 통과한 뒤 저장 단계에서 걸린 경우에도 409로 응답하기 위함.
const isUniqueViolation = e => e?.errcode===2067 || /UNIQUE constraint failed/.test(e?.message ?? '');

export function createApplicationService(repo) {
  const { db } = repo;

  // 트랜잭션 경계: 검사(조회)와 변경(상태+이력)을 모두 하나의 트랜잭션 안에서 실행합니다.
  // - BEGIN IMMEDIATE: 시작 시점에 쓰기 잠금을 잡아, 다른 연결(다른 서버 프로세스)이
  //   검사와 저장 사이에 끼어들어 같은 데이터를 바꾸지 못하게 합니다(R8 최신 상태).
  // - work()가 끝까지 성공하면 COMMIT, 업무 규칙 거부(AppError)든 저장 오류든 예외가 나면 ROLLBACK 후 다시 던집니다.
  //   → 거부·실패한 요청은 상태와 이력을 하나도 남기지 않습니다(R7 원자성).
  // node:sqlite(DatabaseSync)는 동기 API이므로 BEGIN~COMMIT 사이에 다른 요청 처리가 끼어들지 않습니다.
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  }

  // 대상 신청과 소속 행사를 DB에서 다시 읽습니다. 없으면 404.
  function loadApplication(applicationId) {
    const application = repo.application(applicationId);
    if (!application) throw missing('신청');
    return { application, event: repo.event(application.eventId) };
  }

  const isManagerOf = (actor,event) => actor.role==='MANAGER' && event.managerId===actor.id;

  return {
    // TODO-01: 행사 존재 → 학생 역할 → 중복 → PENDING 저장 + APPLY 이력.
    apply(actor,eventId) {
      return transaction(() => {
        const event = repo.event(eventId);
        if (!event) throw missing('행사');
        if (actor.role!=='STUDENT') throw forbidden();
        // CANCELLED·REVOKED를 포함해 기존 신청이 있으면 상태와 무관하게 중복입니다(R2).
        if (repo.existing(eventId,actor.id)) throw alreadyApplied();
        let created;
        try {
          created = repo.insert(eventId,actor.id);
        } catch (e) {
          if (isUniqueViolation(e)) throw alreadyApplied();
          throw e;
        }
        repo.addHistory({ applicationId: created.id, actorId: actor.id, action: 'APPLY', fromStatus: null, toStatus: 'PENDING' });
        return created;
      });
    },

    // TODO-02: 신청 존재 → 본인 → PENDING → CANCELLED + CANCEL 이력. 자동 승급 없음.
    cancel(actor,applicationId) {
      return transaction(() => {
        const { application } = loadApplication(applicationId);
        if (actor.role!=='STUDENT' || application.userId!==actor.id) throw forbidden();
        if (application.status!=='PENDING') throw invalidState();
        const updated = repo.setStatus(application.id,'CANCELLED');
        repo.addHistory({ applicationId: application.id, actorId: actor.id, action: 'CANCEL', fromStatus: 'PENDING', toStatus: 'CANCELLED' });
        return updated;
      });
    },

    // TODO-03: 신청 존재 → 담당 운영자 → PENDING → 정원 → APPROVED + APPROVE 이력.
    approve(actor,applicationId) {
      return transaction(() => {
        const { application, event } = loadApplication(applicationId);
        if (!isManagerOf(actor,event)) throw forbidden();
        if (application.status!=='PENDING') throw invalidState();
        // 정원에는 APPROVED만 포함합니다(R4). 트랜잭션 안에서 다시 세므로 최신 인원 기준입니다.
        if (repo.approvedCount(event.id) >= event.capacity) throw capacityFull();
        const updated = repo.setStatus(application.id,'APPROVED');
        repo.addHistory({ applicationId: application.id, actorId: actor.id, action: 'APPROVE', fromStatus: 'PENDING', toStatus: 'APPROVED' });
        return updated;
      });
    },

    // TODO-04: 신청 존재 → 담당 운영자 → APPROVED → REVOKED + REVOKE 이력
    //          → 같은 행사 첫 대기자 1명 AUTO_APPROVE + 원인 이력 연결. 전체가 한 트랜잭션입니다.
    revoke(actor,applicationId,reason) {
      return transaction(() => {
        const { application, event } = loadApplication(applicationId);
        if (!isManagerOf(actor,event)) throw forbidden();
        // REVOKED 재요청도 여기서 409로 거부됩니다(R8 반복 승인 취소 거부).
        if (application.status!=='APPROVED') throw invalidState();

        // 1) 승인 취소 + REVOKE 이력(사유는 app.js에서 trim·길이 검사 완료)
        const revoked = repo.setStatus(application.id,'REVOKED');
        const revokeHistoryId = repo.addHistory({ applicationId: application.id, actorId: actor.id, action: 'REVOKE', fromStatus: 'APPROVED', toStatus: 'REVOKED', reason });

        // 2) 비워진 한 자리를 대기자 1명에게만 넘깁니다(요청당 최대 1명).
        const next = repo.nextPending(event.id);
        let promoted = null;
        if (next) {
          promoted = repo.setStatus(next.id,'APPROVED');
          // 행위자는 승인 취소를 요청한 운영자, 원인은 방금 저장한 REVOKE 이력입니다.
          repo.addHistory({ applicationId: next.id, actorId: actor.id, action: 'AUTO_APPROVE', fromStatus: 'PENDING', toStatus: 'APPROVED', causeHistoryId: revokeHistoryId });
        }
        return { revoked, promoted };
      });
    }
  };
}
