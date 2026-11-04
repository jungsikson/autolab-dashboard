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

// ---------------------------------------------------------------- 통화 할 일 카드 버튼
// 카드 = section(할 일·근거·대조) + actions. 버튼 value 에 항목 전체를 실어 보내므로 DB 에 따로 상태를 두지 않는다.
// add   → autolab_task 새 행, merge → 기존 할 일 description 끝에 근거 한 단락, done → 기록 없이 카드만
// undo  → add 는 그 행 삭제, merge 는 덧붙인 단락 제거. 되돌리면 원래 버튼으로 돌아간다

type TodoItem = { todo: string; src: string; quote: string; kind: 'merge' | 'add'; task?: number; title?: string };

function todoButtons(it: TodoItem) {
  const b = (text: string, k: string, primary = false) => ({
    type: 'button', text: { type: 'plain_text', text }, action_id: `todo_${k}`,
    value: JSON.stringify({ k, it }), ...(primary ? { style: 'primary' } : {}),
  });
  return it.kind === 'merge'
    ? [b(`#${it.task}에 덧붙이기`, 'merge', true), b('다른 일 · 새로 넣기', 'add'), b('이미 끝남', 'done')]
    : [b('할 일에 넣기', 'add', true), b('이미 끝남', 'done')];
}

function mergeChunk(it: TodoItem, permalink: string) {
  return `\n\n[통화 할 일] ${it.todo}\n${it.src} · "${it.quote}"\n${permalink}`;
}

async function handleTodoButton(p: any, act: any) {
  const who = USERS[p.user?.id];
  if (!who || who.team !== 'autolab') return;
  const token = Deno.env.get('SLACK_TOKEN')!;
  const channel = p.container?.channel_id || p.channel?.id;
  const ts = p.container?.message_ts || p.message?.ts;
  const section = p.message?.blocks?.[0];
  if (!channel || !ts || !section) return;
  const { k, it, id, op } = JSON.parse(act.value || '{}');
  if (!it) return;
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const permRes = await slackGet(token, 'chat.getPermalink', { channel, message_ts: ts });
  const permalink = permRes.ok ? permRes.permalink : '';
  const today = kstToday();

  let result = '';
  let undo: any = null;
  if (k === 'add') {
    // 같은 카드로 이미 넣은 행이 있으면 새로 만들지 않는다(두 번 누름·재시도)
    const { data: dup } = permalink
      ? await supabase.from('autolab_task').select('id').ilike('description', `%${permalink}%`).limit(1)
      : { data: null };
    let newId = dup?.[0]?.id;
    if (!newId) {
      const { data, error } = await supabase.from('autolab_task').insert({
        person: who.person, task: it.todo.length > 60 ? it.todo.slice(0, 60) + '…' : it.todo, priority: '',
        start_date: today, due_date: null, created_at: today,
        description: `[통화 할 일]\n${permalink}\n\n${it.src} · "${it.quote}"`,
      }).select('id').single();
      if (error) { result = `⚠️ 넣기 실패: ${error.message}`; } else newId = data.id;
    }
    if (newId) { result = `✅ 할 일에 넣음 · #${newId}`; undo = { k: 'undo', it, op: 'add', id: newId }; }
  } else if (k === 'merge') {
    const { data: row, error } = await supabase.from('autolab_task').select('id, description').eq('id', it.task).single();
    if (error || !row) { result = `⚠️ #${it.task}를 찾지 못함`; } else {
      const chunk = mergeChunk(it, permalink);
      const desc = row.description || '';
      if (!desc.includes(chunk)) {
        const { error: e2 } = await supabase.from('autolab_task').update({ description: desc + chunk }).eq('id', it.task);
        if (e2) result = `⚠️ 덧붙이기 실패: ${e2.message}`;
      }
      if (!result) { result = `✅ #${it.task}에 덧붙임`; undo = { k: 'undo', it, op: 'merge', id: it.task }; }
    }
  } else if (k === 'done') {
    result = '✅ 이미 끝남으로 표시';
    undo = { k: 'undo', it, op: 'done' };
  } else if (k === 'undo') {
    if (op === 'add' && id && permalink) {
      // 이 카드로 만든 행만 지운다(설명에 카드 링크가 있는지 확인)
      await supabase.from('autolab_task').delete().eq('id', id).ilike('description', `%${permalink}%`);
    } else if (op === 'merge' && id) {
      const { data: row } = await supabase.from('autolab_task').select('description').eq('id', id).single();
      const chunk = mergeChunk(it, permalink);
      if (row?.description?.includes(chunk)) {
        await supabase.from('autolab_task').update({ description: row.description.replace(chunk, '') }).eq('id', id);
      }
    }
  }

  const blocks = undo
    ? [section, { type: 'context', elements: [{ type: 'mrkdwn', text: `${result} · ${who.person}` }] },
       { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '되돌리기' }, action_id: 'todo_undo', value: JSON.stringify(undo) }] }]
    : result
      ? [section, { type: 'context', elements: [{ type: 'mrkdwn', text: result }] }, { type: 'actions', elements: todoButtons(it) }]
      : [section, { type: 'actions', elements: todoButtons(it) }];
  await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, ts, text: it.todo, blocks }),
  });
}

