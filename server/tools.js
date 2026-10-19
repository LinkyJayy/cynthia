// Function tools that make up Cynthia's "computer". Gemini's built-in Google Search,
// URL context and Python code execution are enabled alongside these in agent.js.
import { db, id, now } from './db.js';
import { generate } from './gemini.js';
import { config } from './config.js';
import { safeFetch, htmlToText } from './net.js';
import { runBrowser, browserAvailable } from './browser.js';
import { saveFile, readFile, listFiles, deleteFile, pruneFolder, isText } from './workspace.js';
import { notify } from './push.js';

const slug = (s) =>
  String(s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'untitled';
const vec3 = { type: 'array', items: { type: 'number' }, description: '[x, y, z]' };
const truncate = (s, n = 20000) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s);

const tools = {};
function tool(name, label, description, parameters, handler) {
  tools[name] = { declaration: { name, description, parameters }, label, handler };
}

// ---------------------------------------------------------------- Browser
tool(
  'browser',
  (a) =>
    ({
      open: `Browsing ${a.url}`,
      click: `Clicking ${a.text ? `"${a.text}"` : 'on the page'}`,
      type: `Typing ${a.value ? `"${String(a.value).slice(0, 40)}"` : 'on the page'}`,
      press: `Pressing ${a.key || 'Enter'}`,
      scroll: 'Scrolling the page',
      back: 'Going back',
      snapshot: 'Looking at the page',
      close: 'Closing the browser',
    })[a.action] || 'Using the browser',
  "Control Cynthia's own headless Chrome browser to visit and interact with websites (log-in-free browsing, clicking, filling forms, reading JS-heavy pages). Every action returns the page URL, title, visible text, numbered interactive elements and a screenshot. Refer to elements by their [ref] number.",
  {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'click', 'type', 'press', 'scroll', 'back', 'snapshot', 'close'] },
      url: { type: 'string', description: 'For open.' },
      ref: { type: 'integer', description: 'Element number from interactive_elements (click/type).' },
      selector: { type: 'string', description: 'CSS selector alternative to ref.' },
      text: { type: 'string', description: 'Visible text of element to click, alternative to ref.' },
      value: { type: 'string', description: 'Text to type (type action).' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
      key: { type: 'string', description: 'Key for press, e.g. Enter, Escape, ArrowDown.' },
      direction: { type: 'string', enum: ['up', 'down'] },
    },
    required: ['action'],
  },
  async (ctx, args) => {
    const out = await runBrowser(ctx.user.id, args);
    if (out.image) {
      const path = `screenshots/${Date.now()}.jpg`;
      await saveFile(ctx.user.id, path, out.image.data, 'image/jpeg');
      await pruneFolder(ctx.user.id, 'screenshots', 40);
      ctx.attach({ kind: 'image', path, caption: out.result.title || out.result.url });
    }
    return out;
  },
);

