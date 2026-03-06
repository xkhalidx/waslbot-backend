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
  async getAccountById(id) {
    const r = await supabase('accounts', 'GET', null, `?id=eq.${id}&limit=1`);
    return Array.isArray(r) ? r[0] : null;
  },
  async createAccount(data) {
    return supabase('accounts', 'POST', data);
  },
  async getAccountPhones(accountId) {
    const r = await supabase('phone_numbers', 'GET', null, `?account_id=eq.${accountId}&is_active=eq.true`);
    return Array.isArray(r) ? r : [];
  },

  // ── PLAN & MESSAGE LIMITS ──────────────────────────
  async checkMessageLimit(accountId) {
    const account = await db.getAccountById(accountId);
    if (!account) return { allowed: false, reason: 'account_not_found' };

    // Admin = unlimited
    if (account.is_admin) return { allowed: true };

    // Check plan expiry
    if (account.plan_expires_at && new Date(account.plan_expires_at) < new Date()) {
      return { allowed: false, reason: 'plan_expired' };
    }

    const used  = account.messages_used || 0;
    const limit = account.messages_limit || PLAN_LIMITS_MSG[account.plan] || 1000;
    const extra = account.extra_messages || 0;
    const total = limit + extra;

    if (used >= total) return { allowed: false, reason: 'limit_reached', used, total };
    return { allowed: true, used, total, remaining: total - used };
  },

  async incrementMessageCount(accountId) {
    const account = await db.getAccountById(accountId);
    if (!account || account.is_admin) return;
    const newCount = (account.messages_used || 0) + 1;
    await supabase('accounts', 'PATCH',
      { messages_used: newCount, updated_at: new Date().toISOString() },
      `?id=eq.${accountId}`
    );
    // Track monthly usage
    const month = new Date().toISOString().slice(0, 7) + '-01';
    const phoneId = ''; // will be updated per call
    try {
      const existing = await supabase('message_usage', 'GET', null,
        `?account_id=eq.${accountId}&month=eq.${month}&limit=1`
      );
      if (Array.isArray(existing) && existing[0]) {
        await supabase('message_usage', 'PATCH',
          { messages_count: existing[0].messages_count + 1 },
          `?account_id=eq.${accountId}&month=eq.${month}`
        );
      } else {
        await supabase('message_usage', 'POST',
          { account_id: accountId, phone_number_id: phoneId, month, messages_count: 1 }
        );
      }
    } catch(_) {}
  },

  async resetMonthlyIfNeeded(accountId) {
    const account = await db.getAccountById(accountId);
    if (!account) return;
    const resetDate = account.billing_reset_date ? new Date(account.billing_reset_date) : new Date();
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    if (resetDate < currentMonthStart) {
      await supabase('accounts', 'PATCH',
        { messages_used: 0, billing_reset_date: currentMonthStart.toISOString().split('T')[0], updated_at: now.toISOString() },
        `?id=eq.${accountId}`
      );
    }
  }
};

// ── PLAN LIMITS CONFIG ────────────────────────────────
const PLAN_LIMITS_MSG = { basic: 1000, pro: 5000, enterprise: 20000 };
const PLAN_PRICE = { basic: 99, pro: 249, enterprise: 599 };

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

    // ── CHECK MESSAGE LIMIT ───────────────────────────────────────────────────
    if (client.account_id) {
      await db.resetMonthlyIfNeeded(client.account_id);
      const limitCheck = await db.checkMessageLimit(client.account_id);
      if (!limitCheck.allowed) {
        if (limitCheck.reason === 'limit_reached') {
          await sendMessage(phoneNumberId, client.token, from,
            `⚠️ *تنبيه — WaslBot*

عذراً، لقد استنفدت حد رسائلك الشهري (${limitCheck.total} رسالة).

للاستمرار في الخدمة يرجى الترقية إلى باقة أعلى.
🔗 waslbot.net`
          );
        } else if (limitCheck.reason === 'plan_expired') {
          await sendMessage(phoneNumberId, client.token, from,
            `⚠️ *تنبيه — WaslBot*

انتهت صلاحية اشتراكك.
يرجى تجديد الاشتراك للاستمرار.
🔗 waslbot.net`
          );
        }
        await db.incrementStat(phoneNumberId, 'messages_received');
        return res.sendStatus(200);
      }
      // Count this message
      await db.incrementMessageCount(client.account_id);
      // Warn at 80% usage
      if (limitCheck.remaining <= Math.floor(limitCheck.total * 0.2) && limitCheck.remaining > 0) {
        console.log(`[LIMIT WARNING] Account ${client.account_id}: ${limitCheck.remaining} messages remaining`);
      }
    }

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
// AUTH SYSTEM
// ══════════════════════════════════════════════════════

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = process.env.HASH_SALT || 'waslbot_salt_2025';
  const data = encoder.encode(password + salt);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function createToken(payload) {
  const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const body   = Buffer.from(JSON.stringify({...payload, exp: Date.now() + 30*24*60*60*1000})).toString('base64url');
  const secret = process.env.JWT_SECRET || 'waslbot_jwt_secret_2025';
  const sig    = require('crypto').createHmac('sha256', secret).update(header+'.'+body).digest('base64url');
  return header+'.'+body+'.'+sig;
}

