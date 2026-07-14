// Conversation persistence helpers — strip bulky image data before writing JSON.

export function stripContentForPersist(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  const parts = content.filter(p => p.type !== 'image_url');
  if (!parts.length) return '(image attachment)';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

export function toPersistedMessage(m) {
  const out = { role: m.role, content: stripContentForPersist(m.content) };
  if (m.attachNames?.length) out.attachNames = m.attachNames;
  if (m.reasoning) out.reasoning = m.reasoning;
  if (m.citations?.length) out.citations = m.citations;
  // local SD images live on disk — persist only the path, never the pixels
  if (m.imagePath) out.imagePath = m.imagePath;
  // message discriminator: 'image' = SD generation; absent = chat (old files)
  if (m.kind && m.kind !== 'chat') out.kind = m.kind;
  if (m.genParams) {
    // full generation params for replay — minus in-memory pixel buffers
    const { initB64, maskData, ...gp } = m.genParams;
    out.genParams = gp;
  }
  return out;
}
