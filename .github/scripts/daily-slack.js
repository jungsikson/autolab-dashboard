// 오토랩 데일리 슬랙 알림
// GitHub Actions cron으로 매일 아침 실행

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const DASHBOARD_URL = 'https://jungsikson.github.io/autolab-dashboard/';

const MENTION_MAP = {
  '송민호': '<@U08DNK6QP1P>',
  '강희준': '<@U06PSEETK54>',
  '윤건희': '<@U042D22A1RT>',
  '황두현': '<@U086L4NUPEF>',
};

const PERSONS = ['황두현', '강희준', '송민호', '윤건희'];
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

function getTodayKST() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function getDateLabelKST(dateStr) {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${m}월 ${dd}일(${DAY_NAMES[d.getDay()]})`;
}

function parseTaskText(text) {
  if (!text || !text.trim()) return [];
  const tasks = [];
  text.split('\n').forEach(line => {
    line = line.trim();
    if (!line) return;
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const before = line.substring(0, colonIdx).trim();
      const after = line.substring(colonIdx + 1).trim();
      if (/^[가-힣]{2,6}$/.test(before) && after) {
        after.split(',').map(t => t.trim()).filter(Boolean).forEach(t => {
          tasks.push({ person: before, task: t });
        });
        return;
      }
    }
    const cleaned = line.replace(/\s+/g, ' ').trim();
    if (cleaned) tasks.push({ person: '공통', task: cleaned });
  });
  return tasks;
}

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status} ${path}`);
  return res.json();
}

async function main() {
  const today = getTodayKST();
  const dayOfWeek = new Date(today + 'T00:00:00+09:00').getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log('주말, 건너뜀');
    return;
  }

  const [scheduleRows, taskRows, checkRows] = await Promise.all([
    sbFetch(`cohort_schedule?date_key=lte.${today}&raw_text=neq.&select=cohort,date_key,raw_text`),
    sbFetch(`autolab_task?start_date=lte.${today}&select=id,person,task,start_date,due_date`),
    sbFetch(`autolab_check?select=type,item_key,checked`),
  ]);

  const cohortChecks = {};
  const autolabCheckedIds = new Set();
  for (const row of checkRows) {
    if (!row.checked) continue;
    if (row.type === 'cohort') cohortChecks[row.item_key] = true;
    else autolabCheckedIds.add(row.item_key);
  }

  const personTasks = {};
  const personOrder = [];
  function ensurePerson(p) {
    if (!personTasks[p]) { personTasks[p] = { overdue: [], today: [] }; personOrder.push(p); }
  }

  for (const row of scheduleRows) {
    const tasks = parseTaskText(row.raw_text);
    tasks.forEach((t, ti) => {
      const checkKey = `${row.date_key}_${row.cohort}_${ti}`;
      if (cohortChecks[checkKey]) return;
      ensurePerson(t.person);
      const label = `[${row.cohort}기] ${t.task}`;
      if (row.date_key < today) personTasks[t.person].overdue.push(label);
      else personTasks[t.person].today.push(label);
    });
  }

  for (const item of taskRows) {
    if (item.due_date && item.due_date > today) continue;
    if (autolabCheckedIds.has(String(item.id))) continue;
    ensurePerson(item.person);
    if (item.start_date < today) personTasks[item.person].overdue.push(item.task);
    else personTasks[item.person].today.push(item.task);
  }

  const orderedPersons = PERSONS.filter(p => personTasks[p]);
  if (!orderedPersons.length) {
    console.log('오늘 할일 없음');
    return;
  }

  const lines = [`*[${getDateLabelKST(today)}] 오늘의 교육 일정*\n`];
  for (const person of orderedPersons) {
    const tasks = personTasks[person];
    if (!tasks.today.length && !tasks.overdue.length) continue;
    lines.push(`*${MENTION_MAP[person] || person}*`);
    if (tasks.today.length) {
      lines.push('   📌 *오늘 할일*');
      tasks.today.forEach(t => lines.push(`   ${t}`));
    }
    if (tasks.overdue.length) {
      lines.push('   ⚠️ *미완료 이월*');
      tasks.overdue.forEach(t => lines.push(`   ${t}`));
    }
    lines.push('');
  }
  lines.push(`<${DASHBOARD_URL}|대시보드 열기>`);

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: lines.join('\n') }),
  });
  if (!res.ok) throw new Error(`Slack webhook 실패: ${res.status}`);
  console.log('데일리 슬랙 발송 완료');
}

main().catch(err => { console.error(err); process.exit(1); });