function verifyToken(token) {
  try {
    const [header, body, sig] = token.split('.');
    const secret = process.env.JWT_SECRET || 'waslbot_jwt_secret_2025';
    const expected = require('crypto').createHmac('sha256', secret).update(header+'.'+body).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body,'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ','');
  if (!token) return res.status(401).json({error:'Unauthorized'});
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({error:'Invalid or expired token'});
  req.account = payload;
  next();
}

function adminMiddleware(req, res, next) {
  if (!req.account?.is_admin) return res.status(403).json({error:'Admin only'});
  next();
}

// ── OTP HELPERS ─────────────────────────────────────
// Store OTPs in memory (expires in 10 min)
const otpStore = new Map(); // key: email|phone → {otp, exp, data}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendEmailOTP(email, otp, purpose = 'تفعيل الحساب') {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'WaslBot <noreply@waslbot.net>',
      to: [email],
      subject: `رمز التحقق — WaslBot`,
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#f9fafb;border-radius:12px">
          <h2 style="color:#00d4aa;margin-bottom:8px">WaslBot 💬</h2>
          <p style="color:#374151;font-size:16px;margin-bottom:24px">${purpose}</p>
          <div style="background:#fff;border:2px solid #00d4aa;border-radius:12px;padding:24px;text-align:center">
            <p style="color:#6b7280;font-size:14px;margin-bottom:8px">رمز التحقق الخاص بك</p>
            <h1 style="color:#111827;font-size:42px;letter-spacing:10px;margin:0">${otp}</h1>
            <p style="color:#9ca3af;font-size:13px;margin-top:12px">صالح لمدة 10 دقائق فقط</p>
          </div>
          <p style="color:#9ca3af;font-size:12px;margin-top:24px;text-align:center">إذا لم تطلب هذا الرمز، تجاهل هذا الإيميل</p>
        </div>`
    })
  });
  const data = await res.json();
  console.log('Email OTP sent:', data.id || JSON.stringify(data));
  return data;
}

// ── REGISTER (Step 1: send OTP)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, full_name } = req.body;
    if (!email || !password) return res.status(400).json({error:'البريد الإلكتروني وكلمة المرور مطلوبان'});
    if (password.length < 6) return res.status(400).json({error:'كلمة المرور يجب أن تكون 6 أحرف على الأقل'});
    const existing = await db.getAccount(email);
    if (existing && existing.email_verified) return res.status(409).json({error:'البريد الإلكتروني مسجل مسبقاً'});

    const otp = generateOTP();
    const password_hash = await hashPassword(password);
    otpStore.set('reg:' + email, {
      otp, exp: Date.now() + 10 * 60 * 1000,
      data: { email, password_hash, full_name: full_name || '' }
    });

    await sendEmailOTP(email, otp, 'أدخل الرمز التالي لتفعيل حسابك في WaslBot');
    res.json({ success: true, message: 'تم إرسال رمز التحقق لبريدك الإلكتروني', step: 'verify_email' });
  } catch(e) { console.error('Register error:', e); res.status(500).json({error: e.message}); }
});

// ── REGISTER (Step 2: verify OTP)
app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({error:'البريد والرمز مطلوبان'});

    const stored = otpStore.get('reg:' + email);
    if (!stored) return res.status(400).json({error:'انتهت صلاحية الرمز — أعد التسجيل'});
    if (Date.now() > stored.exp) { otpStore.delete('reg:' + email); return res.status(400).json({error:'انتهت صلاحية الرمز'}); }
    if (stored.otp !== otp.trim()) return res.status(400).json({error:'الرمز غير صحيح'});

    otpStore.delete('reg:' + email);
    const { data: regData } = stored;

    // Create account
    const existing = await db.getAccount(email);
    let account;
    if (existing) {
      await supabase('accounts','PATCH',{email_verified:true, password_hash:regData.password_hash, updated_at:new Date().toISOString()},`?id=eq.${existing.id}`);
      account = {...existing, email_verified:true};
    } else {
      const result = await db.createAccount({
        email: regData.email, password_hash: regData.password_hash,
        full_name: regData.full_name, plan:'basic',
        is_active:true, is_admin:false, email_verified:true
      });
      account = Array.isArray(result) ? result[0] : null;
    }
    if (!account) return res.status(500).json({error:'فشل إنشاء الحساب'});

    const token = createToken({id:account.id, email:account.email, plan:account.plan, is_admin:account.is_admin});
    res.json({success:true, token, account:{id:account.id, email:account.email, full_name:account.full_name, plan:account.plan}});
  } catch(e) { console.error('Verify email error:', e); res.status(500).json({error:e.message}); }
});

// ── LOGIN
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({error:'البريد وكلمة المرور مطلوبان'});
    const account = await db.getAccount(email);
    if (!account) return res.status(401).json({error:'البريد أو كلمة المرور غير صحيحة'});
    if (!account.is_active) return res.status(403).json({error:'الحساب موقوف'});
    if (!account.email_verified) return res.status(403).json({error:'البريد الإلكتروني غير مفعّل — يرجى التحقق من بريدك'});
    const password_hash = await hashPassword(password);
    if (password_hash !== account.password_hash) return res.status(401).json({error:'البريد أو كلمة المرور غير صحيحة'});
    const token = createToken({id:account.id, email:account.email, plan:account.plan, is_admin:account.is_admin});
    res.json({success:true, token, account:{id:account.id, email:account.email, full_name:account.full_name, plan:account.plan, is_admin:account.is_admin}});
  } catch(e) { console.error('Login error:',e); res.status(500).json({error:e.message}); }
});

// ── RESEND OTP
app.post('/api/auth/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    const stored = otpStore.get('reg:' + email);
    if (!stored) return res.status(400).json({error:'لا يوجد طلب تسجيل نشط — أعد التسجيل'});
    const otp = generateOTP();
    stored.otp = otp;
    stored.exp = Date.now() + 10 * 60 * 1000;
    otpStore.set('reg:' + email, stored);
    await sendEmailOTP(email, otp, 'رمز تحقق جديد لتفعيل حسابك في WaslBot');
    res.json({success:true, message:'تم إعادة إرسال الرمز'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── VERIFY WHATSAPP NUMBER (send OTP via bot)
app.post('/api/auth/verify-phone', authMiddleware, async (req, res) => {
  try {
    const { phoneNumberId, token, phoneToVerify } = req.body;
    if (!phoneNumberId || !token || !phoneToVerify) return res.status(400).json({error:'بيانات ناقصة'});

    const otp = generateOTP();
    otpStore.set('phone:' + phoneNumberId, {
      otp, exp: Date.now() + 10 * 60 * 1000,
      accountId: req.account.id
    });

    // Send OTP via WhatsApp
    await sendMessage(phoneNumberId, token, phoneToVerify,
      `🔐 *رمز التحقق — WaslBot*

