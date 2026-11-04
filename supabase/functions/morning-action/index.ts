// Supabase Edge Function: 정할 것(morning_item) 처리의 단일 경로 (강희준 2026-11-04)
// 정본은 morning_item 한 표. 슬랙 DM 카드(slack-capture 가 넘김)와 대시보드 탭(브라우저)이 모두 여기를 부른다.
//   { id, action, label, by, via }  action = add | merge | done | read | later | mute | undo
//   { id, action: 'post', thread_ts }  → 그 줄을 DM 카드로 보내고 위치(slack_channel/ts)를 남긴다
// 결과: morning_item 판정 + 할 일 표 반영 + (DM 카드가 있으면) 카드를 같은 상태로 다시 그림.
// 권한 (2026-11-04): 부른 쪽이 자기 열쇠로 그 줄을 읽을 수 있어야 처리한다 — 로그인한 회사 계정(RLS)·서버 키는 읽히고,
//   공개 키만 든 요청은 0건이라 막힌다. 로그인 계정으로 부르면 처리한 사람 이름은 요청값(by)이 아니라 계정에서 정한다.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const DM_CHANNEL: Record<string, string> = { '강희준': 'U06PSEETK54' };

function kstToday(): string {
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
}
const EMAIL_PERSON: Record<string, string> = { 'june@thetrive.com': '강희준' };

