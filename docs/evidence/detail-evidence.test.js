// [학생 추가] 보고서용 세부 증거 생성 스크립트입니다. 채점 테스트(tests/)는 수정하지 않고 같은 fixture를 재사용합니다.
// 실행: node --test docs/evidence/detail-evidence.test.js → docs/evidence/detail-evidence.txt 생성
// 거부 요청·저장 실패 요청 전후의 applications/application_history 전체를 비교해 기록합니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fixture } from '../../tests/helpers.js';

const out = [];
const log = (...s) => out.push(s.join(' '));
const full = f => ({
  applications: f.db.prepare('SELECT id,event_id,user_id,status,created_at FROM applications ORDER BY id').all(),
  history: f.db.prepare('SELECT id,application_id,actor_id,action,from_status,to_status,reason,cause_history_id FROM application_history ORDER BY id').all()
});
const dump = (title, s) => {
  log(`-- ${title}`);
  log('applications:'); for (const a of s.applications) log('  ', JSON.stringify(a));
  log('application_history:'); for (const h of s.history) log('  ', JSON.stringify(h));
};
const res = (label, r) => log(`${label} → HTTP ${r.status}`, JSON.stringify(r.data.code ? r.data : { id: r.data.id ?? r.data.revoked?.id, promoted: r.data.promoted?.id ?? r.data.promoted }));
const revoke = (f, name, id, reason = '운영 사정으로 승인 취소') =>
  f.request(`/api/applications/${id}/revoke`, { method: 'POST', token: f.tokens[name], body: { reason } });

test('E1 거부 사례: 정원이 찬 행사 2의 직접 승인(CAPACITY_FULL)', async t => {
  const f = await fixture(t);
  log('\n# E1 거부 사례 상세 — 행사 2(정원 1), alice 승인 후 bob 직접 승인 시도');
  const a = (await f.apply('alice', 2)).data; await f.action('manager2', a.id, 'approve');
  const b = (await f.apply('bob', 2)).data;
  const before = full(f); dump('요청 전', before);
  const r = await f.action('manager2', b.id, 'approve'); res('POST /api/applications/' + b.id + '/approve (manager2)', r);
  const after = full(f); dump('요청 후', after);
  assert.deepEqual(after, before);
  log('비교 결과: 요청 전후 applications·application_history 완전히 동일(assert.deepEqual 통과)');
});

test('E2 롤백: AUTO_APPROVE 이력 저장 실패(T29와 같은 주입)', async t => {
  const f = await fixture(t);
  log('\n# E2 롤백 증거 — 행사 1, alice 승인 + bob 대기, AUTO_APPROVE 이력 INSERT 실패 주입');
  const a = (await f.apply('alice')).data; await f.action('manager1', a.id, 'approve');
  const b = (await f.apply('bob')).data;
  const before = full(f); dump('요청 전', before);
  f.db.exec("CREATE TRIGGER fail_auto BEFORE INSERT ON application_history WHEN NEW.action='AUTO_APPROVE' BEGIN SELECT RAISE(ABORT,'TEST_INJECTED_FAILURE'); END");
  log('주입: CREATE TRIGGER fail_auto BEFORE INSERT ON application_history WHEN NEW.action=\'AUTO_APPROVE\' → RAISE(ABORT)');
  log('실패 직전까지 실행된 변경: alice APPROVED→REVOKED, REVOKE 이력 INSERT, bob PENDING→APPROVED (모두 같은 트랜잭션 안)');
  const r = await revoke(f, 'manager1', a.id); res('POST /api/applications/' + a.id + '/revoke (manager1)', r);
  const after = full(f); dump('실패 요청 후', after);
  assert.deepEqual(after, before);
  log('비교 결과: 두 신청 상태와 이력 3건이 요청 전과 완전히 동일 → 앞선 3개 변경이 모두 ROLLBACK됨');
  f.db.exec('DROP TRIGGER fail_auto');
  const retry = await revoke(f, 'manager1', a.id); res('재시도(트리거 제거 후)', retry);
  dump('재시도 후', full(f));
  assert.equal(retry.status, 200); assert.equal(retry.data.promoted.id, b.id);
});

test('E3 대기 순서: created_at 차이와 동일 시각', async t => {
  log('\n# E3 대기 순서 — 행사 2(정원 1), alice 승인 후 bob·charlie 대기');
  for (const [title, setup, expected] of [
    ['시각이 다른 경우: charlie가 더 이른 시각', (f, b, c) => {
      f.db.prepare('UPDATE applications SET created_at=? WHERE id=?').run('2026-11-02T00:00:00.000Z', b.id);
      f.db.prepare('UPDATE applications SET created_at=? WHERE id=?').run('2026-11-01T00:00:00.000Z', c.id);
    }, 'charlie'],
    ['시각이 같은 경우: id가 작은 bob', f => {
      f.db.prepare("UPDATE applications SET created_at='2026-11-01T00:00:00.000Z' WHERE status='PENDING'").run();
    }, 'bob']
  ]) {
    const f = await fixture(t);
    const a = (await f.apply('alice', 2)).data; await f.action('manager2', a.id, 'approve');
    const b = (await f.apply('bob', 2)).data, c = (await f.apply('charlie', 2)).data;
    setup(f, b, c);
    log(`-- ${title}`);
    for (const x of f.db.prepare("SELECT id,user_id,status,created_at FROM applications WHERE event_id=2 ORDER BY id").all()) log('  ', JSON.stringify(x));
    const r = await revoke(f, 'manager2', a.id); res('revoke', r);
    const want = expected === 'bob' ? b.id : c.id;
    assert.equal(r.data.promoted.id, want);
    log(`승급 대상: 신청 #${r.data.promoted.id} (${expected}) — 기대와 일치`);
    await f.stop();
  }
});

test.after(() => {
  writeFileSync(new URL('./detail-evidence.txt', import.meta.url), `${process.version}\n` + out.join('\n') + '\n');
});
