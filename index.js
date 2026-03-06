const express = require('express');
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ══════════════════════════════════════════════════════
// SUPABASE CLIENT
// ══════════════════════════════════════════════════════
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

async function supabase(path, method = 'GET', body = null, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${path}${params}`;
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 204 || res.status === 200 && method === 'PATCH') return { success: true };
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// DB Helpers
const db = {
  // Phone Numbers
  async getPhone(phoneNumberId) {
    const r = await supabase('phone_numbers', 'GET', null, `?phone_number_id=eq.${phoneNumberId}&limit=1`);
    return Array.isArray(r) ? r[0] : null;
  },
  async upsertPhone(data) {
    return supabase('phone_numbers', 'POST', data, '?on_conflict=phone_number_id');
  },
  async updatePhone(phoneNumberId, data) {
    return supabase('phone_numbers', 'PATCH', data, `?phone_number_id=eq.${phoneNumberId}`);
  },

  // FAQs
  async getFaqs(phoneNumberId) {
    const r = await supabase('faqs', 'GET', null, `?phone_number_id=eq.${phoneNumberId}&order=sort_order.asc`);
    return Array.isArray(r) ? r : [];
  },
  async replaceFaqs(phoneNumberId, faqs) {
    await supabase('faqs', 'DELETE', null, `?phone_number_id=eq.${phoneNumberId}`);
    if (faqs.length === 0) return;
    const rows = faqs.map((f, i) => ({ phone_number_id: phoneNumberId, keywords: f.keywords, answer: f.answer, sort_order: i }));
    return supabase('faqs', 'POST', rows);
  },

  // Sessions
  async getSession(phoneNumberId, from) {
    const r = await supabase('sessions', 'GET', null, `?phone_number_id=eq.${phoneNumberId}&from_number=eq.${from}&limit=1`);
    if (Array.isArray(r) && r[0]) return r[0];
    // Create new session
    const newSession = { phone_number_id: phoneNumberId, from_number: from, history: [], waiting_for_transfer: false, transferred_to_human: false, waiting_for_ticket_msg: false };
    const created = await supabase('sessions', 'POST', newSession);
    return Array.isArray(created) ? created[0] : newSession;
  },
  async updateSession(phoneNumberId, from, data) {
    data.updated_at = new Date().toISOString();
    return supabase('sessions', 'PATCH', data, `?phone_number_id=eq.${phoneNumberId}&from_number=eq.${from}`);
  },

  // Tickets
  async createTicket(ticket) {
    return supabase('tickets', 'POST', ticket);
  },
  async getTickets(phoneNumberId) {
    const r = await supabase('tickets', 'GET', null, `?phone_number_id=eq.${phoneNumberId}&order=created_at.desc`);
    return Array.isArray(r) ? r : [];
  },
  async closeTicket(ticketId) {
    return supabase('tickets', 'PATCH', { status: 'closed', closed_at: new Date().toISOString() }, `?id=eq.${ticketId}`);
  },

  // Stats
  async incrementStat(phoneNumberId, field) {
    const today = new Date().toISOString().split('T')[0];
    // Upsert today's stats row
    const existing = await supabase('stats', 'GET', null, `?phone_number_id=eq.${phoneNumberId}&date=eq.${today}&limit=1`);
    if (Array.isArray(existing) && existing[0]) {
      const update = { [field]: (existing[0][field] || 0) + 1 };
      await supabase('stats', 'PATCH', update, `?phone_number_id=eq.${phoneNumberId}&date=eq.${today}`);
    } else {
      await supabase('stats', 'POST', { phone_number_id: phoneNumberId, date: today, [field]: 1 });
    }
  },

  // Notification Prefs
  async getNotifPrefs(phoneNumberId) {
    const r = await supabase('notification_prefs', 'GET', null, `?phone_number_id=eq.${phoneNumberId}&limit=1`);
    return Array.isArray(r) && r[0] ? r[0] : {
      notify_new_ticket: true, notify_transfer_request: true,
      notify_outside_hours: true, notify_new_customer: false,
      notify_every_message: false, via_whatsapp: true, via_email: false
    };
  },

  // Accounts
  async getAccount(email) {
    const r = await supabase('accounts', 'GET', null, `?email=eq.${encodeURIComponent(email)}&limit=1`);
    return Array.isArray(r) ? r[0] : null;
  },
  async createAccount(data) {
    return supabase('accounts', 'POST', data);
  },
  async getAccountPhones(accountId) {
    const r = await supabase('phone_numbers', 'GET', null, `?account_id=eq.${accountId}`);
    return Array.isArray(r) ? r : [];
  }
};

// ══════════════════════════════════════════════════════
// TICKET COUNTER (in-memory fallback)
// ══════════════════════════════════════════════════════
let ticketCounter = Date.now() % 100000;
function generateTicketId() {
  ticketCounter++;
  return 'TKT-' + ticketCounter;
}

// ══════════════════════════════════════════════════════
// BUSINESS HOURS CHECK
// ══════════════════════════════════════════════════════
function isWithinBusinessHours(hoursConfig) {
  if (!hoursConfig) return true;
  try {
    const { timezone = 'Asia/Riyadh', start = 9, end = 22, offDays = [] } = hoursConfig;
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false, weekday: 'long' });
    const parts   = formatter.formatToParts(new Date());
    const hour    = parseInt(parts.find(p => p.type === 'hour').value);
    const weekday = parts.find(p => p.type === 'weekday').value;
    if (offDays.includes(weekday)) return false;
    return hour >= start && hour < end;
  } catch { return true; }
}

// ══════════════════════════════════════════════════════
// SEND WHATSAPP
// ══════════════════════════════════════════════════════
async function sendMessage(phoneNumberId, token, to, text) {
  const res = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
  const data = await res.json();
  console.log('Sent to', to, JSON.stringify(data));
  return data;
}

// ══════════════════════════════════════════════════════
// NOTIFY OWNER
// ══════════════════════════════════════════════════════
async function notifyOwner(client, phoneNumberId, prefs, type, message) {
  // Check if this notification type is enabled
  const typeMap = {
    ticket: 'notify_new_ticket',
    transfer: 'notify_transfer_request',
    outside_hours: 'notify_outside_hours',
    new_customer: 'notify_new_customer'
  };
  const prefKey = typeMap[type];
  if (prefKey && !prefs[prefKey]) return;

  if (prefs.via_whatsapp && client.notify_phone) {
    try { await sendMessage(phoneNumberId, client.token, client.notify_phone, message); } catch (e) { console.error('Owner WA error:', e.message); }
  }
  if (prefs.via_email && client.notify_email) {
    console.log('Email to:', client.notify_email, '|', message); // hook your email API here
  }
}

// ══════════════════════════════════════════════════════
// CLAUDE AI
// ══════════════════════════════════════════════════════
async function getClaudeReply(userMessage, businessContext, faqs, history) {
  const faqText = faqs.length > 0 ? faqs.map(f => `• ${f.keywords}: ${f.answer}`).join('\n') : 'لا توجد أسئلة مبرمجة';
  const systemPrompt = `أنت مساعد ذكي لخدمة عملاء هذه الشركة.

═══════════════════════════════
معلومات الشركة:
═══════════════════════════════
${businessContext || 'لم يتم تحديد معلومات الشركة'}

═══════════════════════════════
الأسئلة الشائعة:
═══════════════════════════════
${faqText}

═══════════════════════════════
قواعد الرد:
═══════════════════════════════
1. رد بنفس لغة العميل
2. كن مختصراً ومفيداً
3. لا تخترع معلومات غير موجودة
4. إذا شعرت أن العميل جاد ويحتاج مساعدة متخصصة أضف في نهاية ردك: [SUGGEST_TRANSFER]
5. لا تضف [SUGGEST_TRANSFER] إلا عند الحاجة الفعلية`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, system: systemPrompt, messages: [...history, { role: 'user', content: userMessage }] })
  });
  const data = await response.json();
  return data.content?.[0]?.text || null;
}

// ══════════════════════════════════════════════════════
// WEBHOOK VERIFICATION
// ══════════════════════════════════════════════════════
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else res.sendStatus(403);
});

// ══════════════════════════════════════════════════════
// RECEIVE MESSAGES
// ══════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from          = message.from;
    const phoneNumberId = body.entry[0].changes[0].value.metadata.phone_number_id;
    const text          = message.text?.body?.trim() || '';
    const textLower     = text.toLowerCase();

    console.log(`[${phoneNumberId}] From ${from}: ${text}`);

    // Load client from Supabase
    const client = await db.getPhone(phoneNumberId);
    if (!client || !client.is_active) return res.sendStatus(200);

    // Load session
    const session = await db.getSession(phoneNumberId, from);
    const prefs   = await db.getNotifPrefs(phoneNumberId);

    // ── 1. HUMAN MODE ────────────────────────────────────────────────────────
    if (session.transferred_to_human) {
      console.log(`[${from}] Human mode — skipping`);
      return res.sendStatus(200);
    }

    // ── 2. WAITING FOR TRANSFER CONFIRMATION ─────────────────────────────────
    if (session.waiting_for_transfer) {
      const yes = ['نعم','yes','اي','اه','حسنا','ok','sure','👍'].some(w => textLower.includes(w));
      const no  = ['لا','no','لأ'].some(w => textLower.includes(w));
      if (yes) {
        await db.updateSession(phoneNumberId, from, { waiting_for_transfer: false, transferred_to_human: true });
        const ownerNum = client.notify_phone?.replace(/\D/g,'');
        await sendMessage(phoneNumberId, client.token, from,
          `✅ تم تحويلك لفريق خدمة العملاء.\nسيتواصل معك أحد المختصين قريباً.` +
          (ownerNum ? `\n\nأو تواصل مباشرة: wa.me/${ownerNum}` : '')
        );
        await notifyOwner(client, phoneNumberId, prefs, 'transfer',
          `🔔 *طلب تحويل — WaslBot*\n👤 العميل: ${from}\n💬 آخر رسالة: ${text}\n⏰ ${new Date().toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})}`
        );
        await db.incrementStat(phoneNumberId, 'transfers_requested');
      } else if (no) {
        await db.updateSession(phoneNumberId, from, { waiting_for_transfer: false });
        await sendMessage(phoneNumberId, client.token, from, 'حسناً! أنا هنا إذا احتجت شيئاً آخر 😊');
      } else {
        await sendMessage(phoneNumberId, client.token, from, 'هل تريد التحدث مع أحد من فريقنا؟ أجب بـ *نعم* أو *لا*');
      }
      return res.sendStatus(200);
    }

    // ── 3. WAITING FOR TICKET MESSAGE ────────────────────────────────────────
    if (session.waiting_for_ticket_msg) {
      await db.updateSession(phoneNumberId, from, { waiting_for_ticket_msg: false });
      const ticketId = generateTicketId();
      await db.createTicket({ id: ticketId, phone_number_id: phoneNumberId, from_number: from, message: text, status: 'open' });
      await sendMessage(phoneNumberId, client.token, from,
        `✅ *تم تسجيل استفسارك!*\n\n🎫 رقم تذكرتك: *${ticketId}*\n\nسنتواصل معك فور بدء الدوام 🙏`
      );
      await notifyOwner(client, phoneNumberId, prefs, 'ticket',
        `🎫 *تذكرة جديدة — WaslBot*\n🔢 ${ticketId}\n👤 ${from}\n💬 ${text}\n⏰ ${new Date().toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})}`
      );
      await db.incrementStat(phoneNumberId, 'tickets_created');
      return res.sendStatus(200);
    }

    // ── 4. STATUS: CLOSED / HOLIDAY ──────────────────────────────────────────
    if (client.status === 'closed') {
      await db.updateSession(phoneNumberId, from, { waiting_for_ticket_msg: true });
      await sendMessage(phoneNumberId, client.token, from,
        (client.closed_msg || 'نحن مغلقون حالياً ⏰') + '\n\nاكتب استفسارك وسنرد عليك فور فتح الدوام:'
      );
      return res.sendStatus(200);
    }
    if (client.status === 'holiday') {
      await db.updateSession(phoneNumberId, from, { waiting_for_ticket_msg: true });
      await sendMessage(phoneNumberId, client.token, from,
        (client.holiday_msg || 'نحن في إجازة 🏖') + '\n\nاكتب استفسارك وسنرد عليك بعد عودتنا:'
      );
      return res.sendStatus(200);
    }

    // ── 5. OUTSIDE BUSINESS HOURS ────────────────────────────────────────────
    if (client.business_hours && !isWithinBusinessHours(client.business_hours)) {
      await db.updateSession(phoneNumberId, from, { waiting_for_ticket_msg: true });
      await sendMessage(phoneNumberId, client.token, from,
        `🕐 نحن خارج أوقات العمل حالياً.\nأوقات الدوام: ${client.business_hours.label || ''}\n\nاكتب استفسارك وسنرد فور بدء الدوام:`
      );
      await notifyOwner(client, phoneNumberId, prefs, 'outside_hours',
        `🕐 *رسالة خارج الدوام — WaslBot*\n👤 ${from}\n💬 ${text}`
      );
      return res.sendStatus(200);
    }

    // ── 6. FAQ MATCHING ───────────────────────────────────────────────────────
    const faqs = await db.getFaqs(phoneNumberId);
    let replied = false;
    for (const faq of faqs) {
      const keywords = (faq.keywords || '').toLowerCase().split(',').map(k => k.trim());
      if (keywords.some(k => k && textLower.includes(k))) {
        const history = session.history || [];
        const newHistory = [...history, { role:'user', content:text }, { role:'assistant', content:faq.answer }].slice(-6);
        await db.updateSession(phoneNumberId, from, { history: newHistory });
        await sendMessage(phoneNumberId, client.token, from, faq.answer);
        await db.incrementStat(phoneNumberId, 'faq_replies');
        replied = true;
        break;
      }
    }

    // ── 7. CLAUDE AI ──────────────────────────────────────────────────────────
    if (!replied && client.ai_enabled && process.env.ANTHROPIC_API_KEY) {
      try {
        const history  = session.history || [];
        const rawReply = await getClaudeReply(text, client.business_context, faqs, history);
        if (rawReply) {
          const suggestTransfer = rawReply.includes('[SUGGEST_TRANSFER]');
          const cleanReply      = rawReply.replace('[SUGGEST_TRANSFER]', '').trim();
          const newHistory      = [...history, { role:'user', content:text }, { role:'assistant', content:cleanReply }].slice(-6);
          await db.updateSession(phoneNumberId, from, { history: newHistory, waiting_for_transfer: suggestTransfer });
          if (suggestTransfer) {
            await sendMessage(phoneNumberId, client.token, from,
              cleanReply + '\n\n---\n💬 هل تود التحدث مع أحد من فريقنا مباشرة؟ أجب بـ *نعم* أو *لا*'
            );
          } else {
            await sendMessage(phoneNumberId, client.token, from, cleanReply);
          }
          await db.incrementStat(phoneNumberId, 'ai_replies');
          replied = true;
        }
      } catch (e) { console.error('Claude error:', e.message); }
    }

    // ── 8. DEFAULT ────────────────────────────────────────────────────────────
    if (!replied) {
      await sendMessage(phoneNumberId, client.token, from, client.default_msg || 'شكراً لتواصلك! سنرد عليك قريباً 😊');
    }

    await db.incrementStat(phoneNumberId, 'messages_received');
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// ══════════════════════════════════════════════════════
// API: REGISTER / UPDATE PHONE NUMBER
// ══════════════════════════════════════════════════════
app.post('/api/register', async (req, res) => {
  try {
    const { phoneNumberId, token, waba_id, defaultMsg, aiEnabled, businessContext, businessHours, notifyPhone, notifyEmail, sector, label, accountId } = req.body;
    if (!phoneNumberId || !token) return res.status(400).json({ error: 'Missing fields' });

    const existing = await db.getPhone(phoneNumberId);
    if (existing) {
      await db.updatePhone(phoneNumberId, {
        token,
        ...(waba_id !== undefined && { waba_id }),
        ...(defaultMsg !== undefined && { default_msg: defaultMsg }),
        ...(aiEnabled !== undefined && { ai_enabled: aiEnabled }),
        ...(businessContext !== undefined && { business_context: businessContext }),
        ...(businessHours !== undefined && { business_hours: businessHours }),
        ...(notifyPhone !== undefined && { notify_phone: notifyPhone }),
        ...(notifyEmail !== undefined && { notify_email: notifyEmail }),
        ...(sector !== undefined && { sector }),
        ...(label !== undefined && { label }),
        updated_at: new Date().toISOString()
      });
    } else {
      await db.upsertPhone({
        phone_number_id: phoneNumberId, token,
        waba_id: waba_id || '',
        account_id: accountId || null,
        label: label || '',
        default_msg: defaultMsg || 'شكراً لتواصلك! سنرد عليك قريباً 😊',
        ai_enabled: aiEnabled || false,
        business_context: businessContext || '',
        business_hours: businessHours || null,
        notify_phone: notifyPhone || '',
        notify_email: notifyEmail || '',
        sector: sector || '',
        status: 'open',
        is_active: true
      });
    }
    console.log('Registered:', phoneNumberId);
    res.json({ success: true, message: 'Client registered!' });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════
// API: FAQ MANAGEMENT
// ══════════════════════════════════════════════════════
app.post('/api/faqs', async (req, res) => {
  try {
    const { phoneNumberId, faqs } = req.body;
    const client = await db.getPhone(phoneNumberId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    await db.replaceFaqs(phoneNumberId, faqs);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/faqs/:phoneNumberId', async (req, res) => {
  try {
    const faqs = await db.getFaqs(req.params.phoneNumberId);
    res.json({ faqs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// API: STATUS MANAGEMENT
// ══════════════════════════════════════════════════════
app.post('/api/status', async (req, res) => {
  try {
    const { phoneNumberId, status, closedMsg, holidayMsg } = req.body;
    const client = await db.getPhone(phoneNumberId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    await db.updatePhone(phoneNumberId, {
      status,
      ...(closedMsg && { closed_msg: closedMsg }),
      ...(holidayMsg && { holiday_msg: holidayMsg })
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// API: CLIENT INFO
// ══════════════════════════════════════════════════════
app.get('/api/client/:phoneNumberId', async (req, res) => {
  try {
    const client = await db.getPhone(req.params.phoneNumberId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const { token, ...safeClient } = client;
    res.json(safeClient);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// API: TICKETS
// ══════════════════════════════════════════════════════
app.get('/api/tickets/:phoneNumberId', async (req, res) => {
  try {
    const tickets = await db.getTickets(req.params.phoneNumberId);
    res.json({ tickets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tickets/:ticketId/close', async (req, res) => {
  try {
    await db.closeTicket(req.params.ticketId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// API: RELEASE HUMAN SESSION
// ══════════════════════════════════════════════════════

// تحرير عميل واحد
app.post('/api/release/:phoneNumberId/:from', async (req, res) => {
  try {
    await db.updateSession(req.params.phoneNumberId, req.params.from, { transferred_to_human: false, waiting_for_transfer: false });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// جلب كل العملاء المحولين لبشري
app.get('/api/human-sessions/:phoneNumberId', async (req, res) => {
  try {
    const r = await supabase('sessions', 'GET', null,
      `?phone_number_id=eq.${req.params.phoneNumberId}&transferred_to_human=eq.true&order=updated_at.desc`
    );
    res.json({ sessions: Array.isArray(r) ? r : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// تحرير كل العملاء المحولين دفعة واحدة
app.post('/api/release-all/:phoneNumberId', async (req, res) => {
  try {
    await supabase('sessions', 'PATCH',
      { transferred_to_human: false, waiting_for_transfer: false, updated_at: new Date().toISOString() },
      `?phone_number_id=eq.${req.params.phoneNumberId}&transferred_to_human=eq.true`
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// API: STATS
// ══════════════════════════════════════════════════════
app.get('/api/stats/:phoneNumberId', async (req, res) => {
  try {
    const days = req.query.days || 7;
    const after = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const r = await supabase('stats', 'GET', null, `?phone_number_id=eq.${req.params.phoneNumberId}&date=gte.${after}&order=date.desc`);
    res.json({ stats: Array.isArray(r) ? r : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// API: NOTIFICATION PREFS
// ══════════════════════════════════════════════════════
app.post('/api/notif-prefs', async (req, res) => {
  try {
    const { phoneNumberId, ...prefs } = req.body;
    prefs.phone_number_id = phoneNumberId;
    prefs.updated_at = new Date().toISOString();
    await supabase('notification_prefs', 'POST', prefs, '?on_conflict=phone_number_id');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notif-prefs/:phoneNumberId', async (req, res) => {
  try {
    const prefs = await db.getNotifPrefs(req.params.phoneNumberId);
    res.json(prefs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════
app.get('/', async (req, res) => {
  res.json({
    status: 'WaslBot Backend Running!',
    supabase: !!SUPABASE_URL,
    ai: !!process.env.ANTHROPIC_API_KEY,
    version: '2.0.0'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WaslBot v2 running on port ${PORT}`));
