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
    const text = message.text?.body?.toLowerCase() || '';
    console.log('Message from ' + from + ': ' + text);
    const client = clients[phoneNumberId];
    if (!client) return res.sendStatus(200);
    if (client.status === 'closed') {
      await sendMessage(phoneNumberId, client.token, from, client.closedMsg || "We're currently closed. We'll reply soon!");
      return res.sendStatus(200);
    }
    if (client.status === 'holiday') {
      await sendMessage(phoneNumberId, client.token, from, client.holidayMsg || "We're on holiday. We'll be back soon!");
      return res.sendStatus(200);
    }
    const faqs = client.faqs || [];
    let replied = false;
    for (const faq of faqs) {
      const keywords = (faq.keywords || '').toLowerCase().split(',').map(k => k.trim());
      const matched = keywords.some(k => k && text.includes(k));
      if (matched) {
        await sendMessage(phoneNumberId, client.token, from, faq.answer);
        replied = true;
        break;
      }
    }
    if (!replied) {
      await sendMessage(phoneNumberId, client.token, from, client.defaultMsg || "Thanks for your message! We'll get back to you soon.");
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
  console.log('Sent:', data);
  return data;
}

// Client Registration API
app.post('/api/register', (req, res) => {
  const { phoneNumberId, token, waba_id } = req.body;
  if (!phoneNumberId || !token) return res.status(400).json({ error: 'Missing fields' });
  clients[phoneNumberId] = { token, waba_id, faqs: [], status: 'open', defaultMsg: "Thanks for your message! We'll get back to you soon." };
  console.log('Client registered:', phoneNumberId);
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

// Health Check
app.get('/', (req, res) => {
  res.json({ status: 'WaslBot Backend Running!', clients: Object.keys(clients).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('WaslBot Backend running on port ' + PORT));
