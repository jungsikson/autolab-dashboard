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
  if (ev.type !== 'reaction_added' || ev.reaction !== TRIGGER) return new Response('ignored', { status: 200 });
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
