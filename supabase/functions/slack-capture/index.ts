// Supabase Edge Function: 슬랙 📌 반응 → 일감 자동 캡처 + Claude 자동 정리
// Slack Events API (reaction_added) 에 연결
// 흐름: 📌(pushpin) 반응 → 반응 대상 메시지 수집 → Claude가 제목·우선순위·마감일·완료조건 정리
//       → 팀별 테이블(autolab_task / biz_task) INSERT → 스레드에 정리 결과 답글
// ANTHROPIC_API_KEY 가 없거나 호출이 실패하면 예전처럼 원문 그대로 미분류 저장한다(일감을 흘리지 않기 위해).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { tidyWithClaude } from './tidy.ts';

type Team = 'autolab' | 'biz';

// Slack user_id → 담당자 / 소속. 여기 없는 사람의 📌 는 무시한다.
const USERS: Record<string, { person: string; team: Team }> = {
  // 오토랩
  'U06PSEETK54': { person: '강희준', team: 'autolab' },
  'U08DNK6QP1P': { person: '송민호', team: 'autolab' },
  'U032FKB6SJK': { person: '안보람', team: 'autolab' },
  // 경영지원팀
  'U0AJUTRFDBR': { person: '정희진', team: 'biz' },
  'U0ADTQN40UF': { person: '박현아', team: 'biz' },
  'U06HMUNA26Q': { person: '전윤정', team: 'biz' },
  'U0BSVTE98LF': { person: '강라영', team: 'biz' },
};

const TEAM_CONFIG: Record<Team, { table: string; dashboard: string; label: string }> = {
  autolab: {
    table: 'autolab_task',
    dashboard: 'https://jungsikson.github.io/autolab-dashboard/',
    label: '오토랩',
  },
  biz: {
    table: 'biz_task',
    dashboard: 'https://jungsikson.github.io/bizsupport-dashboard/',
    label: '경영지원팀',
  },
};

const TRIGGER = 'pushpin'; // 📌
const APPROVE_TRIGGER = 'white_check_mark'; // ✅ — 근무 밖 예약 차단 해제 (슬롯 열기)
// 👌 — "확인했고 정상이다". 무반응을 '정상'으로 흡수하지 않기 위해 별도 반응으로 받는다.
// ☑️·✔️ 는 쓰지 않는다 — ✅ 와 시각적으로 가까운데 ✅ 는 실제로 차단을 지운다.
const KEEP_TRIGGER = 'ok_hand';
const RECHECK_LEAD_DAYS = 3; // 정상 확인은 영구 면제가 아니다 — 차단일 D-3에 한 번 더 묻는다
// 차단 해제 승인은 강희준만. 📌 캡처(USERS)보다 좁다 — 운영 데이터를 지우는 행위라 권한을 따로 둔다.
const APPROVERS = new Set(['U06PSEETK54']);
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const PRIORITY_LABEL: Record<string, string> = {
  DO: '긴급+중요',
  DELEGATE: '긴급+안중요',
  SCHEDULE: '중요+안긴급',
  ELIMINATE: '둘다아님',
  '': '미분류',
};

