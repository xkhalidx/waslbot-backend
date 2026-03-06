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

// In-memory storage
const clients = {};

// Webhook Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Claude AI Reply
async function getClaudeReply(userMessage, businessContext, faqs) {
  const faqText = faqs && faqs.length > 0
    ? faqs.map(f => `• ${f.keywords}: ${f.answer}`).join('\n')
    : 'لا توجد أسئلة مبرمجة';

  const systemPrompt = `أنت مساعد ذكي لخدمة عملاء هذه الشركة. مهمتك الرد على العملاء بشكل مهني ودقيق.

═══════════════════════════════
معلومات الشركة:
═══════════════════════════════
${businessContext || 'لم يتم تحديد معلومات الشركة بعد'}

═══════════════════════════════
الأسئلة الشائعة المبرمجة:
═══════════════════════════════
${faqText}

═══════════════════════════════
قواعد الرد:
═══════════════════════════════
1. رد بنفس لغة العميل (عربي أو إنجليزي)
2. كن مختصراً ومفيداً — لا تطول بدون فائدة
3. إذا سأل عن سعر أو منتج موجود في المعلومات، أجب بدقة
4. إذا السؤال خارج نطاق معلوماتك، قل: "سأحول سؤالك للمختص المسؤول"
5. لا تخترع معلومات غير موجودة في السياق أعلاه
6. إذا سأل عن الطلب أو الشراء، وجّهه للطريقة المذكورة في معلومات الشركة`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  const data = await response.json();
  return data.content?.[0]?.text || null;
}

// Receive Messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);
    const from = message.from;
    const phoneNumberId = value.metadata.phone_number_id;
    const text = message.text?.body || '';
    console.log('Message from ' + from + ': ' + text);
    const client = clients[phoneNumberId];
    if (!client) return res.sendStatus(200);

    // Check business status
    if (client.status === 'closed') {
      await sendMessage(phoneNumberId, client.token, from, client.closedMsg || "نحن مغلقون حالياً. سنرد عليك قريباً ⏰");
      return res.sendStatus(200);
    }
    if (client.status === 'holiday') {
      await sendMessage(phoneNumberId, client.token, from, client.holidayMsg || "نحن في إجازة. سنعود قريباً 🏖");
      return res.sendStatus(200);
    }

    const faqs = client.faqs || [];
    const textLower = text.toLowerCase();

    // Check FAQs first
    let replied = false;
    for (const faq of faqs) {
      const keywords = (faq.keywords || '').toLowerCase().split(',').map(k => k.trim());
      const matched = keywords.some(k => k && textLower.includes(k));
      if (matched) {
        await sendMessage(phoneNumberId, client.token, from, faq.answer);
        replied = true;
        break;
      }
    }

    // If no FAQ match - use Claude AI if enabled
    if (!replied) {
      if (client.aiEnabled && process.env.ANTHROPIC_API_KEY) {
        try {
          const aiReply = await getClaudeReply(text, client.businessContext, faqs);
          if (aiReply) {
            await sendMessage(phoneNumberId, client.token, from, aiReply);
            replied = true;
          }
        } catch(e) {
          console.error('Claude error:', e.message);
        }
      }
      if (!replied) {
        await sendMessage(phoneNumberId, client.token, from, client.defaultMsg || "شكراً لتواصلك! سنرد عليك قريباً 😊");
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// Send Message Helper
async function sendMessage(phoneNumberId, token, to, text) {
  const url = 'https://graph.facebook.com/v22.0/' + phoneNumberId + '/messages';
  const body = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  console.log('Sent:', JSON.stringify(data));
  return data;
}

// Client Registration API
app.post('/api/register', (req, res) => {
  const { phoneNumberId, token, waba_id, defaultMsg, aiEnabled, businessContext } = req.body;
  if (!phoneNumberId || !token) return res.status(400).json({ error: 'Missing fields' });
  if (clients[phoneNumberId]) {
    clients[phoneNumberId].token = token;
    if (waba_id) clients[phoneNumberId].waba_id = waba_id;
    if (defaultMsg) clients[phoneNumberId].defaultMsg = defaultMsg;
    if (aiEnabled !== undefined) clients[phoneNumberId].aiEnabled = aiEnabled;
    if (businessContext !== undefined) clients[phoneNumberId].businessContext = businessContext;
  } else {
    clients[phoneNumberId] = {
      token, waba_id, faqs: [], status: 'open',
      defaultMsg: defaultMsg || "شكراً لتواصلك! سنرد عليك قريباً 😊",
      aiEnabled: aiEnabled || false,
      businessContext: businessContext || ''
    };
  }
  console.log('Client registered:', phoneNumberId, '| AI:', clients[phoneNumberId].aiEnabled);
  res.json({ success: true, message: 'Client registered!' });
});

// FAQ Management
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

// Status Management
app.post('/api/status', (req, res) => {
  const { phoneNumberId, status, closedMsg, holidayMsg } = req.body;
  if (!clients[phoneNumberId]) return res.status(404).json({ error: 'Client not found' });
  clients[phoneNumberId].status = status;
  if (closedMsg) clients[phoneNumberId].closedMsg = closedMsg;
  if (holidayMsg) clients[phoneNumberId].holidayMsg = holidayMsg;
  res.json({ success: true });
});

// Client Info API
app.get('/api/client/:phoneNumberId', (req, res) => {
  const client = clients[req.params.phoneNumberId];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { token, ...safeClient } = client;
  res.json(safeClient);
});

// Health Check
app.get('/', (req, res) => {
  res.json({ status: 'WaslBot Backend Running!', clients: Object.keys(clients).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('WaslBot Backend running on port ' + PORT));