// ---------------------------------------------------------------- 핸들러

serve(async (req) => {
  const raw = await req.text();

  if (!(await verifySlack(req, raw))) return new Response('bad signature', { status: 401 });

  // 카드 버튼(Interactivity) — 폼 인코딩 payload=... 로 온다. 운영 데이터를 바꾸는 경로라
  // 서명 비밀값이 없으면 받지 않는다(이모지 경로와 달리 '초기 셋업용 스킵'을 허용하지 않는다)
  if (raw.startsWith('payload=')) {
    if (!Deno.env.get('SLACK_SIGNING_SECRET')) return new Response('signing secret not set', { status: 401 });
    let p: any;
    try { p = JSON.parse(new URLSearchParams(raw).get('payload') || ''); } catch { return new Response('bad payload', { status: 200 }); }
    const act = p?.actions?.[0];
    // 통화 할 일 DM 카드 버튼(todo_*) — 누르면 바로 대시보드에 반영하고 카드를 결과 한 줄로 바꾼다 (강희준 2026-11-04)
    if (p?.type === 'block_actions' && act && String(act.action_id).startsWith('todo_')) {
      // @ts-ignore EdgeRuntime 은 Supabase 런타임 전역
      EdgeRuntime.waitUntil(handleTodoButton(p, act).catch((e) => console.error('todo button failed', e)));
      return new Response('', { status: 200 });
    }
    if (p?.type !== 'block_actions' || !act || !['ops_ok', 'ops_not'].includes(act.action_id)) return new Response('', { status: 200 });
    // 처리(재검증·삭제·이관)는 3초를 넘길 수 있어 먼저 응답하고 뒤에서 돈다. 결과는 ops-audit 이 카드를 고쳐 쓴다
    const job = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/ops-audit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-audit-secret': Deno.env.get('AUDIT_SHARED_SECRET') || '' },
      body: JSON.stringify({ action: 'button', user: p.user?.id, choice: act.value,
        channel: p.container?.channel_id || p.channel?.id, ts: p.container?.message_ts || p.message?.ts }),
    }).catch((e) => console.error('ops-audit button forward failed', e));
    // @ts-ignore EdgeRuntime 은 Supabase 런타임 전역
    EdgeRuntime.waitUntil(job);
    return new Response('', { status: 200 });
  }

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 200 }); }

  // Slack 이벤트 URL 등록 검증
  if (body.type === 'url_verification') {
    return new Response(body.challenge, { headers: { 'Content-Type': 'text/plain' } });
  }

  if (body.type !== 'event_callback') return new Response('ok', { status: 200 });

  const ev = body.event || {};
  if (ev.type !== 'reaction_added') return new Response('ignored', { status: 200 });

  // 점검 카드의 ✅·👌·❌ 반응 처리는 없앴다 — 카드 버튼으로만 답한다 (강희준 2026-10-30).
  // 이제 반응으로 받는 건 📌 캡처 하나뿐이다.
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
