// "Ask Yatra": a travel assistant beside the trip plan.
// With the visitor's own Anthropic API key (kept only in their browser) it answers
// anything about the city. Without a key it still suggests places from the open data.

import Anthropic from '@anthropic-ai/sdk';
import { $, esc } from './shared';
import type { TripContext } from './trip';

const KEY = 'yatra-anthropic-key';
const CHIPS = [
  'Suggest places to visit',
  'Best food nearby?',
  'Hidden gems?',
  'Is it safe at night?',
  'What should I wear?',
  'Rainy day ideas',
];

let context: () => TripContext | null = () => null;
let history: Anthropic.Beta.BetaMessageParam[] = [];
let busy = false;

const getKey = () => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};

export function wireAssistant(getContext: () => TripContext | null): void {
  context = getContext;
  $('ask-open').onclick = () => open(true);
  $('ask-close').onclick = () => open(false);
  $('ask-chips').innerHTML = CHIPS.map((c) => `<button type="button">${c}</button>`).join('');
  $('ask-chips').onclick = (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b) ask(b.textContent ?? '');
  };
  $('ask-form').onsubmit = (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('ask-input');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    ask(q);
  };
  $('ask-key-form').onsubmit = (e) => {
    e.preventDefault();
    const value = $<HTMLInputElement>('ask-key').value.trim();
    if (!value) return;
    try {
      localStorage.setItem(KEY, value);
    } catch {
      // storage blocked: the key works for this visit only
    }
    $<HTMLInputElement>('ask-key').value = '';
    renderKeyState();
    say('assistant', 'All set. Ask me anything about this trip.');
  };
  $('ask-forget').onclick = () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // nothing stored
    }
    renderKeyState();
  };
}

/** A new city starts a new conversation. */
export function resetAssistant(): void {
  history = [];
  $('ask-log').innerHTML = '';
  const c = context();
  if (c) $('ask-city').textContent = c.name;
}

function open(on: boolean): void {
  $('ask').classList.toggle('on', on);
  $('ask-open').hidden = on;
  if (on) {
    renderKeyState();
    if (!$('ask-log').children.length) {
      const c = context();
      say('assistant', `Hi Hanee! Ask me anything about ${c?.name ?? 'this trip'}, or tap a question below.`);
    }
    $('ask-input').focus();
  }
}

function renderKeyState(): void {
  const has = Boolean(getKey());
  $('ask-setup').hidden = has;
  $('ask-forget').hidden = !has;
}

function say(role: 'user' | 'assistant', text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = format(text);
  $('ask-log').append(el);
  $('ask-log').scrollTop = $('ask-log').scrollHeight;
  return el;
}

/** Just enough formatting for short answers: bold, bullets, line breaks. */
function format(text: string): string {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^\s*[-•]\s+(.*)$/gm, '<span class="li">$1</span>')
    .replace(/\n/g, '<br>');
}

async function ask(question: string): Promise<void> {
  if (busy) return;
  say('user', question);
  const key = getKey();
  if (!key) {
    say('assistant', offline(question));
    return;
  }
  busy = true;
  const out = say('assistant', '');
  out.classList.add('typing');
  history.push({ role: 'user', content: question });
  let text = '';
  try {
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    const stream = client.beta.messages.stream({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: systemPrompt(),
      messages: history,
    });
    stream.on('text', (delta) => {
      text += delta;
      out.classList.remove('typing');
      out.innerHTML = format(text);
      $('ask-log').scrollTop = $('ask-log').scrollHeight;
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      text = text || "I can't help with that one. Try asking about places, food or getting around.";
      out.innerHTML = format(text);
    }
    history.push({ role: 'assistant', content: final.content });
  } catch (error) {
    history.pop();
    out.classList.remove('typing');
    if (error instanceof Anthropic.AuthenticationError) {
      out.innerHTML = format('That API key was not accepted. Tap "Forget key" and paste it again.');
    } else if (error instanceof Anthropic.RateLimitError) {
      out.innerHTML = format('Too many questions at once. Wait a moment and try again.');
    } else if (error instanceof Anthropic.APIError) {
      out.innerHTML = format(`Something went wrong (${error.status ?? 'network'}). Try again in a moment.`);
    } else {
      out.innerHTML = format('Could not reach the assistant. Check your connection.');
    }
  } finally {
    busy = false;
  }
}

function systemPrompt(): string {
  const c = context();
  if (!c) return 'You are Yatra, a friendly travel planner. Keep answers short.';
  return [
    `You are Yatra, a friendly local travel guide helping Hanee, a traveller from Toronto, plan a trip to ${c.name}${c.country ? `, ${c.country}` : ''}.`,
    `Trip: ${c.days.length} days starting ${c.start}, pace "${c.pace}".`,
    'Current plan (day: stops):',
    ...c.days.map((d) => `- ${d}`),
    c.weather ? `Forecast: ${c.weather}` : '',
    c.extras.length ? `Other well-documented places nearby not yet in the plan: ${c.extras.join(', ')}.` : '',
    'Answer in at most about 120 words, warm and practical. Use short bullet points ("- ") for lists and **bold** for place names.',
    'When suggesting places, prefer real, well-known spots in this city and say which day of the plan they would fit best.',
    'If you are unsure about opening hours, prices or safety details, say so and suggest checking locally.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Without a key: useful answers from the data the plan already has. */
function offline(question: string): string {
  const c = context();
  const q = question.toLowerCase();
  if (c && /suggest|place|visit|gem|see|do/.test(q) && c.extras.length) {
    return `A few more places in **${c.name}** worth a look:\n${c.extras.slice(0, 5).map((p) => `- **${p}**`).join('\n')}\n\nTap ↻ Swap on any stop to bring new places into your plan.`;
  }
  if (c && /wear|pack|cloth/.test(q) && c.packing.length) {
    return `For this trip:\n${c.packing.map((p) => `- ${p}`).join('\n')}`;
  }
  if (c && /rain/.test(q)) {
    return `On rainy days your plan already moves the indoor places (museums, palaces, temples) first, and outdoor stops get an indoor Plan B when rain is likely.`;
  }
  return 'For full answers about food, safety and anything else, add your own Anthropic API key above. Without one I can still suggest places and help you pack.';
}
