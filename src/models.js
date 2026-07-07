// Chat model catalog — same six as the vanilla build.
export const MODELS = [
  { id: 'anthropic/claude-opus-4.8',      label: 'Claude Opus 4.8',    desc: 'best all-round' },
  { id: 'openai/gpt-5.5',                 label: 'GPT-5.5',            desc: 'agentic / debugging' },
  { id: 'google/gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro',     desc: 'huge context' },
  { id: 'deepseek/deepseek-v4-pro',       label: 'DeepSeek V4 Pro',    desc: 'best value' },
  { id: 'deepseek/deepseek-v4-flash',     label: 'DeepSeek V4 Flash',  desc: 'cheapest, fast coding' },
  { id: 'x-ai/grok-4.3',                  label: 'Grok 4.3',           desc: 'real-time' }
];

export const IMG_MODELS = [
  { id: 'google/gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image (Nano Banana 2) — fast, cheap' },
  { id: 'google/gemini-3-pro-image',     label: 'Gemini 3 Pro Image (Nano Banana Pro) — best quality' },
  { id: 'bytedance/seedream-4.5',        label: 'Seedream 4.5 — $0.04/image flat' },
  { id: 'x-ai/grok-imagine-image',       label: 'Grok Imagine — photoreal, text in images' }
];

export const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:2', 'auto'];

export const DEFAULT_SETTINGS = {
  temp: 1.0, maxTok: 4096, defaultModel: '',
  imgModel: 'google/gemini-3.1-flash-image', imgAspect: '1:1'
};

export function modelLabel(id) {
  const m = MODELS.find(m => m.id === id);
  return m ? m.label : id;
}

// approximate usable context per model (tokens) for the attachment warning
export function contextBudget(id) {
  if (id.includes('gemini') || id.includes('deepseek')) return 900000; // ~1M-token models
  if (id.includes('opus') || id.includes('gpt')) return 180000;
  if (id.includes('grok')) return 120000;
  return 120000;
}

export function fmtCost(n) { return '$' + (n || 0).toFixed(4); }

// pull plain text out of a model message content (string or parts array)
export function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => p.type === 'text').map(p => p.text).join('\n').trim() || '(attachment)';
  }
  return '';
}
