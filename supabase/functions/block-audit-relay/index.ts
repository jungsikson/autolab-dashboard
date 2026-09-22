// Supabase Edge Function: 근무 밖 예약 차단 해제 — 슬랙 중계
//
// 왜 중계가 필요한가: 실제 삭제 대상은 카라멜 MySQL 인데 원격(Edge)에서는 못 닿고,
// 슬랙 봇 토큰은 Supabase secrets 에만 있어 로컬에 두고 싶지 않다.
// 그래서 로컬 잡이 "무엇을 지울지" 계산해 여기로 보내고, 슬랙 발송과 승인 기록은 여기가 맡는다.
//
//   로컬(block-audit.py) --post--> 여기 --> 슬랙 후보 메시지 + block_release_approval UPSERT
//   사람이 ✅/👌 --> slack-capture 함수가 decision 기록
//   로컬(block-audit.py apply) --> 승인분 재검증 후 MySQL DELETE --> 여기로 confirm --> 스레드 답글
//
// 인증: x-audit-secret 헤더 (AUDIT_SHARED_SECRET). 없으면 거부한다.
//
// 🔴 무반응은 '정상'이 아니라 '미확인'이다 (사용자 결정 2026-09-22).
// 예전엔 "한 번 올린 건은 다시 안 올린다"였고, 그래서 김대진 10/8 후보가 9/18에 묻힌 뒤
// 9/19·9/20 점검이 '해제 후보 0건'으로 보고했다 — 그 0은 "새로 올릴 게 0"이었는데
// "미결 0"으로 읽혔다. 이승제 9/21 건은 아무 반응 없이 날짜가 지나 무의미해졌다.
// 그래서 재게시 기준을 **"게시했나"에서 "반응이 달렸나"로** 바꾼다.
//   decision NULL(무반응) --> 매일 다시 올린다 (미확인 N일차)
//   decision 'released'   --> 끝
//   decision 'kept'       --> 안 올린다. 단 차단일 D-3(recheck_at)에 한 번만 다시 묻는다
// 정본 설계: caramel-claude/BLOCK_AUDIT_확인체계.md

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface Candidate {
  holiday_id: number;
  detailer_id: number;
  detailer_name: string;
  block_day: string;    // YYYY-MM-DD
  block_window: string; // "16:00-23:59"
  late_booker: boolean;
  reason?: string;
}

// '차단 필요' 항목 — 지울 차단이 없어 holiday_id 가 없다. block_gap_ack 에 따로 기록한다.
interface Gap {
  detailer_id: number;
  detailer_name: string;
  gap_day: string;     // YYYY-MM-DD
  slots: string;       // "20:00" / "08:00, 21:00"
  work_window: string; // "10:00-19:00"
}

function sb() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

async function slackPost(token: string, payload: Record<string, unknown>) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await r.json();
}