function kstToday(): string {
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// Slack 서명 검증 (SLACK_SIGNING_SECRET 미설정 시 스킵 — 초기 셋업용)
async function verifySlack(req: Request, raw: string): Promise<boolean> {
  const secret = Deno.env.get('SLACK_SIGNING_SECRET');
  if (!secret) return true;
  const ts = req.headers.get('x-slack-request-timestamp') || '';
  const sig = req.headers.get('x-slack-signature') || '';
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay 방지
  const base = `v0:${ts}:${raw}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
  const hex = 'v0=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === sig;
}

async function slackGet(token: string, method: string, params: Record<string, string>) {
  const url = `https://slack.com/api/${method}?` + new URLSearchParams(params);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return await r.json();
}

// ✅ 승인 처리 — block-audit 이 올린 "차단 해제 후보" 메시지에만 반응한다.
// 📌 캡처 경로와 완전히 분리돼 있어 이 함수가 실패해도 일감 캡처에는 영향이 없다.
// 실제 삭제는 여기서 하지 않는다. MySQL 은 원격에서 못 닿으므로 승인만 기록하고,
// 로컬 잡(block-audit.py apply)이 다시 검증한 뒤 지운다.
async function handleReleaseApproval(ev: any): Promise<Response> {
  if (!APPROVERS.has(ev.user)) return new Response('not an approver', { status: 200 });
  const who = USERS[ev.user];
  if (!who) return new Response('unknown user', { status: 200 });
  if (!ev.item || ev.item.type !== 'message') return new Response('not a message', { status: 200 });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // 그 메시지가 점검 카드인지 slack_ts 로 확인 (아무 메시지에나 달아도 무시)
  const { data: rows } = await supabase
    .from('block_release_approval')
    .select('id, holiday_id, detailer_name, block_day, block_window, decision')
    .eq('slack_ts', ev.item.ts)
    .is('applied_at', null);

  if (!rows || !rows.length) return new Response('not an approval target', { status: 200 });

  const r = rows[0];
  const release = ev.reaction === APPROVE_TRIGGER;
  const now = new Date().toISOString();

  // 👌 뒤에 ✅ 가 달리면 ✅ 가 이긴다. 반대로 이미 해제 결정된 건을 👌 로 되돌리지는 않는다.
  if (!release && r.decision === 'released') {
    return new Response('already released', { status: 200 });
  }

  const patch: Record<string, unknown> = release
    ? { decision: 'released', decided_by: who.person, decided_at: now,
        approved_by: who.person, approved_at: now }
    : { decision: 'kept', decided_by: who.person, decided_at: now,
        recheck_at: recheckDate(r.block_day) };

  await supabase.from('block_release_approval').update(patch)
    .in('id', rows.map((x: any) => x.id));

  const token = Deno.env.get('SLACK_TOKEN');
  if (token) {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: ev.item.channel,
        thread_ts: ev.item.ts,
        text: release
          ? `승인 접수: ${r.detailer_name} ${r.block_day} ${r.block_window} 차단 해제\n`
            + `• 승인자 ${who.person}\n`
            + `• 다음 점검에서 조건을 다시 확인한 뒤 해제하고, 결과를 이 스레드에 남깁니다`
          : `정상 확인: ${r.detailer_name} ${r.block_day} ${r.block_window} 차단 유지\n`
            + `• 확인자 ${who.person}\n`
            + `• 차단일 D-${RECHECK_LEAD_DAYS}(${recheckDate(r.block_day)})에 한 번만 다시 확인 요청드립니다`,
      }),
    });
  }
  return new Response(release ? 'approved' : 'kept', { status: 200 });
}