رمزك هو: *${otp}*

صالح لمدة 10 دقائق فقط.
لا تشاركه مع أحد.`
    );
    res.json({success:true, message:'تم إرسال رمز التحقق عبر واتساب'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── CONFIRM WHATSAPP OTP
app.post('/api/auth/confirm-phone', authMiddleware, async (req, res) => {
  try {
    const { phoneNumberId, otp } = req.body;
    const stored = otpStore.get('phone:' + phoneNumberId);
    if (!stored) return res.status(400).json({error:'انتهت صلاحية الرمز'});
    if (Date.now() > stored.exp) { otpStore.delete('phone:' + phoneNumberId); return res.status(400).json({error:'انتهت صلاحية الرمز'}); }
    if (stored.otp !== otp.trim()) return res.status(400).json({error:'الرمز غير صحيح'});
    if (stored.accountId !== req.account.id) return res.status(403).json({error:'غير مصرح'});
    otpStore.delete('phone:' + phoneNumberId);
    // Mark phone as verified
    await supabase('phone_numbers','PATCH',{phone_verified:true},`?phone_number_id=eq.${phoneNumberId}`);
    res.json({success:true, message:'تم التحقق من الرقم بنجاح ✅'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── ME
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const account = await db.getAccount(req.account.email);
    if (!account) return res.status(404).json({error:'Not found'});
    const {password_hash, ...safe} = account;
    const phones = await db.getAccountPhones(account.id);
    res.json({account:safe, phones: phones.map(({token,...p})=>p)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── CHANGE PASSWORD
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const {current_password, new_password} = req.body;
    if (!current_password || !new_password) return res.status(400).json({error:'Both passwords required'});
    if (new_password.length < 6) return res.status(400).json({error:'Min 6 characters'});
    const account = await db.getAccount(req.account.email);
    const currentHash = await hashPassword(current_password);
    if (currentHash !== account.password_hash) return res.status(401).json({error:'Current password incorrect'});
    const new_hash = await hashPassword(new_password);
    await supabase('accounts','PATCH',{password_hash:new_hash, updated_at:new Date().toISOString()},`?id=eq.${account.id}`);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ══════════════════════════════════════════════════════
// MULTI-PHONE PER ACCOUNT
// ══════════════════════════════════════════════════════
const PLAN_LIMITS = {basic:1, pro:3, enterprise:999};

app.get('/api/my-phones', authMiddleware, async (req, res) => {
  try {
    const phones = await db.getAccountPhones(req.account.id);
    res.json({phones: phones.map(({token,...p})=>p)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/my-phones', authMiddleware, async (req, res) => {
  try {
    const account = await db.getAccount(req.account.email);
    const existing = await db.getAccountPhones(account.id);
    const limit = PLAN_LIMITS[account.plan] || 1;
    if (existing.length >= limit)
      return res.status(403).json({error:`باقتك (${account.plan}) تسمح بـ ${limit} رقم فقط — يرجى الترقية`});
    const {phoneNumberId, token, label, waba_id} = req.body;
    if (!phoneNumberId || !token) return res.status(400).json({error:'Phone Number ID and Token required'});
    await db.upsertPhone({
      phone_number_id:phoneNumberId, account_id:account.id,
      token, label:label||'', waba_id:waba_id||'',
      status:'open', ai_enabled:false,
      default_msg:'شكراً لتواصلك! سنرد عليك قريباً 😊', is_active:true
    });
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.delete('/api/my-phones/:phoneNumberId', authMiddleware, async (req, res) => {
  try {
    const phone = await db.getPhone(req.params.phoneNumberId);
    if (!phone) return res.status(404).json({error:'Not found'});
    if (phone.account_id !== req.account.id && !req.account.is_admin)
      return res.status(403).json({error:'Not authorized'});
    await supabase('phone_numbers','PATCH',{is_active:false},`?phone_number_id=eq.${req.params.phoneNumberId}`);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ══════════════════════════════════════════════════════
// SUPER ADMIN
// ══════════════════════════════════════════════════════
app.get('/api/admin/accounts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await supabase('accounts','GET',null,'?order=created_at.desc');
    res.json({accounts:(Array.isArray(r)?r:[]).map(({password_hash,...a})=>a)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/admin/accounts/:id/plan', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const {plan} = req.body;
    if (!['basic','pro','enterprise'].includes(plan)) return res.status(400).json({error:'Invalid plan'});
    await supabase('accounts','PATCH',{plan, updated_at:new Date().toISOString()},`?id=eq.${req.params.id}`);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/admin/accounts/:id/status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const {is_active} = req.body;
    await supabase('accounts','PATCH',{is_active, updated_at:new Date().toISOString()},`?id=eq.${req.params.id}`);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const accounts = await supabase('accounts','GET',null,'?select=id');
    const phones   = await supabase('phone_numbers','GET',null,'?select=id&is_active=eq.true');
    const tickets  = await supabase('tickets','GET',null,'?select=id&status=eq.open');
    res.json({
      total_accounts: Array.isArray(accounts)?accounts.length:0,
      active_phones:  Array.isArray(phones)?phones.length:0,
      open_tickets:   Array.isArray(tickets)?tickets.length:0
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ══════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════
// USAGE & PLAN APIs
// ══════════════════════════════════════════════════════

// استهلاك الرسائل للحساب الحالي
app.get('/api/my-usage', authMiddleware, async (req, res) => {
  try {
    const account = await db.getAccountById(req.account.id);
    if (!account) return res.status(404).json({error:'Not found'});

    await db.resetMonthlyIfNeeded(account.id);
    const limit   = account.messages_limit || PLAN_LIMITS_MSG[account.plan] || 1000;
    const used    = account.messages_used || 0;
    const extra   = account.extra_messages || 0;
    const total   = limit + extra;
    const percent = Math.min(100, Math.round((used / total) * 100));

    res.json({
      plan:         account.plan,
      messages_used:  used,
      messages_limit: limit,
      extra_messages: extra,
      total_allowed:  total,
      remaining:      Math.max(0, total - used),
      percent_used:   percent,
      reset_date:     account.billing_reset_date,
      plan_expires_at: account.plan_expires_at
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// الباقات المتاحة
app.get('/api/plans', async (req, res) => {
  res.json({ plans: [
    { id:'basic',      name:'Basic',      name_ar:'الأساسية',    price:99,  messages:1000,  phones:1, description:'مناسبة للمشاريع الصغيرة' },
    { id:'pro',        name:'Pro',        name_ar:'الاحترافية',  price:249, messages:5000,  phones:3, description:'للمشاريع المتوسطة والنامية' },
    { id:'enterprise', name:'Enterprise', name_ar:'المؤسسية',    price:599, messages:20000, phones:10,description:'للمؤسسات والشركات الكبيرة' }
  ]});
});

// شراء رسائل إضافية
app.post('/api/buy-extra', authMiddleware, async (req, res) => {
  try {
    const { quantity } = req.body; // كل وحدة = 500 رسالة بـ 10 ريال
    if (!quantity || quantity < 1) return res.status(400).json({error:'الكمية غير صحيحة'});
    const account = await db.getAccountById(req.account.id);
    const added   = quantity * 500;
    const amount  = quantity * 10;
    await supabase('accounts','PATCH',
      { extra_messages: (account.extra_messages||0) + added, updated_at: new Date().toISOString() },
      `?id=eq.${account.id}`
    );
    // سجل الفاتورة
    await supabase('invoices','POST',{
      account_id:  account.id,
      amount,
      currency:    'SAR',
      description: `${added} رسالة إضافية`,
      status:      'pending'
    });
    res.json({ success:true, added, amount, message:`تم إضافة ${added} رسالة إضافية بقيمة ${amount} ريال` });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── ADMIN: تغيير حد رسائل حساب معين
app.post('/api/admin/accounts/:id/messages', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { messages_limit, extra_messages } = req.body;
    const update = { updated_at: new Date().toISOString() };
    if (messages_limit !== undefined) update.messages_limit = messages_limit;
    if (extra_messages !== undefined) update.extra_messages = extra_messages;
    await supabase('accounts','PATCH', update, `?id=eq.${req.params.id}`);
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── ADMIN: إعادة تعيين عداد رسائل حساب
app.post('/api/admin/accounts/:id/reset-usage', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await supabase('accounts','PATCH',
      { messages_used: 0, updated_at: new Date().toISOString() },
      `?id=eq.${req.params.id}`
    );
    res.json({success:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ══════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════
app.get('/', async (req, res) => {
  res.json({
    status: 'WaslBot Backend Running!',
    supabase: !!SUPABASE_URL,
    ai: !!process.env.ANTHROPIC_API_KEY,
    version: '3.0.0'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WaslBot v3 running on port ${PORT}`));