// ---------------------------------------------------------------- HTTP
tool(
  'http_request',
  (a) => `${a.method || 'GET'} ${a.url}`,
  'Make an HTTP request to a public API or URL and get the response body. Use for JSON APIs and raw data. (For reading normal web pages prefer the built-in URL context or the browser.)',
  {
    type: 'object',
    properties: {
      url: { type: 'string' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
      headers_json: { type: 'string', description: 'Optional JSON object of request headers.' },
      body: { type: 'string', description: 'Optional request body (JSON as a string, form data, etc).' },
    },
    required: ['url'],
  },
  async (_ctx, { url, method = 'GET', headers_json, body }) => {
    const headers = headers_json ? JSON.parse(headers_json) : {};
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['content-type'] = /^\s*[[{]/.test(body) ? 'application/json' : 'text/plain';
    }
    const res = await safeFetch(url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body });
    const type = res.headers.get('content-type') || '';
    let text = await res.text();
    if (type.includes('html')) text = htmlToText(text);
    return { result: { status: res.status, content_type: type, body: truncate(text) } };
  },
);

// ---------------------------------------------------------------- 3D models
tool(
  'create_3d_model',
  (a) => `Building 3D model "${a.name}"`,
  'Create a 3D model from primitive parts. The user sees it in an interactive 3D viewer and can download it as GLB/STL (for 3D printing, Blender, games, AR). Y is up, units are arbitrary (1 ≈ 10 cm). Combine many parts for detailed results. Rotation is in degrees. "lathe" revolves 2D [radius, y] points around the Y axis (vases, bottles, chess pieces). "extrude" extrudes a 2D [x, y] outline by size.depth (logos, letters, flat custom shapes).',
  {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      background: { type: 'string', description: 'Viewer background hex color, optional.' },
      parts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            shape: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'plane', 'lathe', 'extrude', 'icosahedron', 'octahedron', 'tetrahedron', 'dodecahedron'] },
            size: {
              type: 'object',
              description: 'Dimensions; use the ones relevant to the shape.',
              properties: {
                width: { type: 'number' }, height: { type: 'number' }, depth: { type: 'number' },
                radius: { type: 'number' }, radiusTop: { type: 'number' }, radiusBottom: { type: 'number' },
                tube: { type: 'number', description: 'Torus tube radius.' }, length: { type: 'number', description: 'Capsule length.' },
              },
            },
            points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'For lathe/extrude: list of [a, b] 2D points.' },
            position: vec3,
            rotation: vec3,
            scale: vec3,
            color: { type: 'string', description: 'Hex color like #ff8800.' },
            metalness: { type: 'number' },
            roughness: { type: 'number' },
            opacity: { type: 'number' },
            emissive: { type: 'string', description: 'Glow hex color, optional.' },
          },
          required: ['shape'],
        },
      },
    },
    required: ['name', 'parts'],
  },
  async (ctx, args) => {
    const path = `models/${slug(args.name)}-${Date.now().toString(36)}.model3d.json`;
    const model = { name: args.name, description: args.description || '', background: args.background, parts: args.parts || [] };
    await saveFile(ctx.user.id, path, JSON.stringify(model, null, 2));
    ctx.attach({ kind: 'model3d', path, caption: args.name });
    return { result: { saved: path, parts: model.parts.length, note: 'The user can now view, rotate and download the model.' } };
  },
);

// ---------------------------------------------------------------- Images
tool(
  'generate_image',
  (a) => `Creating image: ${String(a.prompt).slice(0, 60)}`,
  'Generate or edit an image from a text prompt using Gemini image generation. Optionally pass a file path of an existing image in the workspace to edit it.',
  {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image.' },
      name: { type: 'string', description: 'Short file name.' },
      source_image_path: { type: 'string', description: 'Optional workspace image to edit.' },
    },
    required: ['prompt'],
  },
  async (ctx, { prompt, name, source_image_path }) => {
    const parts = [{ text: prompt }];
    if (source_image_path) {
      const f = await readFile(ctx.user.id, source_image_path);
      if (!f) throw new Error(`No such file: ${source_image_path}`);
      parts.push({ inlineData: { mimeType: f.mime, data: Buffer.from(f.data).toString('base64') } });
    }
    const out = await generate(config.geminiImageModel, {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    });
    const img = out.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!img) throw new Error('The image model did not return an image.');
    const ext = img.inlineData.mimeType.split('/')[1] || 'png';
    const path = `images/${slug(name || prompt)}-${Date.now()}.${ext}`;
    await saveFile(ctx.user.id, path, Buffer.from(img.inlineData.data, 'base64'), img.inlineData.mimeType);
    ctx.attach({ kind: 'image', path, caption: name || '' });
    return { result: { saved: path } };
  },
);

