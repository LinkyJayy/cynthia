// Runs scheduled tasks in the background so Cynthia keeps working while users are away.
import { db, now } from './db.js';
import { runTurn, createConversation } from './agent.js';
import { notify } from './push.js';

const TICK_MS = 20 * 1000;
const running = new Set();
let timer;

async function runTask(task) {
  running.add(task.id);
  try {
    // Claim the task first so a slow run can't be picked up twice.
    const next = task.every_minutes ? now() + task.every_minutes * 60000 : null;
    if (next) await db.run('UPDATE tasks SET next_run_at = ?, last_run_at = ? WHERE id = ?', [next, now(), task.id]);
    else await db.run('UPDATE tasks SET enabled = 0, last_run_at = ? WHERE id = ?', [now(), task.id]);

    const user = await db.get('SELECT * FROM users WHERE id = ?', [task.user_id]);
    if (!user) return;
    let conversationId = task.conversation_id;
    if (!conversationId || !(await db.get('SELECT id FROM conversations WHERE id = ?', [conversationId]))) {
      conversationId = (await createConversation(user.id, `⏰ ${task.title}`)).id;
      await db.run('UPDATE tasks SET conversation_id = ? WHERE id = ?', [conversationId, task.id]);
    }
    const msg = await runTurn({
      user,
      conversationId,
      text: `⏰ Scheduled task "${task.title}": ${task.prompt}`,
      userMeta: { scheduled: true, taskId: task.id },
      extraSystem:
        'This message was triggered automatically by a scheduled task, not typed by the user right now. Do the task and report the result to the user directly and briefly. If the task is a reminder, deliver the reminder.',
    });
    await db.run('UPDATE tasks SET last_result = ? WHERE id = ?', [msg.content.slice(0, 2000), task.id]);
    await notify(user.id, {
      title: `Cynthia · ${task.title}`,
      body: msg.content.replace(/[#*_`>]/g, '').slice(0, 240),
      url: `/?c=${conversationId}`,
      tag: task.id,
    });
  } catch (e) {
    console.error('[scheduler] task failed', task.id, e.message);
    await db.run('UPDATE tasks SET last_result = ? WHERE id = ?', [`Error: ${e.message}`, task.id]).catch(() => {});
  } finally {
    running.delete(task.id);
  }
}

async function tick() {
  try {
    const due = await db.all('SELECT * FROM tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 10', [now()]);
    for (const t of due) if (!running.has(t.id)) runTask(t);
  } catch (e) {
    console.error('[scheduler]', e.message);
  }
}

export function startScheduler() {
  timer = setInterval(tick, TICK_MS);
  tick();
}

export function stopScheduler() {
  clearInterval(timer);
}
