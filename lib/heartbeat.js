'use strict';

const { activityFor, activeWindowMs } = require('./activity');

// POST /api/agents/:id/heartbeat — агент жив. Тело необязательное: { note }.
function registerHeartbeat(app, deps) {
  const { requireAgentToken, findAgent, orders } = deps;
  const clock = deps.now || (() => Date.now());

  app.post('/api/agents/:id/heartbeat', requireAgentToken, async (req, res) => {
    const agent = findAgent(String(req.params.id || ''));
    if (!agent) return res.status(404).json({ error: 'Неизвестный агент' });
    if (agent.archived) return res.status(409).json({ error: 'Агент в архиве' });

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (Object.prototype.hasOwnProperty.call(body, 'note') && body.note != null && body.note !== '') {
      if (typeof body.note !== 'string') {
        return res.status(400).json({ error: 'note должен быть строкой' });
      }
      const note = body.note.trim();
      if (note.length > 200) {
        return res.status(400).json({ error: 'Слишком длинная заметка (максимум 200 символов)' });
      }
      if (note) agent.heartbeatNote = note;
    }

    const at = clock();
    agent.lastSeenAt = new Date(at).toISOString();
    if (typeof deps.onSeen === 'function') await deps.onSeen(agent, at);
    const extras = typeof deps.activityExtras === 'function' ? deps.activityExtras() : {};
    const view = activityFor(agent, orders(), at, activeWindowMs(), extras);
    res.json({ ok: true, id: agent.id, ...view });
  });
}

module.exports = { registerHeartbeat };
