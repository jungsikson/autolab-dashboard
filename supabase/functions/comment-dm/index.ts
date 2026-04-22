// Supabase Edge Function: 댓글 추가 시 담당자에게 Slack DM 발송
// DB Webhook: autolab_comment INSERT 이벤트에 연결

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MENTION_MAP: Record<string, string> = {
  '송민호': 'U08DNK6QP1P',
  '강희준': 'U06PSEETK54',
  '윤건희': 'U042D22A1RT',
  '황두현': 'U086L4NUPEF',
};

const DASHBOARD_URL = 'https://jungsikson.github.io/autolab-dashboard/';

serve(async (req) => {
  try {
    const body = await req.json();
    const record = body.record;
    if (!record) return new Response('no record', { status: 200 });

    const { task_id, author, text } = record;
    if (!task_id || !author || !text) return new Response('missing fields', { status: 200 });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: task } = await supabase
      .from('autolab_task')
      .select('person, task')
      .eq('id', task_id)
      .single();

    if (!task) return new Response('task not found', { status: 200 });

    const assignee = task.person;
    if (!assignee || assignee === author) return new Response('same person or no assignee', { status: 200 });

    const userId = MENTION_MAP[assignee];
    if (!userId) return new Response('no slack id for ' + assignee, { status: 200 });

    const slackToken = Deno.env.get('SLACK_TOKEN');
    if (!slackToken) return new Response('no slack token', { status: 200 });

    const msg = `*💬 새 댓글이 달렸어요*\n\n일감: *${task.task}*\n${author}: "${text}"\n\n<${DASHBOARD_URL}|대시보드에서 확인>`;

    const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${slackToken}`,
      },
      body: JSON.stringify({ channel: userId, text: msg }),
    });

    const slackData = await slackRes.json();
    if (!slackData.ok) console.error('Slack DM 실패:', slackData.error);

    return new Response(JSON.stringify({ ok: slackData.ok }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response('error', { status: 500 });
  }
});
