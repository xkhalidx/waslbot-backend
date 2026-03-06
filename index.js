const express = require('express');
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ══════════════════════════════════════════════════════
// IN-MEMORY STORAGE
// ══════════════════════════════════════════════════════
const clients  = {};   // phoneNumberId → client config
const tickets  = {};   // ticketId → ticket data
const sessions = {};   // "phoneNumberId:from" → session state
let ticketCounter = 1000;

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════

function isWithinBusinessHours(hoursConfig) {
  if (!hoursConfig) return true;
  try {
    const now = new Date();
    const { timezone = 'Asia/Riyadh', start = 9, end = 22, offDays = [] } = hoursConfig;
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', hour12: false, weekday: 'long'
    });
    const parts   = formatter.formatToParts(now);
    const hour    = parseInt(parts.find(p => p.type === 'hour').value);
    const weekday = parts.find(p => p.type === 'weekday').value;
    if (offDays.includes(weekday)) return false;
    return hour >= start && hour < end;
  } catch (e) { return true; }
}

function generateTicketId() {
  ticketCounter++;
  return 'TKT-' + ticketCounter;
}

function getSession(from, phoneNumberId) {
  const key = phoneNumberId + ':' + from;
  if (!sessions[key]) {
    sessions[key] = {
      history: [],
      waitingForTransfer: false,
      transferredToHuman: false,
      waitingForTicketMsg: false
    };
  }
  return sessions[key];
}

function addToHistory(session, role, content) {
  session.history.push({ role, content });
  if (session.history.length > 6) session.history.shift();
}

// ══════════════════════════════════════════════════════
// SEND WHATSAPP MESSAGE
// ══════════════════════════════════════════════════════
async function sendMessage(phoneNumberId, token, to, text) {
  const url  = 'https://graph.facebook.com/v22.0/' + phoneNumberId + '/messages';
  const body = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
  const res  = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  console.log('Sent to', to, ':', JSON.stringify(data));
  return data;
}

// ══════════════════════════════════════════════════════
// EMAIL NOTIFICATION
// ══════════════════════════════════════════════════════
async function sendEmailNotification(client, subject, bodyText) {
  if (!client.notifyEmail) return;
  const emailApiUrl = process.env.EMAIL_API_URL;
  const emailApiKey = process.env.EMAIL_API_KEY;
  if (!emailApiUrl || !emailApiKey) {
    console.log('Email not configured — skipping');
    return;
  }
  try {
    await fetch(emailApiUrl, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + emailApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'WaslBot <noreply@waslbot.com>',
        to: [client.notifyEmail],
        subject,
        text: bodyText
      })
    });
    console.log('Email sent to:', client.notifyEmail);
  } catch (e) { console.error('Email error:', e.message); }
}

// ══════════════════════════════════════════════════════
// NOTIFY OWNER (WhatsApp + Email)
// ══════════════════════════════════════════════════════
async function notifyOwner(client, phoneNumberId, subject, message) {
  if (client.notifyPhone) {
    try {
      await sendMessage(phoneNumberId, client.token, client.notifyPhone, message);
    } catch (e) { console.error('Owner WA notify error:', e.message); }
  }
  await sendEmailNotification(client, subject, message);
}

// ══════════════════════════════════════════════════════
// CLAUDE AI — SMART REPLY + HANDOFF DETECTION
// ══════════════════════════════════════════════════════
async function getClaudeReply(userMessage, businessContext, faqs, history) {
  const faqText = faqs && faqs.length > 0
    ? faqs.map(f => `• ${f.keywords}: ${f.answer}`).join('\n')
    : 'لا توجد أسئلة مبرمجة';

  const systemPrompt = `أنت مساعد ذكي لخدمة عملاء هذه الشركة. مهمتك الرد على العملاء بشكل مهني ودقيق.

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
1. رد بنفس لغة العميل (عربي أو إنجليزي)
2. كن مختصراً ومفيداً — لا تطول بلا فائدة
3. أجب من المعلومات المتاحة فقط — لا تخترع
4. إذا شعرت أن العميل جاد ويحتاج مساعدة متخصصة لا تستطيع تقديمها، أضف في نهاية ردك هذا النص بالضبط: [SUGGEST_TRANSFER]
5. لا تضف [SUGGEST_TRANSFER] في كل رد — فقط عند الحاجة الفعلية`;

  const messages = [...history, { role: 'user', content: userMessage }];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages
    })
  });

  const data = await response.json();
  return data.content?.[0]?.text || null;
}

