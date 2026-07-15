// 오토랩 데일리 슬랙 알림
// GitHub Actions cron으로 매일 아침 실행
// 정렬 로직은 대시보드(index.html)와 일치: 개인업무는 우선순위 → 마감일 순

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const DASHBOARD_URL = 'https://jungsikson.github.io/autolab-dashboard/';

const MENTION_MAP = {
  '송민호': '<@U08DNK6QP1P>',
  '강희준': '<@U06PSEETK54>',
  '안보람': '<@U032FKB6SJK>',
};

// 대시보드 담당자 카드와 동일한 순서 (황두현 제외 — 대시보드 미사용)
const PERSONS = ['강희준', '송민호', '안보람'];
// 대시보드 index.html의 PRIORITY_ORDER와 동일
const PRIORITY_ORDER = { DO: 0, DELEGATE: 1, SCHEDULE: 2, ELIMINATE: 3, '': 4 };
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

function getTodayKST() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function shiftDate(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// 직전 영업일 (월요일이면 지난 금요일). "어제 완료" 조회 시작점.
function getPrevBizDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=일 … 6=토
  const back = dow === 1 ? 3 : dow === 0 ? 2 : 1;
  return shiftDate(dateStr, -back);
}

function getDateLabelKST(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const m = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${m}월 ${dd}일(${DAY_NAMES[d.getUTCDay()]})`;
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
      if (before === '근무' || before === '라벨') return;
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
  const [wy, wm, wd] = today.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(wy, wm - 1, wd)).getUTCDay(); // runner=UTC라 getDay()는 하루 밀림 → getUTCDay()
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log('주말, 건너뜀');
    return;
  }
  const prevBiz = getPrevBizDay(today);

  const [scheduleRows, taskRows, checkRows] = await Promise.all([
    sbFetch(`cohort_schedule?date_key=eq.${today}&raw_text=neq.&select=cohort,date_key,raw_text`),
    sbFetch(`autolab_task?start_date=lte.${today}&priority=neq.&select=id,person,task,priority,start_date,due_date`),
    sbFetch(`autolab_check?select=type,item_key,checked,completed_date`),
  ]);

  const cohortChecks = {};
  const autolabCheckedIds = new Set();
  for (const row of checkRows) {
    if (!row.checked) continue;
    if (row.type === 'cohort') cohortChecks[row.item_key] = true;
    else autolabCheckedIds.add(String(row.item_key));
  }

  const personData = {};
  function ensure(p) {
    if (!personData[p]) personData[p] = { cohort: [], personal: [], done: [] };
  }

  // 교육일정 (cohort) — 별도 섹션
  for (const row of scheduleRows) {
    const tasks = parseTaskText(row.raw_text);
    tasks.forEach((t, ti) => {
      const checkKey = `${row.date_key}_${row.cohort}_${ti}`;
      if (cohortChecks[checkKey]) return;
      ensure(t.person);
      personData[t.person].cohort.push({
        label: `[${row.cohort}기] ${t.task}`,
        overdue: row.date_key < today,
      });
    });
  }

  // 개인업무 (autolab)
  for (const item of taskRows) {
    if (autolabCheckedIds.has(String(item.id))) continue;
    ensure(item.person);
    personData[item.person].personal.push({
      task: item.task,
      priority: item.priority || '',
      dueDate: item.due_date,
      startDate: item.start_date,
      overdue: item.start_date < today,
    });
  }

  // 개인업무 정렬: 우선순위 → 마감일(없으면 시작일) 오름차순 (대시보드와 동일)
  for (const p in personData) {
    personData[p].personal.sort((a, b) => {
      let pa = PRIORITY_ORDER[a.priority]; if (pa == null) pa = 4;
      let pb = PRIORITY_ORDER[b.priority]; if (pb == null) pb = 4;
      if (pa !== pb) return pa - pb;
      const ad = a.dueDate || a.startDate, bd = b.dueDate || b.startDate;
      if (ad < bd) return -1;
      if (ad > bd) return 1;
      return 0;
    });
  }

  // 어제(직전 영업일~오늘 직전) 완료 항목
  const doneChecks = checkRows.filter(r =>
    r.checked && r.completed_date && r.completed_date >= prevBiz && r.completed_date < today);
  const doneAutolabIds = doneChecks.filter(r => r.type === 'autolab').map(r => String(r.item_key));
  const doneCohortKeys = doneChecks.filter(r => r.type === 'cohort').map(r => r.item_key);

  if (doneAutolabIds.length) {
    const rows = await sbFetch(`autolab_task?id=in.(${doneAutolabIds.join(',')})&select=id,person,task`);
    for (const t of rows) { ensure(t.person); personData[t.person].done.push(t.task); }
  }

  if (doneCohortKeys.length) {
    const dateKeys = [...new Set(doneCohortKeys.map(k => k.split('_')[0]))];
    const rows = await sbFetch(`cohort_schedule?date_key=in.(${dateKeys.join(',')})&select=cohort,date_key,raw_text`);
    const rawMap = {};
    rows.forEach(r => { rawMap[`${r.date_key}_${r.cohort}`] = r.raw_text; });
    for (const key of doneCohortKeys) {
      const parts = key.split('_'); // [date_key, cohort, taskIndex]
      const raw = rawMap[`${parts[0]}_${parts[1]}`];
      if (!raw) continue;
      const tasks = parseTaskText(raw);
      const t = tasks[parseInt(parts[2])];
      if (t) { ensure(t.person); personData[t.person].done.push(`[${parts[1]}기] ${t.task}`); }
    }
  }

  const orderedPersons = PERSONS.filter(p =>
    personData[p] && (personData[p].cohort.length || personData[p].personal.length || personData[p].done.length));
  if (!orderedPersons.length) {
    console.log('오늘 할일 없음');
    return;
  }

  const lines = [`*[${getDateLabelKST(today)}] 오늘의 교육 일정*\n`];
  for (const person of orderedPersons) {
    const d = personData[person];
    lines.push(`*${MENTION_MAP[person] || person}*`);
    if (d.cohort.length) {
      lines.push('   *교육일정*');
      d.cohort.forEach(c => lines.push(`   ${c.label}${c.overdue ? ' (이월)' : ''}`));
    }
    if (d.personal.length) {
      lines.push('   *개인업무*');
      d.personal.forEach(t => lines.push(`   ${t.task}${t.overdue ? ' (이월)' : ''}`));
    }
    if (d.done.length) {
      lines.push('   *어제 완료* ✅');
      d.done.forEach(t => lines.push(`   ~${t}~`));
    }
    lines.push('');
  }
  lines.push(`<${DASHBOARD_URL}|대시보드 열기>`);

  const text = lines.join('\n');
  if (process.env.DRY_RUN) {
    console.log(text);
    return;
  }

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook 실패: ${res.status}`);
  console.log('데일리 슬랙 발송 완료');
}

main().catch(err => { console.error(err); process.exit(1); });
