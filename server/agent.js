// The agent loop: streams Gemini output, runs tools, and persists the conversation.
import { db, id, now } from './db.js';
import { config } from './config.js';
import { stream, generate } from './gemini.js';
import { getToolDeclarations, runTool, toolLabel } from './tools.js';
import { saveFile } from './workspace.js';

const HISTORY_MESSAGES = 40;
const KEEP_MEDIA_MESSAGES = 6;

function systemPrompt(user, memories, integrations, extra) {
  const prefs = JSON.parse(user.prefs || '{}');
  const tz = prefs.timezone || 'UTC';
  let nowStr;
  try {
    nowStr = new Date().toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' });
  } catch {
    nowStr = new Date().toUTCString();
  }
  return `You are Cynthia, a warm, witty and highly capable AI assistant. Your mascot is a friendly purple bunny with a black bow tie.
You chat with ${user.name} inside a messaging app, so write like a great texter: conversational, concise, no filler. Use Markdown (lists, code blocks, tables) when it genuinely helps, but never LaTeX — write math in plain text or Unicode (x², √, π). Use emoji sparingly.

You have your own always-on computer:
- Google Search and URL reading for up-to-date facts (cite sources naturally). Always search when asked about current events, prices, news, sports, weather or anything that may have changed.
- A Python sandbox (code execution) for math, data analysis, charts and file conversion.
- A real web browser you control (open pages, click, type, read, screenshots) for interactive or JavaScript-heavy sites.
- A persistent file workspace, 3D model builder, image generator, long-term memory, scheduled background tasks, push notifications and connections to the user's other services.
Act autonomously: chain tools as needed and finish the job instead of asking for permission for harmless steps. Don't narrate every step — the app already shows your tool activity. Never invent tool results. Ask before doing anything irreversible or that sends messages to other people.

When making 3D models, use many well-proportioned parts with sensible colors; build the object around the origin with its base at y=0.

Current date/time for the user: ${nowStr} (${tz}).
${memories.length ? `\nWhat you remember about ${user.name} (memory_id: content):\n${memories.map((m) => `- ${m.id}: ${m.content}`).join('\n')}\n` : ''}
${integrations.length ? `\nConnected services (use call_integration):\n${integrations.map((i) => `- "${i.name}" (${i.kind})${i.description ? `: ${i.description}` : ''}`).join('\n')}\n` : '\nNo external services are connected yet; the user can add Discord, Slack or webhook connections in Settings → Connections.\n'}
${extra || ''}`.trim();
}

/** Drops large media from older turns to keep requests small. */
function stripMedia(contents) {
  return contents.map((c) => ({
    ...c,
    parts: c.parts.map((p) => {
      if (p.inlineData) return { text: `[${p.inlineData.mimeType} attachment omitted]` };
      if (p.functionResponse?.parts) {
        const { parts: _drop, ...fr } = p.functionResponse;
        return { ...p, functionResponse: fr };
      }
      return p;
    }),
  }));
}

async function loadHistory(conversationId) {
  const rows = await db.all(
    'SELECT role, raw FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
    [conversationId, HISTORY_MESSAGES],
  );
  rows.reverse();
  while (rows.length && rows[0].role !== 'user') rows.shift();
  const out = [];
  rows.forEach((r, i) => {
    let contents = JSON.parse(r.raw || '[]');
    if (i < rows.length - KEEP_MEDIA_MESSAGES) contents = stripMedia(contents);
    out.push(...contents);
  });
  return out;
}

function mergePart(parts, p) {
  const last = parts[parts.length - 1];
  const plainText = typeof p.text === 'string' && !p.thought && Object.keys(p).every((k) => k === 'text' || k === 'thoughtSignature');
  if (plainText && last && typeof last.text === 'string' && !last.thought && !last.functionCall && !p.thoughtSignature) {
    last.text += p.text;
  } else {
    parts.push({ ...p });
  }
}