// ---------------------------------------------------------------- Files
tool(
  'write_file',
  (a) => `Saving ${a.path}`,
  "Create or overwrite a text file in Cynthia's persistent workspace (notes, code, documents, CSV, HTML, SVG...). The user can open and download it from the Computer panel.",
  { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  async (ctx, { path, content }) => {
    const f = await saveFile(ctx.user.id, path, content);
    ctx.attach({ kind: 'file', path: f.path, caption: f.path });
    return { result: { saved: f.path, bytes: f.size } };
  },
);
tool(
  'read_file',
  (a) => `Reading ${a.path}`,
  'Read a file from the workspace. Text files return their contents; images are shown to you.',
  { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async (ctx, { path }) => {
    const f = await readFile(ctx.user.id, path);
    if (!f) throw new Error(`No such file: ${path}`);
    const data = Buffer.from(f.data);
    if (isText(f.mime)) return { result: { path: f.path, mime: f.mime, content: truncate(data.toString('utf8'), 60000) } };
    if (/^image\/|application\/pdf/.test(f.mime)) {
      return { result: { path: f.path, mime: f.mime, size: f.size }, image: { mimeType: f.mime, data } };
    }
    return { result: { path: f.path, mime: f.mime, size: f.size, note: 'Binary file; contents not shown.' } };
  },
);
tool(
  'list_files',
  () => 'Looking through files',
  'List files in the workspace, optionally within a folder.',
  { type: 'object', properties: { folder: { type: 'string' } } },
  async (ctx, { folder }) => ({
    result: { files: (await listFiles(ctx.user.id, folder || '')).map((f) => ({ path: f.path, mime: f.mime, size: f.size })) },
  }),
);
tool(
  'delete_file',
  (a) => `Deleting ${a.path}`,
  'Delete a file from the workspace.',
  { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async (ctx, { path }) => ({ result: { deleted: await deleteFile(ctx.user.id, path) } }),
);

// ---------------------------------------------------------------- Memory
tool(
  'remember',
  () => 'Saving to memory',
  'Store a long-term memory about the user (preferences, facts, ongoing projects). Memories are shown to you in every future conversation.',
  { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
  async (ctx, { content }) => {
    const mid = id();
    await db.run('INSERT INTO memories (id, user_id, content, created_at) VALUES (?, ?, ?, ?)', [mid, ctx.user.id, String(content).slice(0, 1000), now()]);
    return { result: { saved: true, memory_id: mid } };
  },
);
tool(
  'forget',
  () => 'Forgetting a memory',
  'Delete a stored memory by its id.',
  { type: 'object', properties: { memory_id: { type: 'string' } }, required: ['memory_id'] },
  async (ctx, { memory_id }) => ({
    result: { deleted: (await db.run('DELETE FROM memories WHERE id = ? AND user_id = ?', [memory_id, ctx.user.id])).changes > 0 },
  }),
);

// ---------------------------------------------------------------- Always-on tasks
tool(
  'schedule_task',
  (a) => `Scheduling "${a.title}"`,
  'Schedule Cynthia to do something later or repeatedly while the user is away (reminders, daily briefings, monitoring a website or price, recurring reports). When it runs, Cynthia performs the prompt with all her tools, posts the result in this conversation and sends a push notification.',
  {
    type: 'object',
    properties: {
      title: { type: 'string' },
      prompt: { type: 'string', description: 'Instructions Cynthia will follow when the task runs, written to her future self.' },
      run_at: { type: 'string', description: 'ISO 8601 date-time with timezone offset for the first run.' },
      delay_minutes: { type: 'number', description: 'Alternative to run_at: minutes from now.' },
      every_minutes: { type: 'integer', description: 'Repeat interval in minutes (min 5). Omit for a one-time task.' },
    },
    required: ['title', 'prompt'],
  },
  async (ctx, { title, prompt, run_at, delay_minutes, every_minutes }) => {
    const every = every_minutes ? Math.max(5, Math.floor(every_minutes)) : null;
    // Without an explicit start, repeating tasks first run one interval from now.
    const delay = delay_minutes != null ? Number(delay_minutes) || 0 : every || 0;
    let next = run_at ? Date.parse(run_at) : now() + delay * 60000;
    if (!Number.isFinite(next)) throw new Error('run_at is not a valid date.');
    if (next < now()) next = now() + 5000;
    const tid = id();
    await db.run(
      'INSERT INTO tasks (id, user_id, conversation_id, title, prompt, every_minutes, next_run_at, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
      [tid, ctx.user.id, ctx.conversationId, title, prompt, every, next, now()],
    );
    return { result: { task_id: tid, first_run: new Date(next).toISOString(), repeats_every_minutes: every } };
  },
);
tool(
  'list_tasks',
  () => 'Checking scheduled tasks',
  'List scheduled tasks.',
  { type: 'object', properties: {} },
  async (ctx) => ({
    result: {
      tasks: (await db.all('SELECT * FROM tasks WHERE user_id = ? ORDER BY next_run_at', [ctx.user.id])).map((t) => ({
        task_id: t.id, title: t.title, prompt: t.prompt, enabled: Boolean(t.enabled), every_minutes: t.every_minutes,
        next_run: new Date(t.next_run_at).toISOString(), last_run: t.last_run_at ? new Date(t.last_run_at).toISOString() : null,
      })),
    },
  }),
);
tool(
  'cancel_task',
  () => 'Cancelling a task',
  'Cancel (delete) a scheduled task.',
  { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  async (ctx, { task_id }) => ({
    result: { cancelled: (await db.run('DELETE FROM tasks WHERE id = ? AND user_id = ?', [task_id, ctx.user.id])).changes > 0 },
  }),
);

// ---------------------------------------------------------------- Notifications & integrations
tool(
  'send_notification',
  (a) => `Notifying: ${a.title}`,
  "Send a push notification to the user's devices (phone/desktop where the app is installed and notifications are enabled).",
  { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
  async (ctx, { title, body }) => ({
    result: { delivered_to_devices: await notify(ctx.user.id, { title, body, url: `/?c=${ctx.conversationId}` }) },
  }),
);
tool(
  'call_integration',
  (a) => `Sending to ${a.name}`,
  'Send a message or data to one of the services the user has connected in Settings → Connections (Discord, Slack, Zapier/Make/IFTTT/n8n webhooks, Home Assistant, custom APIs...).',
  {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Connection name.' },
      message: { type: 'string', description: 'Human-readable message text.' },
      payload_json: { type: 'string', description: 'Optional extra JSON object to send (merged into the body for webhooks).' },
    },
    required: ['name'],
  },
  async (ctx, { name, message = '', payload_json }) => {
    const integ = await db.get('SELECT * FROM integrations WHERE user_id = ? AND LOWER(name) = LOWER(?)', [ctx.user.id, name]);
    if (!integ) throw new Error(`No connection named "${name}". Ask the user to add it in Settings → Connections.`);
    const extra = payload_json ? JSON.parse(payload_json) : {};
    const body =
      integ.kind === 'discord' ? { content: message.slice(0, 2000), ...extra }
      : integ.kind === 'slack' ? { text: message, ...extra }
      : { message, source: 'cynthia', ...extra };
    const res = await safeFetch(integ.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...JSON.parse(integ.headers || '{}') },
      body: JSON.stringify(body),
    });
    return { result: { status: res.status, response: truncate(await res.text(), 4000) } };
  },
);

export async function getToolDeclarations() {
  const hasBrowser = await browserAvailable();
  return Object.entries(tools)
    .filter(([name]) => name !== 'browser' || hasBrowser)
    .map(([, t]) => t.declaration);
}

export function toolLabel(name, args) {
  const t = tools[name];
  try {
    return t ? t.label(args || {}) : name;
  } catch {
    return name;
  }
}

export async function runTool(ctx, name, args) {
  const t = tools[name];
  if (!t) throw new Error(`Unknown tool: ${name}`);
  return t.handler(ctx, args || {});
}