// 부른 쪽 열쇠로 그 줄이 읽히는지 본다. 읽히면 { ok, email }(로그인 계정이면 email, 서버 키면 null)
async function caller(req: Request, id: unknown): Promise<{ ok: boolean; email: string | null }> {
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.replace(/^Bearer\s+/i, '');
  const apikey = req.headers.get('apikey') || bearer;
  if (!apikey || id == null) return { ok: false, email: null };
  const h: Record<string, string> = { apikey };
  if (bearer) h.authorization = `Bearer ${bearer}`;
  const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/morning_item?id=eq.${encodeURIComponent(String(id))}&select=id`, { headers: h });
  if (!r.ok) return { ok: false, email: null };
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length !== 1) return { ok: false, email: null };
  let email: string | null = null;
  if (bearer.startsWith('eyJ')) {
    const u = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, { headers: { apikey, authorization: `Bearer ${bearer}` } });
    if (u.ok) email = (await u.json()).email || null;
  }
  return { ok: true, email };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// 항목 하나가 할 일에 남기는 표식. 되돌리기는 이 표식이 있는 것만 지운다
function mark(row: any) { return `(정할 것 #${row.id})`; }
function chunk(row: any) {
  const who = [row.who, row.when_label].filter(Boolean).join(' · ');
  return `\n\n[정할 것 ${row.edition_date}] ${row.hl}\n${who}${row.quote ? ` · "${row.quote}"` : ''}${row.link ? `\n${row.link}` : ''}${row.memo ? `\n메모: ${row.memo}` : ''}\n${mark(row)}`;
}
// 정한 뒤 붙이는 메모 한 단락(되돌리기 대상 아님)
function memoChunk(row: any, memo: string, today: string) {
  return `\n\n[메모 ${today}] ${memo}\n${mark(row)}`;
}

function suggestion(row: any) {
  if (row.kind === 'merge') return `#${row.task_id}에 덧붙이기`;
  if (row.kind === 'new') return '할 일에 넣기';
  if (row.kind === 'done') return '이미 끝남';
  if (row.kind === 'read') return '읽음';
  return '내일 다시';
}
function buttons(row: any): [string, string][] {
  if (row.kind === 'progress') return [['later', '내일 다시'], ['done', '완료'], ['mute', '그만 알림']];
  const a: [string, string][] = [];
  if (row.kind === 'merge') a.push(['merge', `#${row.task_id}에 덧붙이기`], ['add', '다른 일 · 새로 넣기']);
  // 연결된 할 일 자체가 끝났으면 그 할 일까지 완료로(11/4). '이미 끝남'은 이 항목만 닫는다
  if (row.task_id && (row.kind === 'merge' || row.kind === 'done')) a.push(['done_task', `#${row.task_id} 완료 처리`]);
  if (row.kind === 'new') a.push(['add', '할 일에 넣기']);
  if (row.kind === 'done') a.push(['done', '이미 끝남'], ['add', '할 일에 넣기']);
  if (row.kind === 'read') a.push(['read', '읽음'], ['add', '할 일에 넣기']);
  if (row.kind !== 'done') a.push(['done', '이미 끝남']);
  // 대시보드와 같은 버튼 — 폰에서 DM만으로 끝낼 수 있게(11/4 UX 검토)
  a.push(['later', '내일 다시'], ['mute', '그만 알림']);
  return a;
}

// DM 카드 = 할 일·근거·대조 + (남음이면 버튼 / 정함이면 결과 한 줄과 되돌리기)
function cardBlocks(row: any) {
  const who = [row.who, row.when_label].filter(Boolean).join(' · ');
  const match = row.kind === 'merge' ? `🟡 이미 있는 것 같음 → *#${row.task_id} ${row.task_title || ''}*`
    : row.kind === 'new' ? '대시보드에 없음'
    : row.kind === 'progress' ? `대시보드 #${row.task_id} 진척` : '';
  const text = `*${row.hl}*\n${who}${row.quote ? ` · "${row.quote}"` : ''}${row.body ? `\n${row.body}` : ''}${match ? `\n${match}` : ''}${row.memo ? `\n📝 ${row.memo}` : ''}`;
  const section = { type: 'section', text: { type: 'mrkdwn', text } };
  const btn = (t: string, k: string, primary = false) => ({
    type: 'button', text: { type: 'plain_text', text: t }, action_id: `todo_${k}`,
    value: JSON.stringify({ mid: row.id, k, label: t }), ...(primary ? { style: 'primary' } : {}),
  });
  if (row.decision) {
    const res = `✅ ${row.decision_label}${row.decided_task_id ? ` · #${row.decided_task_id}` : ''}${row.followup_task_id ? ` · 후속 #${row.followup_task_id}` : ''}${row.decided_by ? ` · ${row.decided_by}` : ''}${row.decided_via === 'dashboard' ? ' (대시보드)' : ''}`;
    return [section, { type: 'context', elements: [{ type: 'mrkdwn', text: res }] }, { type: 'actions', elements: [btn('되돌리기', 'undo')] }];
  }
  const sug = suggestion(row);
  return [section, { type: 'actions', elements: buttons(row).map(([k, t]) => btn(t, k, t === sug)) }];
}

async function slack(method: string, body: unknown) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${Deno.env.get('SLACK_TOKEN')}` },
    body: JSON.stringify(body),
  });
  return await r.json();
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  let p: any;
  try { p = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const who = await caller(req, p.id);
  if (!who.ok) return json({ ok: false, error: 'unauthorized' }, 401);
  if (who.email) { p.by = EMAIL_PERSON[who.email] || who.email.split('@')[0]; p.via = p.via || 'dashboard'; }
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: row, error } = await sb.from('morning_item').select('*').eq('id', p.id).single();
  if (error || !row) return json({ ok: false, error: 'no item' }, 404);

  if (p.action === 'post') {
    const channel = DM_CHANNEL[row.person];
    if (!channel) return json({ ok: false, error: 'no dm channel' }, 400);
    const r = await slack('chat.postMessage', { channel, thread_ts: p.thread_ts, text: row.hl, blocks: cardBlocks(row), unfurl_links: false });
    if (!r.ok) return json({ ok: false, error: r.error }, 502);
    await sb.from('morning_item').update({ slack_channel: r.channel, slack_ts: r.ts }).eq('id', row.id);
    return json({ ok: true, slack_ts: r.ts });
  }

  const today = kstToday();
  const upd: Record<string, unknown> = {};
  const memo = typeof p.memo === 'string' ? p.memo.trim() : '';
  const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const due = isDate(p.due) ? p.due : null;
  const prio = ['DO', 'DELEGATE', 'SCHEDULE', 'ELIMINATE'].includes(p.priority) ? p.priority : '';
  // 후속 할 일: 이 항목을 정하면서 생긴 다음 일(예: "이수민 블랙박스 결과 확인")을 별도 할 일로 만든다
  const fu = p.followup && typeof p.followup.task === 'string' && p.followup.task.trim()
    ? { task: p.followup.task.trim().slice(0, 80), due: isDate(p.followup.due) ? p.followup.due : null } : null;
  const fuMark = `(정할 것 #${row.id} 후속)`;
  // 후속 할 일의 상위 = 이 항목으로 생긴 할 일, 없으면 덧붙인 대상 할 일(일정 뷰에서 그 밑에 보인다)
  async function makeFollowup(parentId: number | null = null): Promise<number | null> {
    if (!fu) return null;
    const { data, error: e } = await sb.from('autolab_task').insert({
      person: row.person, task: fu.task, priority: prio, start_date: today, due_date: fu.due, created_at: today,
      parent_id: parentId ?? row.decided_task_id ?? row.task_id ?? null,
      description: `[후속 · 정할 것 ${row.edition_date}] ${row.hl}${row.link ? `\n${row.link}` : ''}${memo ? `\n\n메모: ${memo}` : ''}\n${fuMark}`,
    }).select('id').single();
    if (e) throw new Error(`후속 할 일 실패: ${e.message}`);
    return data.id;
  }

  // 이미 정한 항목에 메모만 더한다 — 연결된 할 일이 있으면 그 설명 끝에도 붙인다
  if (p.action === 'memo') {
    if (!memo && !fu) return json({ ok: false, error: 'empty memo' }, 400);
    if (!memo) {
      const fid = await makeFollowup();
      const { data: saved } = await sb.from('morning_item').update({ followup_task_id: fid }).eq('id', row.id).select('*').single();
      return json({ ok: true, row: saved });
    }
    const tid = row.decided_task_id || row.task_id;
    if (row.decision && tid && ['add', 'merge', 'done'].includes(row.decision)) {
      const { data: t } = await sb.from('autolab_task').select('description').eq('id', tid).single();
      // 마감은 이 항목으로 새로 만든 할 일일 때만 바꾼다
      if (t) await sb.from('autolab_task').update({ description: (t.description || '') + memoChunk(row, memo, today), ...(due && row.decision === 'add' ? { due_date: due } : {}) }).eq('id', tid);
    }
    const fid = fu ? await makeFollowup() : null;
    const { data: saved } = await sb.from('morning_item').update({ memo: row.memo ? `${row.memo}\n${memo}` : memo, ...(fid ? { followup_task_id: fid } : {}) }).eq('id', row.id).select('*').single();
    return json({ ok: true, row: saved });
  }

  if (p.action === 'undo') {
    if (!row.decision) return json({ ok: true, row });
    if (row.decision === 'add' && row.decided_task_id) {
      await sb.from('autolab_task').delete().eq('id', row.decided_task_id).ilike('description', `%${mark(row)}%`);
    } else if (['merge', 'done_task'].includes(row.decision) && (row.decided_task_id || row.task_id)) {
      const mergedId = row.decided_task_id || row.task_id;
      // 덧붙인 단락은 "[정할 것 날짜] 제목"부터 표식까지. 나중에 붙인 메모 단락(같은 표식)도 함께 걷어 낸다
      const { data: t } = await sb.from('autolab_task').select('description').eq('id', mergedId).single();
      let d: string = t?.description || '';
      const head = `\n\n[정할 것 ${row.edition_date}] ${row.hl}`;
      const s = d.indexOf(head);
      if (s >= 0) {
        const lastMark = d.lastIndexOf(mark(row));
        if (lastMark > s) d = d.slice(0, s) + d.slice(lastMark + mark(row).length);
        await sb.from('autolab_task').update({ description: d }).eq('id', mergedId);
      }
      if (row.decision === 'done_task') await sb.from('autolab_check').upsert({ type: 'autolab', item_key: String(mergedId), checked: false, completed_date: '' }, { onConflict: 'item_key' });
    } else if (row.decision === 'done' && row.kind === 'progress' && row.task_id) {
      await sb.from('autolab_check').upsert({ type: 'autolab', item_key: String(row.task_id), checked: false, completed_date: '' }, { onConflict: 'item_key' });
    }
    if (row.followup_task_id) {
      await sb.from('autolab_task').delete().eq('id', row.followup_task_id).ilike('description', `%${fuMark}%`);
    }
    Object.assign(upd, { decision: null, decision_label: null, decided_task_id: null, decided_at: null, decided_by: null, decided_via: null, memo: null, followup_task_id: null });
  } else {
    // 다른 창에서 먼저 정했으면 덮어쓰지 않는다
    if (row.decision) {
      if (row.slack_channel && row.slack_ts) await slack('chat.update', { channel: row.slack_channel, ts: row.slack_ts, text: row.hl, blocks: cardBlocks(row) });
      return json({ ok: false, already: true, row });
    }
    if (memo) { row.memo = memo; upd.memo = memo; }
    if (p.action === 'add') {
      const { data, error: e } = await sb.from('autolab_task').insert({
        person: row.person, task: row.hl.length > 60 ? row.hl.slice(0, 60) + '…' : row.hl, priority: prio,
        start_date: today, due_date: due, created_at: today,
        description: `[정할 것 ${row.edition_date} · ${row.source}]${row.link ? `\n${row.link}` : ''}\n\n${[row.who, row.when_label].filter(Boolean).join(' · ')}\n${row.quote ? `"${row.quote}"` : (row.body || '')}${memo ? `\n\n메모: ${memo}` : ''}\n${mark(row)}`,
      }).select('id').single();
      if (e) return json({ ok: false, error: e.message }, 500);
      upd.decided_task_id = data.id;
    } else if (p.action === 'merge') {
      // 사람이 검색창에서 다른 할 일을 고르면 그 번호로 덧붙인다(봇 제안이 틀렸을 때)
      const target = p.task_id ? Number(p.task_id) : row.task_id;
      if (!target) return json({ ok: false, error: '덧붙일 할 일을 고르세요' }, 400);
      const { data: t, error: e } = await sb.from('autolab_task').select('description').eq('id', target).single();
      if (e || !t) return json({ ok: false, error: `#${target} 없음` }, 404);
      const c = chunk(row);
      // 덧붙이기는 기존 할 일의 마감을 바꾸지 않는다(큰 묶음 할 일의 마감이 덮이는 걸 막음, 11/4)
      if (!(t.description || '').includes(c)) await sb.from('autolab_task').update({ description: (t.description || '') + c }).eq('id', target);
      upd.decided_task_id = target;
    } else if (p.action === 'done_task') {
      // 연결된 할 일을 완료로. 하위가 남은 큰 주제는 완료하지 않는다(하위부터)
      const target = p.task_id ? Number(p.task_id) : row.task_id;
      if (!target) return json({ ok: false, error: '완료할 할 일이 없습니다' }, 400);
      const { data: t, error: e } = await sb.from('autolab_task').select('description').eq('id', target).single();
      if (e || !t) return json({ ok: false, error: `#${target} 없음` }, 404);
      const { data: kids } = await sb.from('autolab_task').select('id').eq('parent_id', target);
      if (kids && kids.length) {
        const { data: chk } = await sb.from('autolab_check').select('item_key').eq('type', 'autolab').eq('checked', true).in('item_key', kids.map((k: any) => String(k.id)));
        const left = kids.length - (chk || []).length;
        if (left > 0) {
          const msg = `#${target}은 하위 ${left}개가 남은 큰 주제라 완료하지 않았습니다. 하위를 먼저 끝내세요`;
          // 슬랙에서 눌렀으면 카드 밑에 이유를 남긴다(버튼만 눌리고 아무 일 없어 보이지 않게)
          if (p.via === 'slack' && row.slack_channel && row.slack_ts) await slack('chat.postMessage', { channel: row.slack_channel, thread_ts: row.slack_ts, text: msg });
          return json({ ok: false, error: msg }, 409);
        }
      }
      const c = chunk(row);
      if (!(t.description || '').includes(c)) await sb.from('autolab_task').update({ description: (t.description || '') + c }).eq('id', target);
      await sb.from('autolab_check').upsert({ type: 'autolab', item_key: String(target), checked: true, completed_date: today }, { onConflict: 'item_key' });
      upd.decided_task_id = target;
    } else if (p.action === 'done' && row.kind === 'progress' && row.task_id) {
      await sb.from('autolab_check').upsert({ type: 'autolab', item_key: String(row.task_id), checked: true, completed_date: today }, { onConflict: 'item_key' });
      upd.decided_task_id = row.task_id;
    } else if (!['done', 'read', 'later', 'mute'].includes(p.action)) {
      return json({ ok: false, error: 'unknown action' }, 400);
    }
    try { upd.followup_task_id = await makeFollowup((upd.decided_task_id as number | undefined) ?? row.task_id ?? null); } catch (e) { return json({ ok: false, error: String((e as Error).message) }, 500); }
    Object.assign(upd, { decision: p.action, decision_label: p.label || p.action, decided_at: new Date().toISOString(), decided_by: p.by || row.person, decided_via: p.via || null });
  }

  const { data: saved, error: e2 } = await sb.from('morning_item').update(upd).eq('id', row.id).select('*').single();
  if (e2) return json({ ok: false, error: e2.message }, 500);
  // DM 카드가 있으면 어느 창에서 눌렀든 같은 상태로 다시 그린다
  if (saved.slack_channel && saved.slack_ts) {
    await slack('chat.update', { channel: saved.slack_channel, ts: saved.slack_ts, text: saved.hl, blocks: cardBlocks(saved) });
  }
  return json({ ok: true, row: saved });
});