export async function createConversation(userId, title = 'New chat') {
  const cid = id();
  const t = now();
  await db.run('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [cid, userId, title, t, t]);
  return { id: cid, title, created_at: t, updated_at: t };
}

async function autoTitle(conversationId, text) {
  try {
    const out = await generate('gemini-flash-lite-latest', {
      contents: [{ role: 'user', parts: [{ text: `Write a short (2-5 word) title for a chat that starts with this message. Reply with the title only, no quotes or punctuation at the end.\n\n${text.slice(0, 2000)}` }] }],
    });
    const title = (out.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '').trim().replace(/^["']|["'.]$/g, '').slice(0, 60);
    if (title) await db.run('UPDATE conversations SET title = ? WHERE id = ?', [title, conversationId]);
    return title;
  } catch {
    return null;
  }
}

/**
 * Runs one user turn.
 * @param {object} o
 * @param {object} o.user          DB user row
 * @param {string} o.conversationId
 * @param {string} o.text          user text
 * @param {Array}  [o.files]       [{ mimeType, data(base64), name }]
 * @param {(e:object)=>void} [o.emit]  streaming event sink
 * @param {AbortSignal} [o.signal]
 * @param {string} [o.extraSystem] additional system instructions (e.g. for scheduled tasks)
 * @param {object} [o.userMeta]    extra metadata saved with the user message
 */
export async function runTurn({ user, conversationId, text, files = [], emit = () => {}, signal, extraSystem, userMeta = {} }) {
  const conv = await db.get('SELECT * FROM conversations WHERE id = ? AND user_id = ?', [conversationId, user.id]);
  if (!conv) throw new Error('Conversation not found.');
  const isFirst = !(await db.get('SELECT id FROM messages WHERE conversation_id = ? LIMIT 1', [conversationId]));

  // ---- Save the user's message (attachments go into the workspace too)
  const userParts = [];
  const userAttachments = [];
  for (const f of files) {
    userParts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
    const path = `uploads/${Date.now()}-${(f.name || 'file').replace(/[^\w.-]+/g, '_')}`;
    await saveFile(user.id, path, Buffer.from(f.data, 'base64'), f.mimeType);
    userAttachments.push({ kind: f.mimeType.startsWith('image/') ? 'image' : 'file', path, caption: f.name || '' });
  }
  if (text) userParts.push({ text });
  if (!userParts.length) throw new Error('Message is empty.');
  const userMsg = {
    id: id(),
    conversation_id: conversationId,
    role: 'user',
    content: text || '',
    meta: { attachments: userAttachments, ...userMeta },
    created_at: now(),
  };
  await db.run('INSERT INTO messages (id, conversation_id, role, content, meta, raw, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    userMsg.id, conversationId, 'user', userMsg.content, JSON.stringify(userMsg.meta), JSON.stringify([{ role: 'user', parts: userParts }]), userMsg.created_at,
  ]);
  emit({ type: 'user_message', message: userMsg });
  await db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [now(), conversationId]);
  const titlePromise = isFirst && text ? autoTitle(conversationId, text) : null;

  // ---- Agent loop
  const [memories, integrations, declarations] = await Promise.all([
    db.all('SELECT id, content FROM memories WHERE user_id = ? ORDER BY created_at', [user.id]),
    db.all('SELECT name, kind, description FROM integrations WHERE user_id = ?', [user.id]),
    getToolDeclarations(),
  ]);
  const history = await loadHistory(conversationId);
  const turnContents = []; // new contents produced in this turn (persisted as raw)
  const meta = { tools: [], attachments: [], sources: [] };
  let displayText = '';
  let errorText = null;

  const attach = (a) => {
    meta.attachments.push(a);
    emit({ type: 'attachment', attachment: a });
  };
  const toolEvent = (t) => {
    const existing = meta.tools.find((x) => x.id === t.id);
    if (existing) Object.assign(existing, t);
    else meta.tools.push(t);
    emit({ type: 'tool', tool: { ...(existing || t) } });
  };
  const ctx = { user, conversationId, attach };

  try {
    for (let step = 0; step < config.maxAgentSteps; step++) {
      const body = {
        systemInstruction: { parts: [{ text: systemPrompt(user, memories, integrations, extraSystem) }] },
        contents: [...history, ...turnContents],
        tools: [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }, { functionDeclarations: declarations }],
        toolConfig: { includeServerSideToolInvocations: true },
      };
      const parts = [];
      let finishReason;
      let stepText = '';
      for await (const chunk of stream(config.geminiModel, body, signal)) {
        const cand = chunk.candidates?.[0];
        if (!cand) {
          if (chunk.promptFeedback?.blockReason) throw new Error(`Request blocked (${chunk.promptFeedback.blockReason}).`);
          continue;
        }
        finishReason = cand.finishReason || finishReason;
        for (const p of cand.content?.parts || []) {
          if (typeof p.text === 'string' && !p.thought) {
            if (p.text) {
              if (!stepText && displayText) {
                displayText += '\n\n';
                emit({ type: 'text', delta: '\n\n' });
              }
              stepText += p.text;
              displayText += p.text;
              emit({ type: 'text', delta: p.text });
            }
          } else if (p.toolCall) {
            const q = p.toolCall.args?.queries || p.toolCall.args?.urls;
            const label = /SEARCH/.test(p.toolCall.toolType) ? `Searching: ${(q || []).join(' · ') || 'the web'}`
              : /URL/.test(p.toolCall.toolType) ? `Reading ${(q || []).join(', ') || 'page'}`
              : 'Using a built-in tool';
            toolEvent({ id: p.toolCall.id || id(), name: p.toolCall.toolType, label, status: 'running' });
          } else if (p.toolResponse) {
            const t = meta.tools.find((x) => x.id === p.toolResponse.id);
            if (t) toolEvent({ ...t, status: 'done' });
          } else if (p.executableCode) {
            toolEvent({ id: p.executableCode.id || `code-${parts.length}`, name: 'code_execution', label: 'Running Python', status: 'running', detail: p.executableCode.code });
          } else if (p.codeExecutionResult) {
            const r = p.codeExecutionResult;
            const t = meta.tools.find((x) => x.id === r.id) || [...meta.tools].reverse().find((x) => x.name === 'code_execution');
            if (t) toolEvent({ ...t, status: r.outcome === 'OUTCOME_OK' ? 'done' : 'error', output: (r.output || '').slice(0, 4000) });
          } else if (p.inlineData) {
            const ext = (p.inlineData.mimeType.split('/')[1] || 'bin').replace('plain', 'txt').replace('svg+xml', 'svg');
            const path = `outputs/${Date.now()}.${ext}`;
            await saveFile(user.id, path, Buffer.from(p.inlineData.data, 'base64'), p.inlineData.mimeType);
            attach({ kind: p.inlineData.mimeType.startsWith('image/') ? 'image' : 'file', path, caption: '' });
          }
          mergePart(parts, p);
        }
        for (const g of cand.groundingMetadata?.groundingChunks || []) {
          if (g.web?.uri && !meta.sources.some((s) => s.uri === g.web.uri)) {
            const src = { title: g.web.title || g.web.domain || g.web.uri, uri: g.web.uri };
            meta.sources.push(src);
            emit({ type: 'source', source: src });
          }
        }
      }

      const calls = parts.filter((p) => p.functionCall);
      if (!parts.length) {
        if (!displayText) errorText = finishReason && finishReason !== 'STOP' ? `I couldn't respond (${finishReason}).` : null;
        break;
      }
      turnContents.push({ role: 'model', parts });
      if (!calls.length) break;

      const responses = [];
      for (const { functionCall: fc } of calls) {
        const tid = fc.id || id();
        toolEvent({ id: tid, name: fc.name, label: toolLabel(fc.name, fc.args), status: 'running' });
        let response;
        const extraParts = [];
        try {
          const out = await runTool(ctx, fc.name, fc.args);
          response = { result: out.result };
          if (out.image) {
            extraParts.push({ inlineData: { mimeType: out.image.mimeType, data: Buffer.from(out.image.data).toString('base64') } });
          }
          toolEvent({ id: tid, status: 'done' });
        } catch (e) {
          response = { error: e.message };
          toolEvent({ id: tid, status: 'error', output: e.message });
        }
        const fr = { name: fc.name, response };
        if (fc.id) fr.id = fc.id;
        if (extraParts.length) fr.parts = extraParts;
        responses.push({ functionResponse: fr });
      }
      turnContents.push({ role: 'user', parts: responses });
      if (step === config.maxAgentSteps - 1) displayText += '\n\n_(I hit my step limit for this turn — say "continue" to keep going.)_';
    }
  } catch (e) {
    if (signal?.aborted) errorText = displayText ? null : '_(stopped)_';
    else {
      console.error('[agent]', e);
      errorText = `Sorry — something went wrong: ${e.message}`;
    }
  }

  // Never persist a dangling function call without its response.
  while (turnContents.length && turnContents[turnContents.length - 1].role === 'model' &&
    turnContents[turnContents.length - 1].parts.some((p) => p.functionCall)) turnContents.pop();
  if (errorText) {
    displayText = displayText ? `${displayText}\n\n${errorText}` : errorText;
    meta.error = true;
  }
  if (!turnContents.length || turnContents[turnContents.length - 1].role !== 'model') {
    turnContents.push({ role: 'model', parts: [{ text: displayText || '…' }] });
  }

  const assistantMsg = {
    id: id(),
    conversation_id: conversationId,
    role: 'assistant',
    content: displayText,
    meta,
    created_at: now(),
  };
  await db.run('INSERT INTO messages (id, conversation_id, role, content, meta, raw, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    assistantMsg.id, conversationId, 'assistant', assistantMsg.content, JSON.stringify(meta), JSON.stringify(turnContents), assistantMsg.created_at,
  ]);
  await db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [now(), conversationId]);
  if (titlePromise) {
    const title = await titlePromise;
    if (title) emit({ type: 'title', title });
  }
  emit({ type: 'done', message: assistantMsg });
  return assistantMsg;
}