// ══════════════════════════════════════════════════════
// WEBHOOK VERIFICATION
// ══════════════════════════════════════════════════════
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ══════════════════════════════════════════════════════
// RECEIVE MESSAGES — MAIN LOGIC
// ══════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

    const entry         = body.entry?.[0];
    const change        = entry?.changes?.[0];
    const value         = change?.value;
    const message       = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from          = message.from;
    const phoneNumberId = value.metadata.phone_number_id;
    const text          = message.text?.body?.trim() || '';
    const textLower     = text.toLowerCase();

    console.log(`[${phoneNumberId}] From ${from}: ${text}`);

    const client = clients[phoneNumberId];
    if (!client) return res.sendStatus(200);

    const session = getSession(from, phoneNumberId);

    // ── 1. IN HUMAN MODE — skip bot ─────────────────────────────────────────
    if (session.transferredToHuman) {
      console.log(`[${from}] Human mode — skipping`);
      return res.sendStatus(200);
    }

    // ── 2. WAITING FOR TRANSFER CONFIRMATION ─────────────────────────────────
    if (session.waitingForTransfer) {
      const yes = ['نعم','yes','اي','اه','حسنا','ok','sure','يا','👍'].some(w => textLower.includes(w));
      const no  = ['لا','no','لأ'].some(w => textLower.includes(w));

      if (yes) {
        session.waitingForTransfer = false;
        session.transferredToHuman = true;
        const ownerNum = client.notifyPhone ? client.notifyPhone.replace(/\D/g,'') : null;
        await sendMessage(phoneNumberId, client.token, from,
          `✅ تم تحويلك لفريق خدمة العملاء.\n\nسيتواصل معك أحد المختصين قريباً.` +
          (ownerNum ? `\n\nأو تواصل مباشرة: wa.me/${ownerNum}` : '')
        );
        await notifyOwner(client, phoneNumberId, 'طلب تحويل جديد',
          `🔔 *طلب تحويل — WaslBot*\n👤 العميل: ${from}\n💬 آخر رسالة: ${text}\n⏰ ${new Date().toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})}`
        );
      } else if (no) {
        session.waitingForTransfer = false;
        await sendMessage(phoneNumberId, client.token, from, 'حسناً! أنا هنا إذا احتجت شيئاً آخر 😊');
      } else {
        await sendMessage(phoneNumberId, client.token, from, 'هل تريد التحدث مع أحد من فريقنا؟ أجب بـ *نعم* أو *لا*');
      }
      return res.sendStatus(200);
    }

    // ── 3. WAITING FOR TICKET MESSAGE ────────────────────────────────────────
    if (session.waitingForTicketMsg) {
      session.waitingForTicketMsg = false;
      const ticketId = generateTicketId();
      tickets[ticketId] = { id: ticketId, from, phoneNumberId, message: text, createdAt: new Date().toISOString(), status: 'open' };

      await sendMessage(phoneNumberId, client.token, from,
        `✅ *تم تسجيل استفسارك!*\n\n🎫 رقم تذكرتك: *${ticketId}*\n\nسنتواصل معك فور بدء الدوام. احتفظ بهذا الرقم 🙏`
      );
      await notifyOwner(client, phoneNumberId, `تذكرة جديدة ${ticketId}`,
        `🎫 *تذكرة جديدة — WaslBot*\n🔢 ${ticketId}\n👤 العميل: ${from}\n💬 ${text}\n⏰ ${new Date().toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'})}`
      );
      return res.sendStatus(200);
    }

    // ── 4. STATUS: CLOSED / HOLIDAY ──────────────────────────────────────────
    if (client.status === 'closed') {
      session.waitingForTicketMsg = true;
      await sendMessage(phoneNumberId, client.token, from,
        (client.closedMsg || 'نحن مغلقون حالياً ⏰') +
        '\n\nاكتب استفسارك وسنرد عليك فور فتح الدوام:'
      );
      return res.sendStatus(200);
    }

    if (client.status === 'holiday') {
      session.waitingForTicketMsg = true;
      await sendMessage(phoneNumberId, client.token, from,
        (client.holidayMsg || 'نحن في إجازة 🏖') +
        '\n\nاكتب استفسارك وسنرد عليك بعد عودتنا:'
      );
      return res.sendStatus(200);
    }

    // ── 5. OUTSIDE BUSINESS HOURS ────────────────────────────────────────────
    if (client.businessHours && !isWithinBusinessHours(client.businessHours)) {
      session.waitingForTicketMsg = true;
      await sendMessage(phoneNumberId, client.token, from,
        `🕐 نحن خارج أوقات العمل حالياً.\n` +
        `أوقات الدوام: ${client.businessHours.label || ''}\n\n` +
        `اكتب استفسارك وسنرد عليك فور بدء الدوام:`
      );
      return res.sendStatus(200);
    }

    // ── 6. FAQ MATCHING ───────────────────────────────────────────────────────
    const faqs = client.faqs || [];
    let replied = false;

    for (const faq of faqs) {
      const keywords = (faq.keywords || '').toLowerCase().split(',').map(k => k.trim());
      if (keywords.some(k => k && textLower.includes(k))) {
        addToHistory(session, 'user', text);
        addToHistory(session, 'assistant', faq.answer);
        await sendMessage(phoneNumberId, client.token, from, faq.answer);
        replied = true;
        break;
      }
    }

    // ── 7. CLAUDE AI ──────────────────────────────────────────────────────────
    if (!replied && client.aiEnabled && process.env.ANTHROPIC_API_KEY) {
      try {
        const rawReply = await getClaudeReply(text, client.businessContext, faqs, session.history);
        if (rawReply) {
          const suggestTransfer = rawReply.includes('[SUGGEST_TRANSFER]');
          const cleanReply      = rawReply.replace('[SUGGEST_TRANSFER]', '').trim();

          addToHistory(session, 'user', text);
          addToHistory(session, 'assistant', cleanReply);

          if (suggestTransfer) {
            session.waitingForTransfer = true;
            await sendMessage(phoneNumberId, client.token, from,
              cleanReply + '\n\n---\n💬 هل تود التحدث مع أحد من فريقنا مباشرة؟ أجب بـ *نعم* أو *لا*'
            );
          } else {
            await sendMessage(phoneNumberId, client.token, from, cleanReply);
          }
          replied = true;
        }
      } catch (e) { console.error('Claude error:', e.message); }
    }

    // ── 8. DEFAULT FALLBACK ───────────────────────────────────────────────────
    if (!replied) {
      await sendMessage(phoneNumberId, client.token, from,
        client.defaultMsg || 'شكراً لتواصلك! سنرد عليك قريباً 😊'
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// ══════════════════════════════════════════════════════
// CLIENT REGISTRATION
// ══════════════════════════════════════════════════════
app.post('/api/register', (req, res) => {
  const { phoneNumberId, token, waba_id, defaultMsg, aiEnabled, businessContext, businessHours, notifyPhone, notifyEmail } = req.body;
  if (!phoneNumberId || !token) return res.status(400).json({ error: 'Missing fields' });

  if (clients[phoneNumberId]) {
    const c = clients[phoneNumberId];
    c.token = token;
    if (waba_id !== undefined)          c.waba_id          = waba_id;
    if (defaultMsg !== undefined)       c.defaultMsg        = defaultMsg;
    if (aiEnabled !== undefined)        c.aiEnabled         = aiEnabled;
    if (businessContext !== undefined)  c.businessContext   = businessContext;
    if (businessHours !== undefined)    c.businessHours     = businessHours;
    if (notifyPhone !== undefined)      c.notifyPhone       = notifyPhone;
    if (notifyEmail !== undefined)      c.notifyEmail       = notifyEmail;
  } else {
    clients[phoneNumberId] = {
      token, waba_id, faqs: [], status: 'open',
      defaultMsg: defaultMsg || 'شكراً لتواصلك! سنرد عليك قريباً 😊',
      aiEnabled: aiEnabled || false,
      businessContext: businessContext || '',
      businessHours: businessHours || null,
      notifyPhone: notifyPhone || '',
      notifyEmail: notifyEmail || ''
    };
  }
  console.log('Registered:', phoneNumberId, '| AI:', clients[phoneNumberId].aiEnabled);
  res.json({ success: true, message: 'Client registered!' });
});

// ══════════════════════════════════════════════════════
// FAQ MANAGEMENT
// ══════════════════════════════════════════════════════
app.post('/api/faqs', (req, res) => {
  const { phoneNumberId, faqs } = req.body;
  if (!clients[phoneNumberId]) return res.status(404).json({ error: 'Client not found' });
  clients[phoneNumberId].faqs = faqs;
  res.json({ success: true });
});

app.get('/api/faqs/:phoneNumberId', (req, res) => {
  const client = clients[req.params.phoneNumberId];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json({ faqs: client.faqs });
});

// ══════════════════════════════════════════════════════
// STATUS MANAGEMENT
// ══════════════════════════════════════════════════════
app.post('/api/status', (req, res) => {
  const { phoneNumberId, status, closedMsg, holidayMsg } = req.body;
  if (!clients[phoneNumberId]) return res.status(404).json({ error: 'Client not found' });
  clients[phoneNumberId].status = status;
  if (closedMsg)  clients[phoneNumberId].closedMsg  = closedMsg;
  if (holidayMsg) clients[phoneNumberId].holidayMsg = holidayMsg;
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════
// CLIENT INFO
// ══════════════════════════════════════════════════════
app.get('/api/client/:phoneNumberId', (req, res) => {
  const client = clients[req.params.phoneNumberId];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { token, ...safeClient } = client;
  res.json(safeClient);
});

// ══════════════════════════════════════════════════════
// TICKETS
// ══════════════════════════════════════════════════════
app.get('/api/tickets/:phoneNumberId', (req, res) => {
  const result = Object.values(tickets)
    .filter(t => t.phoneNumberId === req.params.phoneNumberId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ tickets: result });
});

app.post('/api/tickets/:ticketId/close', (req, res) => {
  const ticket = tickets[req.params.ticketId];
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  ticket.status = 'closed';
  ticket.closedAt = new Date().toISOString();
  res.json({ success: true });
});

// Re-enable bot after human session
app.post('/api/release/:phoneNumberId/:from', (req, res) => {
  const key = req.params.phoneNumberId + ':' + req.params.from;
  if (sessions[key]) {
    sessions[key].transferredToHuman = false;
    sessions[key].waitingForTransfer = false;
  }
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'WaslBot Backend Running!',
    clients: Object.keys(clients).length,
    tickets: Object.keys(tickets).length,
    aiConfigured: !!process.env.ANTHROPIC_API_KEY
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('WaslBot Backend running on port ' + PORT));
