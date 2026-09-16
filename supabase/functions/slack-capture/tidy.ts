// 슬랙 원문 → 일감 카드 정리 (Claude). index.ts 와 테스트 양쪽에서 쓴다.
import Anthropic from 'npm:@anthropic-ai/sdk@0.125.0';

export type Tidy = {
  task: string;
  priority: 'NONE' | 'DO' | 'DELEGATE' | 'SCHEDULE' | 'ELIMINATE';
  due_date: string;
  summary: string;
  done_when: string;
};

export const TIDY_SYSTEM = `너는 카라멜(자동차 세차 서비스) 팀의 일감 정리 담당이다.
슬랙 메시지를 받아서 담당자가 나중에 봐도 무슨 일인지 알 수 있는 일감 카드로 바꾼다.

제목(task)
- 40자 이내 한국어. 무엇을 해야 하는지가 드러나야 한다
- 슬랙 원문을 그대로 자르지 말고, 할 일로 다시 쓴다
- 예: "김대리가 다음주까지 계약서 검토해달래요" → "OO 계약서 검토 (요청: 김대리)"

우선순위(priority) — 아이젠하워 4분면
- DO: 긴급하고 중요하다. 오늘내일 안 하면 문제가 생기거나, 돈·법·고객에 직접 영향
- DELEGATE: 급하지만 중요도는 낮다. 단순 처리, 남이 해도 되는 일
- SCHEDULE: 중요하지만 급하지 않다. 기준 설계, 구조 개선, 준비 작업
- ELIMINATE: 둘 다 아니다. 안 해도 크게 지장 없는 일
- 판단할 근거가 메시지에 없으면 NONE 으로 두고 사람이 정하게 한다. 억지로 분류하지 마라

마감일(due_date)
- 메시지에 기한이 있을 때만 YYYY-MM-DD로 채운다. "다음주 화요일" 같은 상대 표현은 기준일로 계산한다
- 기한 언급이 없으면 none. 추측해서 넣지 마라

요약(summary)
- 2줄 이내. 배경과 요청 내용. 원문에 없는 사실을 지어내지 마라

완료 조건(done_when)
- 무엇이 되면 이 일감을 체크할 수 있는지 한 줄. 확인 가능한 상태로 쓴다
- 알 수 없으면 none

전체 규칙: 원문에 없는 정보를 만들지 마라. 모를 때만 none 을 쓰고, 그 외에는 반드시 내용을 채워라.
어떤 값에도 XML 태그나 <parameter> 같은 문자열을 넣지 마라.`;

export const TIDY_TOOL: Anthropic.Tool = {
  name: 'save_task',
  description: '정리한 일감을 저장한다',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '40자 이내 일감 제목' },
      priority: { type: 'string', enum: ['NONE', 'DO', 'DELEGATE', 'SCHEDULE', 'ELIMINATE'] },
      due_date: { type: 'string', description: "마감일 YYYY-MM-DD. 기한이 없으면 'none'" },
      summary: { type: 'string', description: '2줄 이내 배경 요약' },
      done_when: { type: 'string', description: "완료 조건 한 줄. 모르면 'none'" },
    },
    required: ['task', 'priority', 'due_date', 'summary', 'done_when'],
    additionalProperties: false,
  },
};

// 모델이 값 안에 태그 조각(</antml…, <parameter …)을 흘리는 경우가 있어 잘라낸다.
// 'none' 은 "값 없음"의 약속이므로 빈 문자열로 되돌린다.
function clean(v: unknown): string {
  if (typeof v !== 'string') return '';
  let t = v;
  const cut = t.search(/<\/?antml|<parameter\b|<\/parameter>/i);
  if (cut >= 0) t = t.slice(0, cut);
  t = t.trim();
  if (/^none$/i.test(t)) return '';
  return t;
}

export async function tidyWithClaude(
  person: string, teamLabel: string, today: string, bodyText: string,
): Promise<Tidy | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return null; // 키가 없으면 정리 없이 원문 저장

  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4000,
      output_config: { effort: 'low' }, // 짧은 분류 작업
      system: TIDY_SYSTEM,
      tools: [TIDY_TOOL],
      tool_choice: { type: 'tool', name: 'save_task' },
      messages: [{
        role: 'user',
        content: `오늘 날짜: ${today} (KST)
담당자: ${person} (${teamLabel})

--- 슬랙 원문 ---
${bodyText}`,
      }],
    });

    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') return null;
    const out = block.input as Tidy;
    if (!out || typeof out.task !== 'string' || !out.task.trim()) return null;
    return {
      task: clean(out.task),
      priority: (['DO', 'DELEGATE', 'SCHEDULE', 'ELIMINATE'].includes(out.priority) ? out.priority : 'NONE') as Tidy['priority'],
      due_date: clean(out.due_date),
      summary: clean(out.summary),
      done_when: clean(out.done_when),
    };
  } catch (err) {
    console.error('tidy failed', err);
    return null; // 정리 실패해도 캡처는 계속한다
  }
}