/** 차단일 D-3. 정상 확인이 영구 면제가 되지 않게 재확인 시점을 박아둔다. */
function recheckDate(blockDay: string): string {
  const d = new Date(`${blockDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - RECHECK_LEAD_DAYS);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 핸들러

serve(async (req) => {
  const raw = await req.text();

  if (!(await verifySlack(req, raw))) return new Response('bad signature', { status: 401 });

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 200 }); }

  // Slack 이벤트 URL 등록 검증
  if (body.type === 'url_verification') {
    return new Response(body.challenge, { headers: { 'Content-Type': 'text/plain' } });
  }

  if (body.type !== 'event_callback') return new Response('ok', { status: 200 });

  const ev = body.event || {};
  if (ev.type !== 'reaction_added') return new Response('ignored', { status: 200 });

  // ✅ 는 차단 해제 승인 경로로 빠진다 (📌 경로는 아래로 그대로 흐른다)
  if (ev.reaction === APPROVE_TRIGGER || ev.reaction === KEEP_TRIGGER) return await handleReleaseApproval(ev);

  if (ev.reaction !== TRIGGER) return new Response('ignored', { status: 200 });
  if (!ev.item || ev.item.type !== 'message') return new Response('not a message', { status: 200 });

  const who = USERS[ev.user];
  if (!who) return new Response('unknown user', { status: 200 }); // 등록되지 않은 사람의 반응은 무시
  const { person, team } = who;
  const cfg = TEAM_CONFIG[team];

  const token = Deno.env.get('SLACK_TOKEN');
  if (!token) return new Response('no slack token', { status: 200 });

  const channel = ev.item.channel;
  const ts = ev.item.ts; // 📌가 달린 바로 그 메시지(댓글이면 그 댓글)의 ts

  // 📌 반응이 달린 "그 메시지 한 건"만 캡처한다. (댓글 하나 = 일감 하나)
  let target: any = null;   // 반응 대상 메시지
  let rootMsg: any = null;  // 스레드 상단(부모) 메시지 — 댓글일 때 맥락용
  const rep = await slackGet(token, 'conversations.replies', { channel, ts, limit: '50' });
  if (rep.ok && rep.messages && rep.messages.length) {
    target = rep.messages.find((m: any) => m.ts === ts) || null;
    rootMsg = rep.messages[0];
  }
  if (!target) {
    // 폴백: 채널 히스토리에서 단건 (top-level 메시지)
    const hist = await slackGet(token, 'conversations.history', { channel, latest: ts, inclusive: 'true', limit: '1' });
    if (hist.messages && hist.messages[0]) { target = hist.messages[0]; rootMsg = target; }
  }
  if (!target) return new Response('no messages', { status: 200 });

  const isReply = !!(target.thread_ts && target.thread_ts !== target.ts);
  const threadTs = target.thread_ts || target.ts; // 확인 답글이 들어갈 스레드

  // permalink (원본 링크 겸 중복 방지 키) — 반응한 그 메시지(ts) 기준
  const permRes = await slackGet(token, 'chat.getPermalink', { channel, message_ts: ts });
  const permalink = permRes.ok ? permRes.permalink : '';

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // 같은 메시지가 이미 캡처됐으면 skip (더블 📌 방지)
  if (permalink) {
    const { data: dup } = await supabase
      .from(cfg.table).select('id').ilike('description', `%${permalink}%`).limit(1);
    if (dup && dup.length) return new Response('dup', { status: 200 });
  }

  // 원문 = 반응한 그 메시지만. 댓글이면 어느 스레드인지 알 수 있게 상단(부모) 메시지를 짧게만 덧붙인다.
  const targetText = (target.text || '').trim();
  let bodyText = targetText;
  if (isReply && rootMsg && rootMsg.ts !== target.ts) {
    const rootText = (rootMsg.text || '').replace(/\s+/g, ' ').trim();
    if (rootText) {
      const ctx = rootText.length > 300 ? rootText.slice(0, 300) + '…' : rootText;
      bodyText = `${targetText}\n\n─ (이 댓글이 달린 스레드 상단 메시지)\n${ctx}`;
    }
  }

  const today = kstToday();
  const tidy = await tidyWithClaude(person, cfg.label, today, bodyText);

  // 정리 성공 여부에 따라 저장 형태가 갈린다
  let title: string;
  let priority = '';
  let dueDate: string | null = null;
  let description: string;

  if (tidy) {
    title = tidy.task.length > 60 ? tidy.task.slice(0, 60) + '…' : tidy.task;
    priority = tidy.priority === 'NONE' ? '' : tidy.priority;
    dueDate = tidy.due_date && /^\d{4}-\d{2}-\d{2}$/.test(tidy.due_date) ? tidy.due_date : null;
    const parts = [`[슬랙 캡처]`, permalink, ''];
    if (tidy.summary) parts.push(tidy.summary, '');
    if (tidy.done_when) parts.push(`완료 조건: ${tidy.done_when}`, '');
    parts.push('--- 원문 ---', bodyText);
    description = parts.join('\n');
  } else {
    const firstLine = targetText.replace(/\s+/g, ' ').trim();
    title = (firstLine.length > 50 ? firstLine.slice(0, 50) + '…' : firstLine) || '(제목 없음)';
    description = `[슬랙 캡처 · 미정리]\n${permalink}\n\n--- 원문 ---\n${bodyText}`;
  }

  const { error } = await supabase.from(cfg.table).insert({
    person, task: title, priority, start_date: today, due_date: dueDate,
    created_at: today, description,
  });
  if (error) { console.error('insert error', error); return new Response('insert error', { status: 200 }); }

  // 캡처 확인 답글을 원본 스레드에 남긴다 — 정리 결과를 바로 보여줘서 틀렸으면 고칠 수 있게
  const lines = [`일감으로 담았어요 — ${person} (${cfg.label})`, `• ${title}`];
  if (tidy) {
    lines.push(`• 우선순위 ${PRIORITY_LABEL[priority]}${dueDate ? ` · 마감 ${dueDate}` : ''}`);
    if (tidy.done_when) lines.push(`• 완료 조건 ${tidy.done_when}`);
  } else {
    lines.push('• 미분류로 담았어요 (자동 정리를 못 했습니다)');
  }
  lines.push(`<${cfg.dashboard}|대시보드에서 확인>`);

  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, thread_ts: threadTs, text: lines.join('\n') }),
  });

  return new Response(JSON.stringify({ ok: true, person, team, title, tidied: !!tidy }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
