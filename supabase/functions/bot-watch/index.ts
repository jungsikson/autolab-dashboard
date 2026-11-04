// bot-watch — 에어 봇이 오늘 돌았는지 확인하고, 안 돈 봇이 있으면 희준님께 DM한다(11/4).
// 봇은 끝날 때 .tools/botrun.py로 bot_run에 한 줄 남긴다. 실패는 봇이 그 자리에서 DM하므로 여기선 "줄이 아예 없음"을 잡는다.
// 에어가 꺼지면 에어 위의 점검도 같이 꺼지니 점검은 클라우드에 둔다.
// 호출: pg_cron(bot-watch-am 10:00 KST, bot-watch-fri 금 16:30 KST) → x-audit-secret 확인. {dry:true}면 보내지 않고 본문만 돌려준다.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const DM = 'U06PSEETK54'; // 강희준
const SLOTS: Record<string, [string, string][]> = {
  am: [['calltodo', '07시 통화 할 일 봇'], ['dailylog', '08:30 하루 요약 봇'], ['worklog', '08:40 업무 시간 측정 봇'], ['slackcheck', '09시 슬랙 점검 봇']],
  fri: [['weeklyreview', '금요일 16시 주간 점검 봇']],
};

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  const secret = Deno.env.get('AUDIT_SHARED_SECRET') || '';
  if (!secret || req.headers.get('x-audit-secret') !== secret) return json({ ok: false, error: 'unauthorized' }, 401);
  const p = await req.json().catch(() => ({}));
  const slot = SLOTS[p.slot] ? p.slot : 'am';
  const today = p.date || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const bots = SLOTS[slot];
  const { data, error } = await sb.from('bot_run').select('bot, ok, finished_at').eq('run_date', today).in('bot', bots.map((b) => b[0]));
  if (error) return json({ ok: false, error: error.message }, 500);

  const missing: string[] = [], failed: string[] = [];
  for (const [bot, label] of bots) {
    const rows = (data || []).filter((r) => r.bot === bot);
    if (!rows.length) missing.push(label);
    else if (!rows.some((r) => r.ok)) failed.push(label);
  }
  if (!missing.length && !failed.length) return json({ ok: true, slot, today, sent: false });

  const L: string[] = [`*봇 점검 · ${Number(today.slice(5, 7))}/${Number(today.slice(8))}*`];
  if (missing.length) {
    L.push(`오늘 안 돈 봇 ${missing.length}개`, ...missing.map((m) => `- ${m}`));
    L.push(missing.length === bots.length && bots.length > 1
      ? '전부 안 돌았습니다. 맥북 에어가 꺼져 있거나 인터넷이 끊긴 것 같습니다.'
      : '맥북 에어가 그 시각에 잠들어 있었는지, 로그(~/Library/Logs/caramel/)에 오류가 있는지 봐 주세요.');
  }
  if (failed.length) L.push(`돌았지만 실패한 봇 ${failed.length}개 (실패 DM 갔음)`, ...failed.map((m) => `- ${m}`));
  const text = L.join('\n');
  if (p.dry) return json({ ok: true, slot, today, sent: false, text });

  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${Deno.env.get('SLACK_TOKEN')}` },
    body: JSON.stringify({ channel: DM, text, unfurl_links: false }),
  }).then((x) => x.json());
  return json({ ok: !!r.ok, slot, today, sent: !!r.ok, error: r.error });
});