serve(async (req) => {
  const secret = Deno.env.get('AUDIT_SHARED_SECRET');
  if (!secret || req.headers.get('x-audit-secret') !== secret) {
    return new Response('unauthorized', { status: 401 });
  }

  const token = Deno.env.get('SLACK_TOKEN');
  if (!token) return new Response('no slack token', { status: 500 });

  let body: any;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const supabase = sb();
  const channel: string = body.channel;

  // ── post: 후보를 슬랙에 올리고 승인 대기로 기록 ──────────────────
  if (body.action === 'post') {
    const candidates: Candidate[] = body.candidates || [];

    // 재게시 판단은 '반응이 달렸나'로 한다 (파일 상단 주석 참고).
    const ids = candidates.map((c) => c.holiday_id);
    const { data: existing } = ids.length
      ? await supabase.from('block_release_approval')
          .select('holiday_id, decision, decided_by, decided_at, recheck_at, posted_at, post_count')
          .in('holiday_id', ids)
      : { data: [] as any[] };
    const prev = new Map<number, any>((existing || []).map((r: any) => [r.holiday_id, r]));
    const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

    const fresh = candidates.filter((c) => {
      const p = prev.get(c.holiday_id);
      if (!p) return true;                          // 처음 보는 건
      if (p.decision === 'released') return false;  // 해제 결정됨 — 끝
      if (p.decision === 'kept') {                  // 정상 확인됨 — D-3에만 다시
        return !!p.recheck_at && p.recheck_at <= todayKst;
      }
      return true;                                  // 무반응 = 미확인 → 다시 올린다
    });

    // 차단 필요 건도 같은 규칙으로 — 반응이 달릴 때까지 매일 다시 묻는다
    const gaps: Gap[] = body.gaps || [];
    const { data: gapRows } = gaps.length
      ? await supabase.from('block_gap_ack')
          .select('id, detailer_id, gap_day, decision, recheck_at, posted_at, post_count, decided_by, decided_at')
          .in('detailer_id', gaps.map((g) => g.detailer_id))
      : { data: [] as any[] };
    const gapKey = (detailerId: number, day: string) => `${detailerId}|${day}`;
    const prevGap = new Map<string, any>(
      (gapRows || []).map((r: any) => [gapKey(r.detailer_id, r.gap_day), r]),
    );
    const freshGaps = gaps.filter((g) => {
      const p = prevGap.get(gapKey(g.detailer_id, g.gap_day));
      if (!p) return true;
      if (p.decision === 'kept') return !!p.recheck_at && p.recheck_at <= todayKst;
      return true;
    });

    if (!fresh.length && !freshGaps.length && !body.need_block_text) {
      return new Response(JSON.stringify({ posted: 0, note: 'nothing to ask' }), { status: 200 });
    }

    // 미확인 며칠째인지. posted_at 은 '처음 올린 시각'이라 재게시해도 안 건드린다.
    // 🔴 경과 시간(/86400000)이 아니라 KST 날짜 차이로 센다 — 9/18 저녁에 올라온 건이
    // 9/22 낮에는 아직 4일이 안 지나 '4일차'로 하루 적게 나왔다. 사람이 읽는 숫자는 달력 기준.
    const kstDay = (ms: number) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const unheldDays = (p: any) =>
      p?.posted_at
        ? (Date.parse(kstDay(Date.now())) - Date.parse(kstDay(new Date(p.posted_at).getTime())))
            / 86400000 + 1
        : 1;

    const seen = [
      ...fresh.map((c) => prev.get(c.holiday_id)),
      ...freshGaps.map((g) => prevGap.get(gapKey(g.detailer_id, g.gap_day))),
    ];
    const total = seen.length;
    const brandNew = seen.filter((p) => !p).length;
    const unchecked = seen.filter((p) => p && !p.decision).length;
    const rechecks = total - brandNew - unchecked;

    const header = body.title || '근무 밖 예약 차단 점검';
    // 멘션은 로컬 .env(AUDIT_MENTIONS)에서 온다 — 사람이 바뀌어도 함수 재배포 없이 바꾸도록
    const mentions = (body.mentions || '').trim();
    const breakdown = [
      `새로 ${brandNew}`,
      unchecked ? `미확인 ${unchecked}` : null,
      rechecks ? `재확인 ${rechecks}` : null,
    ].filter(Boolean).join(' · ');
    const parent = await slackPost(token, {
      channel,
      text: (mentions ? `${mentions}\n` : '')
        + `${header}\n\n확인 필요: ${total}건 (${breakdown})\n`
        + `무반응은 '정상'이 아니라 '미확인'입니다 — 반응 전까지 계속 올라옵니다`
        + (body.summary ? `\n${body.summary}` : ''),
    });
    if (!parent.ok) {
      return new Response(JSON.stringify({ error: 'slack post failed', detail: parent.error }), { status: 502 });
    }
    const threadTs = parent.ts;

    let posted = 0;
    for (const c of fresh) {
      const p = prev.get(c.holiday_id);
      const warn = c.late_booker
        ? '\n• 주의: 후행 생성형 — 예약이 뒤늦게 붙는 사람입니다. 그대로 두는 쪽이 안전할 수 있습니다'
        : '';
      // 되묻는 이유를 카드에 적는다 — 왜 또 왔는지 모르면 또 무반응이 된다
      let again = '';
      if (p?.decision === 'kept') {
        again = `\n• ${(p.decided_at || '').slice(0, 10) || '이전'}에 정상 확인(${p.decided_by || '확인자'})`
          + ` · 차단일 D-3 — 여전히 정상인가요?`;
      } else if (p) {
        again = `\n• 미확인 ${unheldDays(p)}일차 — ${String(p.posted_at).slice(0, 10)}에 처음 올라온 건입니다`;
      }
      const reply = await slackPost(token, {
        channel,
        thread_ts: threadTs,
        text: `${c.detailer_name} ${c.block_day} ${c.block_window} 차단\n`
          + `• 그날 근무창 밖 예약이 없어 차단 근거가 사라졌습니다${warn}\n`
          + `• ✅ 슬롯 열기  /  👌 정상 (그대로 둔다)${again}`,
      });
      if (!reply.ok) continue;

      // holiday_id 유니크 — 카드를 다시 올려도 행은 하나로 합친다.
      // posted_at(처음 올린 시각)은 payload에 넣지 않아 보존된다.
      const row: Record<string, unknown> = {
        holiday_id: c.holiday_id,
        detailer_id: c.detailer_id,
        detailer_name: c.detailer_name,
        block_day: c.block_day,
        block_window: c.block_window,
        late_booker: c.late_booker,
        slack_channel: channel,
        slack_ts: reply.ts,          // 반응은 항상 '최신 카드'에서 받는다
        last_posted_at: new Date().toISOString(),
        post_count: (p?.post_count ?? 0) + 1,
      };
      // D-3 재확인은 새 질문이다 — 이전 '정상 확인'을 지우고 다시 받는다
      if (p?.decision === 'kept') {
        Object.assign(row, { decision: null, decided_by: null, decided_at: null, recheck_at: null });
      }
      const { error } = await supabase.from('block_release_approval')
        .upsert(row, { onConflict: 'holiday_id' });
      if (!error) posted++;
    }

    // 차단 필요 건도 각각 카드로 — 묶어서 한 덩이로 올리면 개별 확인이 안 된다
    let gapsPosted = 0;
    for (const g of freshGaps) {
      const p = prevGap.get(gapKey(g.detailer_id, g.gap_day));
      let again = '';
      if (p?.decision === 'kept') {
        again = `\n• ${(p.decided_at || '').slice(0, 10) || '이전'}에 정상 확인(${p.decided_by || '확인자'})`
          + ` · 예약일 D-3 — 여전히 차단이 필요 없나요?`;
      } else if (p) {
        again = `\n• 미확인 ${unheldDays(p)}일차 — ${String(p.posted_at).slice(0, 10)}에 처음 올라온 건입니다`;
      }
      const reply = await slackPost(token, {
        channel,
        thread_ts: threadTs,
        text: `${g.detailer_name} ${g.gap_day} ${g.slots} 예약 (근무창 ${g.work_window})\n`
          + `• 근무창 밖 예약인데 보상 차단이 없습니다 — 그날 근무가 길어집니다\n`
          + `• 👌 정상 (차단 불필요)  /  차단이 필요하면 직접 등록해주세요${again}`,
      });
      if (!reply.ok) continue;

      const row: Record<string, unknown> = {
        detailer_id: g.detailer_id,
        detailer_name: g.detailer_name,
        gap_day: g.gap_day,
        slots: g.slots,
        work_window: g.work_window,
        slack_channel: channel,
        slack_ts: reply.ts,
        last_posted_at: new Date().toISOString(),
        post_count: (p?.post_count ?? 0) + 1,
      };
      if (p?.decision === 'kept') {
        Object.assign(row, { decision: null, decided_by: null, decided_at: null, recheck_at: null });
      }
      const { error } = await supabase.from('block_gap_ack')
        .upsert(row, { onConflict: 'detailer_id,gap_day' });
      if (!error) gapsPosted++;
    }

    // gaps 를 안 보내는 예전 호출과의 호환 — 텍스트 한 덩이로라도 알린다
    if (!gaps.length && body.need_block_text) {
      await slackPost(token, { channel, thread_ts: threadTs, text: body.need_block_text });
    }

    return new Response(JSON.stringify({ posted, gaps: gapsPosted, thread_ts: threadTs }), { status: 200 });
  }

  // ── pending: 승인됐지만 아직 반영 안 된 건 (로컬 잡이 가져간다) ────
  // 로컬에 Supabase 키를 두지 않기 위해 조회도 여기를 거친다.
  if (body.action === 'pending') {
    const { data, error } = await supabase
      .from('block_release_approval')
      .select('holiday_id, detailer_id, detailer_name, block_day, block_window, decided_by, decided_at')
      .eq('decision', 'released')
      .is('applied_at', null)
      .order('decided_at', { ascending: true });
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    return new Response(JSON.stringify({ pending: data || [] }), { status: 200 });
  }

  // ── confirm: 실제 해제 결과를 원래 스레드에 남긴다 ────────────────
  if (body.action === 'confirm') {
    const results = body.results || [];
    for (const r of results) {
      const { data: rows } = await supabase
        .from('block_release_approval')
        .select('id, slack_channel, slack_ts, detailer_name, block_day, block_window')
        .eq('holiday_id', r.holiday_id)
        .limit(1);
      const row = rows && rows[0];
      if (!row) continue;

      await supabase.from('block_release_approval')
        .update({ applied_at: new Date().toISOString(), apply_result: r.ok ? 'released' : `failed: ${r.message}` })
        .eq('id', row.id);

      await slackPost(token, {
        channel: row.slack_channel,
        thread_ts: row.slack_ts,
        text: r.ok
          ? `해제 완료: ${row.detailer_name} ${row.block_day} ${row.block_window}\n• 그 시간대 슬롯이 고객에게 다시 열렸습니다`
          : `해제 못 함: ${row.detailer_name} ${row.block_day} ${row.block_window}\n• ${r.message}`,
      });
    }
    return new Response(JSON.stringify({ confirmed: results.length }), { status: 200 });
  }

  return new Response('unknown action', { status: 400 });
});
